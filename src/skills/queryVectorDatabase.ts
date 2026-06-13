/**
 * src/skills/queryVectorDatabase.ts
 *
 * Migrates the legacy `job-vector` skill's read path. Embeds a query with
 * Workers AI (1024-dim qwen embedding in the legacy stack) and runs it against
 * env.VECTOR_INDEX.
 *
 * Cost cap (Step 4): topK is hard-capped at MAX_TOP_K (3). No caller can exceed
 * it — the request is clamped, not trusted.
 *
 * RAG safety (carried over from job-resume): never surface raw code, secrets,
 * or credentials. Metadata keys on the block list are dropped, and records
 * flagged `verified: false` are returned with `verified: false` so downstream
 * prompts phrase them conservatively.
 */

import config from "../../config/agentConfig.json";
import type { EvidenceMatch, Env } from "../types.js";
import { normalizeQuery } from "../lib/text.js";

/** Absolute ceiling on matches per query. The cost cap the spec mandates. */
export const MAX_TOP_K = 3;

const BLOCKED_KEYS = new Set(
  config.vector.blockedMetadataKeys.map((k) => k.toLowerCase()),
);

interface EmbeddingResponse {
  data: number[][];
}

/**
 * Permissive Workers AI run signature. The generated `Ai.run` overloads are
 * keyed to a curated model union; casting to this shape keeps the call
 * compiling across workers-types versions and across custom model ids.
 */
type AiRun = (model: string, inputs: Record<string, unknown>) => Promise<unknown>;

/** Embeds text server-side with Workers AI and returns the first vector. */
async function embed(env: Env, text: string): Promise<number[]> {
  const model = env.EMBEDDING_MODEL || config.embedding.model;
  const run = env.AI.run as unknown as AiRun;
  const result = (await run(model, { text: [text] })) as EmbeddingResponse;

  const vector = result?.data?.[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`Embedding model ${model} returned no vector`);
  }
  return vector;
}

/** Builds a human-safe snippet from metadata, skipping blocked/raw fields. */
function safeSnippet(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return "";
  const pieces: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (BLOCKED_KEYS.has(key.toLowerCase())) continue;
    if (value == null) continue;
    if (typeof value === "object") continue; // never spill structured blobs
    const text = String(value).trim();
    if (text.length === 0) continue;
    pieces.push(`${key}: ${text}`);
  }
  return pieces.join(" | ").slice(0, 800);
}

function isVerified(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return metadata.verified === true || metadata.verified === "true";
}

/**
 * Queries the vector index for supporting evidence. `requestedTopK` is clamped
 * into [1, MAX_TOP_K]. Matches below the configured minScore are dropped.
 */
export async function queryVectorDatabase(
  env: Env,
  query: string,
  requestedTopK = MAX_TOP_K,
): Promise<EvidenceMatch[]> {
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return [];

  const topK = Math.max(1, Math.min(requestedTopK, MAX_TOP_K));
  const vector = await embed(env, normalized);

  const response = await env.VECTOR_INDEX.query(vector, {
    topK,
    returnMetadata: config.vector.returnMetadata as "all",
  });

  const minScore = config.vector.minScore;
  return (response.matches || [])
    .filter((m) => typeof m.score !== "number" || m.score >= minScore)
    .map((m) => {
      const metadata = m.metadata as Record<string, unknown> | undefined;
      return {
        id: m.id,
        score: typeof m.score === "number" ? m.score : 0,
        snippet: safeSnippet(metadata),
        verified: isVerified(metadata),
      };
    })
    .filter((m) => m.snippet.length > 0);
}

/** Joins evidence matches into a single framing-context string for the resume prompt. */
export function evidenceToContext(matches: EvidenceMatch[]): string {
  if (matches.length === 0) return "";
  return matches
    .map((m, i) => {
      const tag = m.verified ? "verified" : "unverified lead — phrase conservatively";
      return `[${i + 1}] (${tag}, score ${m.score.toFixed(3)}) ${m.snippet}`;
    })
    .join("\n");
}
