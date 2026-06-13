/**
 * config/prompts.ts
 *
 * Prompt surface for the resume-fabrication skill. Kept in /config (not /src)
 * so the wording can be tuned without touching coordinator logic.
 *
 * Token guardrails (Step 5): the system prompt forbids conversational filler,
 * preambles, and sign-offs, and instructs the model to emit only the resume
 * body. We deliberately do NOT starve the output token budget — that lives in
 * agentConfig.json (`modelRouting.*.maxTokens`) and is sized to avoid
 * truncation of a full one-page resume.
 */

export interface ResumePromptInput {
  /** Target role title, e.g. "Senior Frontend Engineer". */
  role: string;
  /** Company name. */
  company: string;
  /** Raw or lightly-parsed job posting text. */
  jobPosting: string;
  /** Authoritative employment history (source.yml content or a JSON projection of it). */
  sourceProfile: string;
  /** Company research context produced by researchCompany (may be empty). */
  research: string;
  /** Supporting technical evidence retrieved from Vectorize (may be empty). */
  supportingEvidence: string;
}

/**
 * System prompt. Encodes the legacy job-resume writing rules and the
 * token-guardrail directive to skip all preamble and return data only.
 */
export const RESUME_SYSTEM_PROMPT = [
  "You are a resume fabrication engine. You output a single tailored, ATS-friendly,",
  "one-page resume in clean Markdown and nothing else.",
  "",
  "Hard output contract:",
  "- Respond with the resume body only. No preamble, no greeting, no explanation,",
  "  no closing remarks, no code fences, no commentary about what you did.",
  "- Begin directly with the candidate heading.",
  "",
  "Grounding contract (non-negotiable):",
  "- Every employment claim, title, date, and metric must be supported by the",
  "  authoritative profile provided. Never invent employers, roles, dates, or numbers.",
  "- Company research and supporting evidence are framing context only. They can",
  "  shape emphasis and wording; they can never create a new factual claim.",
  "- If a desirable keyword is not supported by the profile, omit it rather than fabricate.",
  "",
  "Writing rules:",
  "- Direct, natural language. No buzzwords, no empty adjectives, no cliches, no AI-style phrasing.",
  "- Do not use em dashes.",
  "- Each bullet states one distinct accomplishment or competency. No repeated metrics or ideas.",
  "- The summary must not restate the experience bullets.",
  "- Prioritize measurable impact and the most relevant, recent experience.",
  "- Select skills and aliases that match the posting's own vocabulary.",
  "- Keep the whole document to one page of content.",
].join("\n");

/**
 * Builds the user message from the assembled context. Sections are clearly
 * delimited so the model can distinguish authoritative facts from framing.
 */
export function buildResumeUserPrompt(input: ResumePromptInput): string {
  const section = (title: string, body: string): string => {
    const trimmed = (body || "").trim();
    return `## ${title}\n${trimmed.length > 0 ? trimmed : "(none provided)"}`;
  };

  return [
    `Tailor a one-page resume for the role "${input.role}" at "${input.company}".`,
    "",
    section("AUTHORITATIVE PROFILE (source of truth — only facts here may be asserted)", input.sourceProfile),
    "",
    section("JOB POSTING (tailor toward these requirements)", input.jobPosting),
    "",
    section("COMPANY RESEARCH (framing only)", input.research),
    "",
    section("SUPPORTING TECHNICAL EVIDENCE (framing only, never quote raw code)", input.supportingEvidence),
    "",
    "Produce the resume now. Markdown only, resume body only.",
  ].join("\n");
}
