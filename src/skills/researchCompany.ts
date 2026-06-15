import type { Env } from "../index";
import agentConfig from "../../config/agentConfig.json";
import { HARD_CRITERIA_SUMMARY, RESEARCH_GUIDELINES, TONE_DETERMINATION_PROMPT } from "../../config/prompts";

export interface ResearchSignal {
  title: string;
  url: string;
  snippet: string;
}

export interface CommuteResult {
  address: string;
  driveSeconds: number | null;
  transitSeconds: number | null;
  withinLimits: boolean;
}

export interface CompanyResearch {
  company: string;
  summary: string;
  signals: ResearchSignal[];
  sources: string[];
  commute: CommuteResult | null;
  flags: string[];
  fitScore: number;
  rejected: boolean;
  rejectionReason?: string;
  researchedAt: string;
  /** R2 key where the full research payload is stored. */
  r2Key: string;
}

export interface ResearchOptions {
  jobId: string;
  depth?: 'quick' | 'standard' | 'deep';
  facets?: string[];
  manager_name?: string;
  concern?: string;
  address?: string;
  workType?: "remote" | "hybrid" | "onsite";
  jobText?: string;
}

const DEFAULT_SEARCH_API_URL = "https://api.tavily.com/search";
const DEFAULT_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}
interface TavilyResponse {
  results?: TavilyResult[];
  answer?: string;
}

interface ScreenResult {
  flags: string[];
  fitScore: number;
  rejected: boolean;
  rejectionReason?: string;
}

interface EmbeddingResponse {
  data: number[][];
}

interface ChatResponse {
  response: string;
}

// --- gateway helpers ---

async function gatewayGetR2(env: Env, key: string): Promise<string | null> {
  const res = await env.RESUMAESTRO.fetch(`https://worker/data/r2?key=${encodeURIComponent(key)}`);
  if (!res.ok) return null;
  return res.text();
}

async function gatewayPutR2(env: Env, key: string, body: string, contentType: string): Promise<void> {
  await env.RESUMAESTRO.fetch(`https://worker/data/r2?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  });
}

async function gatewayPutKV(env: Env, key: string, value: string): Promise<void> {
  await env.RESUMAESTRO.fetch(`https://worker/data/kv/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: value,
  });
}

async function gatewayVectorUpsert(
  env: Env,
  vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>,
): Promise<void> {
  await env.RESUMAESTRO.fetch('https://worker/data/vector/upsert', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vectors }),
  });
}

async function queryExistingResearch(env: Env, company: string): Promise<string | null> {
  const model = DEFAULT_EMBEDDING_MODEL;
  const run = env.AI.run as unknown as (
    m: string,
    inputs: Record<string, unknown>,
  ) => Promise<EmbeddingResponse>;
  const embedding = await run(model, { text: [company] });
  const vector = embedding?.data?.[0];
  if (!vector || vector.length === 0) return null;

  const result = await env.RESUMAESTRO_COMPANIES.query(vector, {
    topK: 1,
    returnMetadata: true,
  });
  const match = result.matches?.at(0);
  if (!match) return null;

  const meta = match.metadata as Record<string, unknown> | undefined;
  const researchedAt = typeof meta?.researchedAt === 'string' ? meta.researchedAt : null;
  const summary = typeof meta?.summary === 'string' ? meta.summary : null;

  if (
    match.score > 0.92 &&
    researchedAt !== null &&
    summary !== null &&
    (Date.now() - new Date(researchedAt).getTime()) < 30 * 24 * 60 * 60 * 1000
  ) {
    return summary;
  }
  return null;
}

async function determineTone(env: Env, signals: ResearchSignal[], company: string): Promise<'formal' | 'conversational' | 'technical'> {
  const run = env.AI.run as unknown as (
    m: string,
    inputs: Record<string, unknown>,
  ) => Promise<ChatResponse>;
  const model = env.RESUME_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const signalText = signals.slice(0, 6).map((s) => `${s.title}: ${s.snippet}`).join('\n\n');
  const result = await run(model, {
    messages: [
      { role: 'system', content: TONE_DETERMINATION_PROMPT },
      {
        role: 'user',
        content: `Company: ${company}\n\nResearch signals:\n${signalText}`,
      },
    ],
    max_tokens: 64,
    temperature: 0,
  });
  try {
    const raw = (result?.response ?? '').trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(raw) as { tone?: string };
    const tone = parsed.tone;
    if (tone === 'formal' || tone === 'conversational' || tone === 'technical') return tone;
  } catch {
    // fall through
  }
  return 'conversational';
}

/**
 * Orchestrates outbound company intelligence: web search, optional commute check, hard-criteria
 * screen, fit scoring, tone determination, and synthesis. Persists to R2, KV, and Vectorize.
 * Returns the deep_research result shape consumed by index.ts -> postCallback.
 */
export async function researchCompany(
  env: Env,
  company: string,
  options: ResearchOptions,
): Promise<Record<string, unknown>> {
  const name = company?.trim();
  if (!name) throw new Error("researchCompany: 'company' must be a non-empty string.");

  // 1. Check for cached research in Vectorize.
  const cached = await queryExistingResearch(env, name);
  if (cached) {
    // Read experience.yml to synthesize brief from cache
    const experienceYml = await gatewayGetR2(env, 'source/experience.yml');
    const brief = [
      `# ${name} — Research Brief (Cached)`,
      '',
      cached,
      '',
      experienceYml ? `## Candidate Profile\n${experienceYml.slice(0, 2000)}` : '',
    ].join('\n');

    const tone_suggestion = await determineTone(env, [], name);

    return {
      type: 'research',
      summary: cached,
      signals_json: JSON.stringify([]),
      sources_json: JSON.stringify([]),
      brief_key: `research/${options.jobId}/brief.md`,
      tone_suggestion,
    };
  }

  // 2. Outbound web intelligence.
  const signals = await webSearch(env, name, options);

  // 3. Save raw Tavily results to R2.
  const rawKey = `research/${options.jobId}/raw.json`;
  await gatewayPutR2(env, rawKey, JSON.stringify(signals), 'application/json');

  // 4. Optional commute check for hybrid / onsite roles.
  let commute: CommuteResult | null = null;
  if (options.address && (options.workType === "hybrid" || options.workType === "onsite")) {
    commute = await commuteCheck(env, options.address);
  }

  // 5. Hard-criteria screen + fit scoring.
  const screen = screenRole(options.jobText ?? "", options.workType, commute);

  const sources = signals.map((s) => s.url).filter((u) => u.length > 0);

  // 6. Read experience.yml for synthesis.
  const experienceYml = await gatewayGetR2(env, 'source/experience.yml');

  // 7. Build summary / brief.
  const summary = buildSummary(name, signals, screen, commute);
  const researchedAt = new Date().toISOString();

  const brief = [
    summary,
    '',
    experienceYml ? `## Candidate Profile\n${experienceYml.slice(0, 2000)}` : '',
  ].join('\n');

  // 8. Determine tone.
  const tone_suggestion = await determineTone(env, signals, name);

  // 9. Persist — fire storage operations in parallel; don't let storage failures abort.
  const briefKey = `research/${options.jobId}/brief.md`;
  const kvKey = `research:${options.jobId}`;

  await Promise.allSettled([
    gatewayPutR2(env, briefKey, brief, 'text/markdown; charset=utf-8'),
    gatewayPutKV(env, kvKey, brief),
    writeVector(env, options.jobId, name, summary, options.facets ?? [], researchedAt),
  ]);

  return {
    type: 'research',
    summary,
    signals_json: JSON.stringify(signals),
    sources_json: JSON.stringify(sources),
    brief_key: briefKey,
    tone_suggestion,
  };
}

// --- persistence helpers ---

function encodeR2Segment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
}

async function writeVector(
  env: Env,
  jobId: string,
  company: string,
  summary: string,
  facets: string[],
  researchedAt: string,
): Promise<void> {
  const model = DEFAULT_EMBEDDING_MODEL;
  const run = env.AI.run as unknown as (
    m: string,
    inputs: Record<string, unknown>,
  ) => Promise<EmbeddingResponse>;
  const embedding = await run(model, { text: [summary] });
  const vector = embedding?.data?.[0];
  if (!vector || vector.length === 0) return;

  await gatewayVectorUpsert(env, [
    {
      id: `${encodeR2Segment(company)}:${jobId}`,
      values: vector,
      metadata: { company, jobId, facets: JSON.stringify(facets), researchedAt, summary },
    },
  ]);
}

// --- web search ---

interface TavilyQuery {
  q: string;
  depth: string;
  exact_match?: boolean;
}

function buildQueries(company: string, options: ResearchOptions): TavilyQuery[] {
  const depth = options.depth ?? 'standard';
  const facets = options.facets ?? [];
  const managerName = options.manager_name;

  if (depth === 'quick') {
    return [{ q: `${company} company overview red flags`, depth: 'basic' }];
  }

  if (depth === 'standard') {
    return [{ q: `${company} company overview culture engineering`, depth: 'basic' }];
  }

  // deep: base + one per facet
  const queries: TavilyQuery[] = [
    { q: `${company} company overview culture engineering`, depth: 'basic' },
  ];

  for (const facet of facets) {
    switch (facet) {
      case 'vision':
        queries.push({ q: `${company} vision strategy roadmap executives 2025`, depth: 'advanced' })
        break
      case 'funding':
        queries.push({ q: `${company} funding investors revenue business model moat`, depth: 'advanced' })
        break
      case 'culture':
        queries.push({ q: `${company} engineering culture glassdoor work life balance wfh`, depth: 'advanced' })
        break
      case 'tech_stack':
        queries.push({ q: `${company} tech stack architecture engineering github open source`, depth: 'advanced' })
        break
      case 'red_flags':
        queries.push({ q: `${company} lawsuit layoffs compliance issues controversy`, depth: 'advanced' })
        break
      case 'manager':
        if (managerName) {
          queries.push({ q: `"${managerName}" ${company} career background interviews`, depth: 'advanced', exact_match: true })
        } else {
          queries.push({ q: `site:linkedin.com "${company}" engineering manager hiring`, depth: 'advanced' })
        }
        break
      default:
        break
    }
  }

  return queries;
}

async function runTavilyQuery(
  endpoint: string,
  apiKey: string,
  query: TavilyQuery,
): Promise<ResearchSignal[]> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: query.q,
      search_depth: query.depth,
      max_results: 8,
      include_answer: true,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `researchCompany: search API returned ${response.status} ${response.statusText}.`,
    );
  }
  const data = (await response.json()) as TavilyResponse;
  return (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 500),
  }));
}

async function webSearch(env: Env, company: string, options: ResearchOptions): Promise<ResearchSignal[]> {
  if (!env.TAVILY_KEY) {
    throw new Error(
      "researchCompany: TAVILY_KEY is not configured. Set it with `wrangler secret put TAVILY_KEY`.",
    );
  }
  const endpoint = env.SEARCH_API_URL || DEFAULT_SEARCH_API_URL;
  const queries = buildQueries(company, options);

  const resultSets = await Promise.all(
    queries.map((query) => runTavilyQuery(endpoint, env.TAVILY_KEY!, query)),
  );

  // Flatten and dedupe by URL (keep first occurrence).
  const seen = new Set<string>();
  const signals: ResearchSignal[] = [];
  for (const set of resultSets) {
    for (const signal of set) {
      if (!seen.has(signal.url)) {
        seen.add(signal.url);
        signals.push(signal);
      }
    }
  }
  return signals;
}

// --- commute check ---

async function commuteCheck(env: Env, address: string): Promise<CommuteResult> {
  const driveMax = agentConfig.hardCriteria.commute.driveMaxSeconds;
  const transitMax = agentConfig.hardCriteria.commute.transitMaxSeconds;

  const response = await env.RESUMAESTRO.fetch(
    "https://worker/commute/route/address",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `researchCompany: resumaestro commute route returned ${response.status}.`,
    );
  }
  const data = (await response.json()) as {
    routes?: { drive?: { durationSeconds?: number }; transit?: { durationSeconds?: number } };
  };
  const driveSeconds = data.routes?.drive?.durationSeconds ?? null;
  const transitSeconds = data.routes?.transit?.durationSeconds ?? null;
  const withinLimits =
    (driveSeconds !== null && driveSeconds <= driveMax) ||
    (transitSeconds !== null && transitSeconds <= transitMax);
  return { address, driveSeconds, transitSeconds, withinLimits };
}

// --- hard-criteria screen ---

function screenRole(
  jobText: string,
  workType: ResearchOptions["workType"],
  commute: CommuteResult | null,
): ScreenResult {
  const text = jobText.toLowerCase();
  const flags: string[] = [];
  const reasons: string[] = [];
  const minComp = agentConfig.hardCriteria.minCompUsd;

  const salaries = extractSalaries(jobText);
  const topSalary = salaries.length > 0 ? Math.max(...salaries) : null;
  if (topSalary !== null && topSalary < minComp) {
    reasons.push(
      `stated salary ceiling ${formatUsd(topSalary)} is below the ${formatUsd(minComp)} minimum`,
    );
  }
  if (jobText && topSalary === null) flags.push("no salary range stated");

  const webTerms = [
    "web", "frontend", "front-end", "front end", "browser", "ui", "react",
    "typescript", "javascript", "css", "html", "vue", "svelte", "angular",
  ];
  const hasWeb = webTerms.some((t) => text.includes(t));
  if (jobText && !hasWeb) {
    reasons.push("posting does not mention web, frontend, browser, or UI technologies");
  }

  for (const lang of agentConfig.hardCriteria.avoidPrimaryLanguages) {
    const re = new RegExp(
      `\\b(primary|core|strong|expert|proficient|deep)\\b[^.]{0,40}\\b${lang}\\b` +
        `|\\b${lang}\\b[^.]{0,30}\\b(developer|engineer|expertise|required|proficiency)\\b`,
      "i",
    );
    if (re.test(jobText)) {
      reasons.push(`${lang} appears to be a primary or core language requirement`);
    }
  }

  if ((workType === "hybrid" || workType === "onsite") && commute && !commute.withinLimits) {
    reasons.push(
      `commute exceeds limits (drive ${secs(commute.driveSeconds)}, transit ${secs(commute.transitSeconds)})`,
    );
  }

  if (workType === "onsite") flags.push("onsite role");
  if (workType === "hybrid") flags.push("hybrid role");

  const rejected = reasons.length > 0;
  let fitScore = 8 - flags.length * 0.5;
  if (rejected) fitScore = Math.min(fitScore, 3);
  fitScore = Math.max(1, Math.min(10, Math.round(fitScore * 10) / 10));

  return {
    flags,
    fitScore,
    rejected,
    rejectionReason: rejected ? reasons.join("; ") : undefined,
  };
}

function extractSalaries(text: string): number[] {
  const out: number[] = [];
  let m: RegExpExecArray | null;

  const full = /\$\s?(\d{3}(?:,\d{3})+|\d{4,7})/g;
  while ((m = full.exec(text)) !== null) {
    const value = Number(m[1].replace(/,/g, ""));
    if (value >= 10000) out.push(value);
  }

  const shorthand = /\$?\s?(\d{2,4})\s?[kK]\b/g;
  while ((m = shorthand.exec(text)) !== null) {
    const value = Number(m[1]) * 1000;
    if (value >= 10000) out.push(value);
  }

  return out;
}

function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

function secs(n: number | null): string {
  return n === null ? "unknown" : `${Math.round(n / 60)}m`;
}

function buildSummary(
  company: string,
  signals: ResearchSignal[],
  screen: ScreenResult,
  commute: CommuteResult | null,
): string {
  const parts: string[] = [];
  parts.push(`# ${company} — Research Brief`);
  if (screen.rejected) parts.push(`> AUTO-REJECTED: ${screen.rejectionReason}`);
  if (screen.flags.length > 0) parts.push(`> Flags: ${screen.flags.join(", ")}`);
  parts.push(`Fit score: ${screen.fitScore}/10`);
  if (commute) {
    parts.push(
      `Commute: drive ${secs(commute.driveSeconds)}, transit ${secs(commute.transitSeconds)} ` +
        `(${commute.withinLimits ? "within" : "outside"} limits).`,
    );
  }

  parts.push("", "## Signals");
  if (signals.length === 0) {
    parts.push("No web signals found.");
  } else {
    for (const s of signals.slice(0, 6)) {
      parts.push(`- ${s.title}: ${s.snippet}${s.url ? ` (${s.url})` : ""}`);
    }
  }

  parts.push("", "## Methodology", RESEARCH_GUIDELINES, "", HARD_CRITERIA_SUMMARY);
  return parts.join("\n");
}
