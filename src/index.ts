/**
 * src/index.ts
 *
 * Request router and async-orchestration entrypoint for Resumaestro Composer.
 *
 * ── Asynchronous orchestration model ───────────────────────────────────────
 * An inbound POST is acknowledged immediately (HTTP 202) and the heavy work
 * (browser rendering, embedding, Vectorize query, model calls) is offloaded
 * into `ctx.waitUntil()`. This stops the client HTTP connection from hanging
 * open or timing out while the pipeline runs.
 *
 * IMPORTANT BILLING / SCALING CAVEAT:
 *   `ctx.waitUntil()` does NOT make background work free. CPU time consumed by
 *   the background promises is billed exactly like CPU time in the request
 *   handler, and the work must still finish within the Worker's wall-clock and
 *   CPU limits. `waitUntil` only decouples the *response* from the work; it is
 *   not a durable job queue.
 *
 *   For genuinely long-running or heavy jobs (multi-page crawls, large model
 *   batches, retry-heavy flows), migrate the background body to a durable
 *   primitive: Cloudflare Queues (producer here, consumer Worker) or Cloudflare
 *   Workflows (durable, multi-step, automatic retries). The coordinator in
 *   agent.ts is deliberately a single async function so it can be lifted into a
 *   Queue consumer or a Workflow step with no change to the skills.
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { ActionRequest, Env } from "./types.js";
import { readResearchCache } from "./lib/cache.js";
import { runOrchestration } from "./agent.js";

/** Routes that accept a new orchestration job. */
const ACTION_ROUTES = new Set(["/action", "/commands/add"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Lightweight liveness probe.
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) {
      return json({ service: "composer", status: "ok", time: new Date().toISOString() });
    }

    if (!ACTION_ROUTES.has(url.pathname)) {
      return json({ error: "not_found", path: url.pathname }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed", expected: "POST" }, 405);
    }

    // --- Parse + validate the inbound context securely --------------------
    let body: ActionRequest;
    try {
      body = (await request.json()) as ActionRequest;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body.company !== "string" || body.company.trim().length === 0) {
      return json({ error: "missing_required_field", field: "company" }, 400);
    }

    const jobId = body.jobId && body.jobId.trim().length > 0 ? body.jobId : crypto.randomUUID();

    // --- Step 2: KV cache pre-check before any resource-heavy work ---------
    // A fresh hit (<7 days) lets the coordinator skip the browser entirely.
    let cache;
    try {
      cache = await readResearchCache(env.RESEARCH_CACHE, body.company);
    } catch (err) {
      console.error(`[router] cache read failed for "${body.company}":`, err);
      cache = { hit: false, fresh: false };
    }

    // --- Offload the pipeline; respond immediately -------------------------
    ctx.waitUntil(runOrchestration(env, body, jobId, cache));

    return json(
      {
        jobId,
        status: "accepted",
        company: body.company,
        cacheHit: cache.hit,
        message: "Orchestration started. Result will be POSTed to the callback seam.",
      },
      202,
    );
  },
};
