import type { Env } from "../index";

export interface VectorMatch {
  id: string;
  score: number;
  metadata: Record<string, unknown> | null;
}

export interface QueryVectorResult {
  query: string;
  index: string;
  matches: VectorMatch[];
  /** Human-readable supporting-evidence summary (metadata only; never raw code or secrets). */
  context: string;
}

export interface QueryVectorOptions {
  /** Optional metadata filter (requires a metadata index on the filtered field). */
  filter?: Record<string, unknown>;
}

const DEFAULT_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";

interface EmbeddingResponse {
  data: number[][];
}

/**
 * Migrated from the legacy `job-vector` skill.
 *
 * Embeds the query with Workers AI and runs a semantic similarity search against the Vectorize
 * binding to surface supporting evidence / job constraints. The legacy skill reached Vectorize
 * through the job-slack worker's /data gateway with a bearer token; this version uses the native
 * `env.AI.run()` + `env.VECTOR_INDEX.query()` bindings directly, so no gateway or token is needed.
 *
 * All job indices are 1024-dim, cosine. The embedding model matches the legacy system.
 */
export async function queryVectorDatabase(
  env: Env,
  query: string,
  topK = 5,
  options: QueryVectorOptions = {},
): Promise<QueryVectorResult> {
  const text = query?.trim();
  if (!text) throw new Error("queryVectorDatabase: 'query' must be a non-empty string.");

  // 1. Embed the query server-side.
  const model = env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  const run = env.AI.run as unknown as (
    m: string,
    inputs: Record<string, unknown>,
  ) => Promise<EmbeddingResponse>;
  const embedding = await run(model, { text: [text] });
  const vector = embedding?.data?.[0];
  if (!vector || vector.length === 0) {
    throw new Error("queryVectorDatabase: embedding returned an empty vector.");
  }

  // 2. Query the Vectorize index for the nearest neighbours.
  const result = await env.VECTOR_INDEX.query(vector, {
    topK,
    returnMetadata: true,
    ...(options.filter ? { filter: options.filter as VectorizeVectorMetadataFilter } : {}),
  });

  const matches: VectorMatch[] = (result.matches ?? []).map((m) => ({
    id: m.id,
    score: m.score,
    metadata: (m.metadata as Record<string, unknown> | undefined) ?? null,
  }));

  return {
    query: text,
    index: "VECTOR_INDEX",
    matches,
    context: formatEvidence(matches),
  };
}

/**
 * Render matches into a compact evidence summary for the resume builder. Uses only metadata
 * fields (title / summary / score). Honors the RAG rule from the legacy system: never surface raw
 * code or secrets, and phrase unverified records (`verified: false`) conservatively.
 */
function formatEvidence(matches: VectorMatch[]): string {
  if (matches.length === 0) return "No supporting evidence found in the vector index.";
  const lines = matches.map((m, i) => {
    const meta = m.metadata ?? {};
    const title =
      (typeof meta.title === "string" && meta.title) ||
      (typeof meta.name === "string" && meta.name) ||
      m.id;
    const summary =
      (typeof meta.summary === "string" && meta.summary) ||
      (typeof meta.description === "string" && meta.description) ||
      "";
    const verified = meta.verified === false ? " (unverified lead, phrase conservatively)" : "";
    const score = m.score.toFixed(3);
    return `${i + 1}. [${score}] ${title}${summary ? `: ${summary}` : ""}${verified}`;
  });
  return lines.join("\n");
}
