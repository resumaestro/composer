import type { Env } from "../index";
import { selectModel } from "../models";
import { AGENT_PERSONA, RESUME_SYSTEM_PROMPT } from "../../config/prompts";

export interface BuildResumeInput {
  job_id: string
  company?: string
  listing_url?: string
  feedback?: string
  [key: string]: unknown
}

export interface BuildResumeResult {
  type: 'tailor'
  resume_key: string
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

async function gatewayGetKV(env: Env, key: string): Promise<string | null> {
  const res = await env.RESUMAESTRO.fetch(`https://worker/data/kv/${encodeURIComponent(key)}`);
  if (!res.ok) return null;
  return res.text();
}

async function gatewayGetJob(env: Env, jobId: string): Promise<Record<string, unknown> | null> {
  const res = await env.RESUMAESTRO.fetch(`https://worker/data/d1/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) return null;
  return res.json() as Promise<Record<string, unknown>>;
}

/**
 * Reads the candidate profile and company brief from the data gateway, then uses Workers AI
 * to synthesize a tailored one-page Markdown resume. Saves to R2 and returns the resume_key.
 * No direct D1 writes — resumaestro's result handler records those after receiving the callback.
 */
export async function buildResume(env: Env, payload: BuildResumeInput): Promise<Record<string, unknown>> {
  const jobId = payload.job_id;
  const company = payload.company ?? '';

  // 1. Load source of truth from R2 via gateway.
  const sourceProfile = await gatewayGetR2(env, 'source/experience.yml');
  if (!sourceProfile) {
    throw new Error(
      "buildResume: 'source/experience.yml' not found via gateway. Cannot build a resume without the source of truth.",
    );
  }

  // 2. Load company brief from KV (fast path) or fall back to R2.
  let companyContext = await gatewayGetKV(env, `research:${jobId}`);
  if (!companyContext) {
    companyContext = await gatewayGetR2(env, `research/${jobId}/brief.md`);
  }

  // 3. Determine resume version from job record.
  const jobRecord = await gatewayGetJob(env, jobId);
  const currentVersion = typeof jobRecord?.resume_version === 'number' ? jobRecord.resume_version : 0;
  const version = currentVersion + 1;
  const r2Key = `resumes/${jobId}/v${version}.md`;

  // 4. Assemble the prompt.
  const model = await selectModel(env, 'model:resume:build');
  const userPrompt = [
    `Target company: ${company}`,
    '',
    'Job posting / requirements:',
    payload.listing_url ? `Listing URL: ${payload.listing_url}` : '(none provided)',
    '',
    'Candidate profile (source/experience.yml — authoritative, do not invent beyond this):',
    sourceProfile,
    '',
    'Company research context (for framing only):',
    companyContext || '(none)',
    '',
    'Write the tailored one-page resume in Markdown now.',
  ].join('\n');

  // 5. Synthesize with Workers AI.
  const run = env.AI.run as unknown as (
    m: string,
    inputs: Record<string, unknown>,
  ) => Promise<ChatResponse>;
  const result = await run(model, {
    messages: [
      { role: 'system', content: `${AGENT_PERSONA}\n\n${RESUME_SYSTEM_PROMPT}` },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 2048,
    temperature: 0.2,
  });

  const markdown = (result?.response ?? '').trim();
  if (!markdown) throw new Error('buildResume: model returned an empty resume.');

  // 6. Save to R2 via gateway.
  await gatewayPutR2(env, r2Key, markdown, 'text/markdown; charset=utf-8');

  return { type: 'tailor', resume_key: r2Key } satisfies BuildResumeResult;
}
