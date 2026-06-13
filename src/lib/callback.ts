/**
 * src/lib/callback.ts
 *
 * Outbound callback seam. When background orchestration finishes (or fails),
 * the worker POSTs the terminal payload to the resumaestro framework at
 * `${CALLBACK_BASE_URL}/jobs/:id/result`.
 *
 * This runs inside ctx.waitUntil(), so it must never throw into the caller:
 * a failed webhook is logged and swallowed, not surfaced as an unhandled
 * rejection that would abort the background promise chain.
 */

import type { Env, JobResult } from "../types.js";

export async function postResult(env: Env, result: JobResult): Promise<void> {
  const base = (env.CALLBACK_BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    console.warn(`[callback] CALLBACK_BASE_URL unset; skipping result delivery for job ${result.jobId}`);
    return;
  }

  const url = `${base}/jobs/${encodeURIComponent(result.jobId)}/result`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.CALLBACK_TOKEN) headers["authorization"] = `Bearer ${env.CALLBACK_TOKEN}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(result),
    });
    if (!res.ok) {
      console.error(`[callback] ${url} responded ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error(`[callback] failed to deliver result for job ${result.jobId}:`, err);
  }
}
