import agentConfig from "../config/agentConfig.json";
import { runPipeline, type PipelineInput, type WorkType } from "./agent";

/**
 * Cloudflare Worker bindings. Configure the resource bindings + vars in wrangler.toml, and set
 * secret values with `wrangler secret put <NAME>`. No secret is hardcoded anywhere in this repo.
 */
export interface Env {
  /** Workers AI binding (embeddings + resume synthesis). */
  AI: Ai;
  /** Vectorize index binding (defaults to source-code-rag; see wrangler.toml). */
  VECTOR_INDEX: VectorizeIndex;
  /** R2 bucket holding source.yml, BASE_RESUME.html, and research payloads. */
  JOB_SOURCE: R2Bucket;

  // vars (wrangler.toml [vars])
  EMBEDDING_MODEL?: string;
  RESUME_MODEL?: string;
  COMMUTE_WORKER_URL?: string;
  SEARCH_API_URL?: string;
  CALLBACK_BASE_URL?: string;

  // secrets (wrangler secret put ...)
  TAVILY_API_KEY?: string;
  ROZZY_KEY?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Validate and normalize an incoming job request payload. */
function parsePipelineInput(raw: unknown): { input?: PipelineInput; error?: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "Request body must be a JSON object." };
  }
  const body = raw as Record<string, unknown>;

  const company = typeof body.company === "string" ? body.company.trim() : "";
  if (!company) {
    return { error: "Field 'company' is required and must be a non-empty string." };
  }

  const query =
    typeof body.query === "string" && body.query.trim()
      ? body.query.trim()
      : typeof body.jobDescription === "string"
        ? body.jobDescription.trim()
        : "";
  if (!query) {
    return { error: "One of 'query' or 'jobDescription' is required." };
  }

  const workType: WorkType | undefined =
    body.workType === "remote" || body.workType === "hybrid" || body.workType === "onsite"
      ? body.workType
      : undefined;

  const input: PipelineInput = {
    jobId: typeof body.id === "string" && body.id ? body.id : crypto.randomUUID(),
    company,
    query,
    jobDescription: typeof body.jobDescription === "string" ? body.jobDescription : undefined,
    address: typeof body.address === "string" ? body.address : undefined,
    workType,
    topK: typeof body.topK === "number" ? body.topK : undefined,
    callbackUrl: typeof body.callbackUrl === "string" ? body.callbackUrl : undefined,
  };
  return { input };
}

/** POST the pipeline result back to the platform's async callback endpoint. */
async function postResult(base: string, jobId: string, payload: unknown): Promise<void> {
  const url = `${base.replace(/\/+$/, "")}/jobs/${encodeURIComponent(jobId)}/result`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Run the orchestrated pipeline and deliver the result to the callback (if configured). */
async function processJob(env: Env, input: PipelineInput): Promise<void> {
  const callbackBase = input.callbackUrl ?? env.CALLBACK_BASE_URL;
  try {
    const result = await runPipeline(env, input);
    if (callbackBase) await postResult(callbackBase, input.jobId, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (callbackBase) {
      await postResult(callbackBase, input.jobId, {
        jobId: input.jobId,
        status: "error",
        error: message,
      });
    }
  }
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
        pipeline: agentConfig.pipeline,
        usage: "POST / or POST /jobs with { company, query | jobDescription, id?, callbackUrl? }",
      });
    }

    // Kick off a job.
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/jobs")) {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return json({ error: "Invalid JSON body." }, 400);
      }

      const { input, error } = parsePipelineInput(raw);
      if (error || !input) return json({ error: error ?? "Invalid request." }, 400);

      // Async callback flow: acknowledge immediately, deliver the result to /jobs/:id/result.
      if (input.callbackUrl || env.CALLBACK_BASE_URL) {
        ctx.waitUntil(processJob(env, input));
        return json({ accepted: true, jobId: input.jobId, status: "processing" }, 202);
      }

      // Synchronous mode: no callback configured, return the result inline.
      try {
        const result = await runPipeline(env, input);
        return json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ jobId: input.jobId, status: "error", error: message }, 500);
      }
    }

    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;
