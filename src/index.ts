import agentConfig from "../config/agentConfig.json";
import { surfaceScan } from "./skills/surfaceScan";
import { researchCompany } from "./skills/researchCompany";
import { buildResume } from "./skills/buildResume";
import { refineResume } from "./skills/refineResume";
import { applyToJob } from "./skills/applyToJob";

/**
 * Cloudflare Worker bindings. Configure the resource bindings + vars in wrangler.toml, and set
 * secret values with `wrangler secret put <NAME>`. No secret is hardcoded anywhere in this repo.
 */
export interface Env {
  /** Workers AI binding (embeddings + resume synthesis). */
  AI: Ai;
  /** Candidate experience chunks — read-only, ingested separately. */
  VECTOR_INDEX: VectorizeIndex;
  /** Company research cache — written after researchCompany. */
  RESUMAESTRO_COMPANIES: VectorizeIndex;
  /** People research cache — written by future people-research skill. */
  RESUMAESTRO_TEAMMEMBERS: VectorizeIndex;
  /** Role / job-description cache — written after buildResume. */
  RESUMAESTRO_ROLES: VectorizeIndex;
  /** D1 database for queryable pipeline records. */
  DB: D1Database;
  /** R2 bucket: source files (read) + research/resume outputs (write). */
  RESUMAESTRO_SOURCE: R2Bucket;
  /** KV namespace for pipeline state: briefs and cached answers. */
  RESUMAESTRO_PIPELINE: KVNamespace;
  /** KV namespace for dynamic config: model names, feature flags. */
  RESUMAESTRO_CONFIG: KVNamespace;

  /** Service binding to the Resumaestro app and integration gateway. */
  RESUMAESTRO: Fetcher;

  // secrets (wrangler secret put ...)
  TAVILY_KEY?: string;
}

type AgentMode = 'surface_scan' | 'deep_research' | 'tailor' | 'refine' | 'apply'

type AgentPayload = {
  mode: AgentMode
  job_id: string
  listing_url?: string
  depth?: 'quick' | 'standard' | 'deep'
  facets?: string[]
  manager_name?: string
  concern?: string
  feedback?: string
  grade?: string
  emphasis?: string
  company?: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function dispatchMode(env: Env, payload: AgentPayload): Promise<void> {
  try {
    const result = await runMode(env, payload)
    await postCallback(env, payload.job_id, payload.mode, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await postCallback(env, payload.job_id, payload.mode, {
      job_id: payload.job_id,
      type: 'error',
      error: message,
    })
  }
}

async function runMode(env: Env, payload: AgentPayload): Promise<Record<string, unknown>> {
  switch (payload.mode) {
    case 'surface_scan':
      return surfaceScan(env, payload)
    case 'deep_research':
      return runDeepResearch(env, payload)
    case 'tailor':
      return buildResume(env, payload)
    case 'refine':
      return refineResume(env, payload)
    case 'apply':
      return runApply(env, payload)
    default:
      throw new Error(`Unknown mode: ${payload.mode}`)
  }
}

async function postCallback(
  env: Env,
  jobId: string,
  mode: string,
  payload: unknown,
): Promise<void> {
  try {
    await env.RESUMAESTRO.fetch(`https://worker/jobs/${jobId}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await env.RESUMAESTRO.fetch(`https://worker/jobs/${jobId}/error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, error: message, errorType: 'transient' }),
    }).catch(() => {})
  }
}

async function runDeepResearch(env: Env, payload: AgentPayload): Promise<Record<string, unknown>> {
  const company = payload.company ?? ''
  if (!company) {
    return {
      type: 'research',
      job_id: payload.job_id,
      summary: null,
      signals_json: JSON.stringify([]),
      sources_json: JSON.stringify([]),
      brief_key: null,
      tone_suggestion: null,
      error: 'company name is required for deep_research',
    }
  }
  return researchCompany(env, company, {
    jobId: payload.job_id,
    depth: payload.depth ?? 'standard',
    facets: payload.facets ?? [],
    manager_name: payload.manager_name,
    concern: payload.concern,
  })
}

async function runApply(env: Env, payload: AgentPayload): Promise<Record<string, unknown>> {
  const result = await applyToJob(env, {
    jobId: payload.job_id,
    emphasis: payload.emphasis,
  });
  return result as unknown as Record<string, unknown>;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health / service descriptor.
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: agentConfig.name,
        description: agentConfig.description,
        usage: "POST /agent with { mode, job_id, callback_url, ...modeParams }",
      });
    }

    if (request.method === "POST" && url.pathname === "/agent") {
      let body: AgentPayload
      try {
        body = await request.json() as AgentPayload
      } catch {
        return json({ error: 'Invalid JSON body.' }, 400)
      }
      if (!body.mode || !body.job_id) {
        return json({ error: 'mode and job_id are required.' }, 400)
      }
      ctx.waitUntil(dispatchMode(env, body))
      return json({ accepted: true, jobId: body.job_id }, 202)
    }

    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;
