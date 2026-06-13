/**
 * src/lib/text.ts
 *
 * Text utilities. The key one (Step 4) normalizes a query by lowercasing,
 * stripping punctuation, and removing common English stop words before it is
 * embedded — this concentrates the signal that actually drives cosine
 * similarity and keeps low-information tokens out of the embedded vector.
 */

/** Common English stop words removed before embedding. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "for", "to",
  "of", "in", "on", "at", "by", "with", "from", "as", "is", "are", "was",
  "were", "be", "been", "being", "this", "that", "these", "those", "it",
  "its", "we", "you", "they", "i", "he", "she", "our", "your", "their",
  "do", "does", "did", "have", "has", "had", "will", "would", "can", "could",
  "should", "may", "might", "must", "about", "into", "over", "under", "than",
  "so", "such", "not", "no", "yes", "up", "down", "out", "off", "via", "per",
]);

/** Lowercase, strip punctuation, drop stop words, and collapse whitespace. */
export function normalizeQuery(input: string): string {
  const cleaned = (input || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length === 0) return "";

  const kept = cleaned
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

  // Fall back to the cleaned string if stop-word removal emptied it out,
  // so a query made entirely of stop words still produces a usable vector.
  return kept.length > 0 ? kept.join(" ") : cleaned;
}

/** Lowercase hyphenated slug with no special characters (matches the legacy slug format). */
export function slugify(input: string): string {
  return (input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "unknown";
}

/** Hard-trim a string to a maximum character length. */
export function clamp(text: string, maxChars: number): string {
  if (!text) return "";
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}
