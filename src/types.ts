/**
 * src/types.ts
 *
 * Worker environment bindings and the shared data contracts that flow between
 * the router, the coordinator, and the migrated skills.
 */

import type { BrowserWorker } from "@cloudflare/puppeteer";

/**
 * Bindings declared in wrangler.toml plus the plain vars / secrets the worker
 * reads at runtime. Keep this in lockstep with wrangler.toml.
 */
export interface Env {
  /** Workers KV — historical research cache (binding RESEARCH_CACHE). */
  RESEARCH_CACHE: KVNamespace;
  /** Vectorize — semantic matching index (binding VECTOR_INDEX). */
  VECTOR_INDEX: VectorizeIndex;
  /** Browser Rendering — edge headless Chrome (binding MY_BROWSER). */
  MY_BROWSER: BrowserWorker;
  /** Workers AI — zero-infrastructure edge models (binding AI). */
  AI: Ai;

  // --- vars / secrets ---
  /** Embedding model id used for Vectorize queries. */
  EMBEDDING_MODEL?: string;
  /** Base URL of a Cloudflare AI Gateway. Empty/undefined disables premium tier. */
  AI_GATEWAY_URL?: string;
  /** API key for the premium provider (Anthropic by default). */
  PREMIUM_API_KEY?: string;
}

/** Model routing tier selector. */
export type ModelTier = "edge" | "premium";

/** Inbound request body for POST /action (and the /commands/add alias). */
export interface ActionRequest {
  /** Optional caller-supplied id. Generated if absent. */
  jobId?: string;
  /** Company name (used as the cache key and resume context). Required. */
  company: string;
  /** Company / careers page to scrape when the cache misses. */
  companyUrl?: string;
  /** Target role title. */
  role?: string;
  /** Job posting URL (scraped if companyUrl is absent). */
  jobPostingUrl?: string;
  /** Inline job posting text (skips scraping the posting itself). */
  jobPostingText?: string;
  /** Authoritative profile text (source.yml projection) for grounding the resume. */
  sourceProfile?: string;
  /** Per-request overrides. */
  options?: {
    /** Force a model tier for this run, overriding agentConfig.json. */
    tier?: ModelTier;
    /** Number of Vectorize matches to request (still hard-capped at 3). */
    topK?: number;
  };
}

/** Structured text harvested from a page by the browser-rendering scraper. */
export interface ScrapedPage {
  url: string;
  title: string;
  metaDescription: string;
  headings: string[];
  bodyText: string;
  jsonLd: string[];
  scrapedAt: string;
}

/** Company research payload (migrated job-research output, worker-shaped). */
export interface CompanyResearch {
  company: string;
  source: "cache" | "browser";
  page?: ScrapedPage;
  summary: string;
  cachedAt?: string;
}

/** A single Vectorize match, sanitized for safe downstream use. */
export interface EvidenceMatch {
  id: string;
  score: number;
  /** Human-safe text assembled from non-blocked metadata fields. */
  snippet: string;
  /** True when the source record is explicitly marked verified. */
  verified: boolean;
}

/** Result of the resume build. */
export interface ResumeResult {
  role: string;
  company: string;
  tier: ModelTier;
  model: string;
  markdown: string;
}

/** Terminal payload delivered to the callback webhook. */
export interface JobResult {
  jobId: string;
  status: "completed" | "failed";
  company: string;
  role: string;
  cacheHit: boolean;
  research?: CompanyResearch;
  evidence?: EvidenceMatch[];
  resume?: ResumeResult;
  error?: string;
  finishedAt: string;
}
