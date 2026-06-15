/**
 * src/lib/cache.ts
 *
 * Workers KV research cache (Step 2 / Step 3).
 *
 * Two layers of expiry guard the same 7-day window:
 *  1. KV's native `expirationTtl` evicts the key server-side.
 *  2. A stored `cachedAt` ISO timestamp lets the reader assert freshness
 *     explicitly ("TTL under 7 days") even if a stale value is somehow served.
 */

import config from "../../config/agentConfig.json";
import type { CompanyResearch } from "../types.js";
import { slugify } from "./text.js";

const TTL_SECONDS = config.cache.ttlSeconds;
const KEY_PREFIX = config.cache.keyPrefix;
const CACHE_VERSION = config.version;

interface CacheEnvelope {
  cachedAt: string;
  research: CompanyResearch;
}

/** Deterministic cache key for a company. */
export function researchCacheKey(company: string): string {
  return `${KEY_PREFIX}:v${CACHE_VERSION}:${slugify(company)}`;
}

export interface CacheReadResult {
  hit: boolean;
  fresh: boolean;
  research?: CompanyResearch;
}

/**
 * Reads the research cache and applies the freshness window. A value older
 * than the TTL is reported as a miss (`hit: false`) so the coordinator scrapes
 * again rather than serving stale research.
 */
export async function readResearchCache(
  kv: KVNamespace,
  company: string,
): Promise<CacheReadResult> {
  const raw = await kv.get(researchCacheKey(company), "json");
  if (!raw) return { hit: false, fresh: false };

  const envelope = raw as CacheEnvelope;
  const ageMs = Date.now() - Date.parse(envelope.cachedAt);
  const fresh = Number.isFinite(ageMs) && ageMs < TTL_SECONDS * 1000;

  if (!fresh) return { hit: false, fresh: false };

  return {
    hit: true,
    fresh: true,
    research: { ...envelope.research, source: "cache", cachedAt: envelope.cachedAt },
  };
}

/** Writes research to KV with both the native TTL and a `cachedAt` timestamp. */
export async function writeResearchCache(
  kv: KVNamespace,
  company: string,
  research: CompanyResearch,
): Promise<string> {
  const cachedAt = new Date().toISOString();
  const envelope: CacheEnvelope = { cachedAt, research: { ...research, cachedAt } };
  await kv.put(researchCacheKey(company), JSON.stringify(envelope), {
    expirationTtl: TTL_SECONDS,
  });
  return cachedAt;
}
