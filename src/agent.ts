/**
 * src/agent.ts
 *
 * Core coordinator. Runs the full migrated pipeline for one job:
 *
 *   cache check (done by the router) -> research (browser, on miss)
 *     -> semantic evidence (Vectorize) -> resume build (tiered model)
 *     -> result callback.
 *
 * This function is invoked from inside ctx.waitUntil() by the router, so it
 * owns its own error handling: every terminal path (success or failure) ends
 * by posting a JobResult to the callback seam. It must not throw back into the
 * waitUntil scheduler.
 */

import type { ActionRequest, CompanyResearch, Env, JobResult } from "./types.js";
import type { CacheReadResult } from "./lib/cache.js";
import { writeResearchCache } from "./lib/cache.js";
import { postResult } from "./lib/callback.js";
import { researchCompany } from "./skills/researchCompany.js";
import { queryVectorDatabase, evidenceToContext } from "./skills/queryVectorDatabase.js";
import { buildResume } from "./skills/buildResume.js";
import { clamp } from "./lib/text.js";

/** Chooses the URL to scrape, preferring an explicit company page. */
function scrapeTarget(req: ActionRequest): string | undefined {
  return req.companyUrl || req.jobPostingUrl || undefined;
}

/** Assembles the query that drives the Vectorize evidence lookup. */
function evidenceQuery(req: ActionRequest, research: CompanyResearch): string {
  const role = req.role || "";
  const postingSignal = req.jobPostingText || research.summary || "";
  return `${role}. ${clamp(postingSignal, 600)}`;
}

/** The job posting text the resume builder should tailor against. */
function postingText(req: ActionRequest, research: CompanyResearch): string {
  if (req.jobPostingText && req.jobPostingText.trim().length > 0) {
    return req.jobPostingText;
  }
  // Fall back to scraped posting/company text when no inline posting was given.
  return research.page?.bodyText || research.summary || "";
}

export async function runOrchestration(
  env: Env,
  req: ActionRequest,
  jobId: string,
  cache: CacheReadResult,
): Promise<void> {
  const company = req.company;
  const role = req.role || "Unspecified Role";

  try {
    // --- 1. Research: use fresh cache, otherwise scrape (Step 2 / Step 3) ---
    let research: CompanyResearch;
    if (cache.hit && cache.research) {
      research = cache.research;
    } else {
      const target = scrapeTarget(req);
      if (target) {
        research = await researchCompany(env, company, target);
        // Persist for the next run's 7-day window.
        await writeResearchCache(env, company, research);
      } else {
        // No URL to scrape and no cache: proceed with whatever text the caller gave.
        research = {
          company,
          source: "browser",
          summary: `Company: ${company}. No research URL supplied; using caller-provided posting text only.`,
        };
      }
    }

    // --- 2. Semantic evidence from Vectorize (Step 4, topK capped at 3) -----
    const evidence = await queryVectorDatabase(
      env,
      evidenceQuery(req, research),
      req.options?.topK,
    );

    // --- 3. Build the tailored resume (Step 5, tiered model routing) --------
    const resume = await buildResume(
      env,
      {
        role,
        company,
        jobPosting: postingText(req, research),
        sourceProfile: req.sourceProfile || "",
        research: research.summary,
        supportingEvidence: evidenceToContext(evidence),
      },
      req.options?.tier,
    );

    // --- 4. Deliver success to the callback seam ---------------------------
    const result: JobResult = {
      jobId,
      status: "completed",
      company,
      role,
      cacheHit: cache.hit,
      research,
      evidence,
      resume,
      finishedAt: new Date().toISOString(),
    };
    await postResult(env, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[orchestration] job ${jobId} failed:`, message);
    const failure: JobResult = {
      jobId,
      status: "failed",
      company,
      role,
      cacheHit: cache.hit,
      error: message,
      finishedAt: new Date().toISOString(),
    };
    await postResult(env, failure);
  }
}
