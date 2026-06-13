import type { Env } from "../index";
import agentConfig from "../../config/agentConfig.json";
import { HARD_CRITERIA_SUMMARY, RESEARCH_GUIDELINES } from "../../config/prompts";

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
}

export interface ResearchOptions {
  address?: string;
  workType?: "remote" | "hybrid" | "onsite";
  jobText?: string;
}

const DEFAULT_SEARCH_API_URL = "https://api.tavily.com/search";
const DEFAULT_COMMUTE_URL = "https://geoapify-commute-worker.cameronaziz.workers.dev";

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

/**
 * Migrated from the legacy `job-research` skill.
 *
 * Orchestrates outbound intelligence gathering with standard web `fetch()` calls: a web search
 * pass for company signals (funding, team, culture, news) and an optional commute check against
 * the geoapify commute worker. It then screens the role against the candidate's hard criteria and
 * produces a fit score. No fabricated facts: everything reported here is sourced from fetched data.
 */
export async function researchCompany(
  env: Env,
  company: string,
  options: ResearchOptions = {},
): Promise<CompanyResearch> {
  const name = company?.trim();
  if (!name) throw new Error("researchCompany: 'company' must be a non-empty string.");

  // 1. Outbound web intelligence.
  const signals = await webSearch(env, name);

  // 2. Optional commute check for hybrid / onsite roles.
  let commute: CommuteResult | null = null;
  if (options.address && (options.workType === "hybrid" || options.workType === "onsite")) {
    commute = await commuteCheck(env, options.address);
  }

  // 3. Hard-criteria screen + fit scoring.
  const screen = screenRole(options.jobText ?? "", options.workType, commute);

  const sources = signals.map((s) => s.url).filter((u) => u.length > 0);
  const summary = buildSummary(name, signals, screen, commute);

  return {
    company: name,
    summary,
    signals,
    sources,
    commute,
    flags: screen.flags,
    fitScore: screen.fitScore,
    rejected: screen.rejected,
    rejectionReason: screen.rejectionReason,
    researchedAt: new Date().toISOString(),
  };
}

/** Web search via the configured search API (Tavily-compatible POST). */
async function webSearch(env: Env, company: string): Promise<ResearchSignal[]> {
  if (!env.TAVILY_API_KEY) {
    throw new Error(
      "researchCompany: TAVILY_API_KEY is not configured. Set it with `wrangler secret put TAVILY_API_KEY`.",
    );
  }
  const endpoint = env.SEARCH_API_URL || DEFAULT_SEARCH_API_URL;
  const query = `${company} company funding investors leadership team culture engineering recent news`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      search_depth: "advanced",
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
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: (r.content ?? "").slice(0, 500),
  }));
}

/** Commute check against the geoapify commute worker (POST /route/address, x-rozzy-key header). */
async function commuteCheck(env: Env, address: string): Promise<CommuteResult> {
  if (!env.ROZZY_KEY) {
    throw new Error(
      "researchCompany: ROZZY_KEY is not configured. Set it with `wrangler secret put ROZZY_KEY`.",
    );
  }
  const driveMax = agentConfig.hardCriteria.commute.driveMaxSeconds;
  const transitMax = agentConfig.hardCriteria.commute.transitMaxSeconds;
  const base = (env.COMMUTE_WORKER_URL || DEFAULT_COMMUTE_URL).replace(/\/+$/, "");

  const response = await fetch(`${base}/route/address`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rozzy-key": env.ROZZY_KEY },
    body: JSON.stringify({ address }),
  });
  if (!response.ok) {
    throw new Error(`researchCompany: commute worker returned ${response.status}.`);
  }
  const data = (await response.json()) as {
    routes?: { drive?: { durationSeconds?: number }; transit?: { durationSeconds?: number } };
  };
  const driveSeconds = data.routes?.drive?.durationSeconds ?? null;
  const transitSeconds = data.routes?.transit?.durationSeconds ?? null;
  // Pass if drive OR transit is within its threshold (matches the legacy rule).
  const withinLimits =
    (driveSeconds !== null && driveSeconds <= driveMax) ||
    (transitSeconds !== null && transitSeconds <= transitMax);
  return { address, driveSeconds, transitSeconds, withinLimits };
}

/** Screen the role against the candidate's hard criteria and compute a coarse fit score. */
function screenRole(
  jobText: string,
  workType: ResearchOptions["workType"],
  commute: CommuteResult | null,
): ScreenResult {
  const text = jobText.toLowerCase();
  const flags: string[] = [];
  const reasons: string[] = [];
  const minComp = agentConfig.hardCriteria.minCompUsd;

  // Salary detection.
  const salaries = extractSalaries(jobText);
  const topSalary = salaries.length > 0 ? Math.max(...salaries) : null;
  if (topSalary !== null && topSalary < minComp) {
    reasons.push(
      `stated salary ceiling ${formatUsd(topSalary)} is below the ${formatUsd(minComp)} minimum`,
    );
  }
  if (jobText && topSalary === null) flags.push("no salary range stated");

  // Web technology requirement.
  const webTerms = [
    "web", "frontend", "front-end", "front end", "browser", "ui", "react",
    "typescript", "javascript", "css", "html", "vue", "svelte", "angular",
  ];
  const hasWeb = webTerms.some((t) => text.includes(t));
  if (jobText && !hasWeb) {
    reasons.push("posting does not mention web, frontend, browser, or UI technologies");
  }

  // Primary Python / Go as a core language.
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

  // Commute (only relevant for hybrid / onsite).
  if ((workType === "hybrid" || workType === "onsite") && commute && !commute.withinLimits) {
    reasons.push(
      `commute exceeds limits (drive ${secs(commute.driveSeconds)}, transit ${secs(commute.transitSeconds)})`,
    );
  }

  // Non-blocking flags.
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

  // $200,000 / $200000
  const full = /\$\s?(\d{3}(?:,\d{3})+|\d{4,7})/g;
  while ((m = full.exec(text)) !== null) {
    const value = Number(m[1].replace(/,/g, ""));
    if (value >= 10000) out.push(value);
  }

  // $200k / 200K
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
