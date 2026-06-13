import type { Env } from "../index";
import { AGENT_PERSONA, RESUME_SYSTEM_PROMPT } from "../../config/prompts";

export interface BuildResumeInput {
  company: string;
  jobDescription: string;
  vectorContext: string;
  companyContext: string;
  /** Optional override for the candidate profile; defaults to source.yml from R2. */
  sourceProfile?: string;
}

export interface BuildResumeResult {
  markdown: string;
  model: string;
  usedSourceOfTruth: boolean;
}

const DEFAULT_RESUME_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SOURCE_KEY = "source.yml";
const BASE_RESUME_KEY = "BASE_RESUME.html";

interface ChatResponse {
  response: string;
}

/**
 * Migrated from the legacy `job-resume` skill.
 *
 * Loads the authoritative candidate profile (source.yml) from R2, combines it with the vector
 * evidence and company research context, and uses Workers AI (`env.AI.run`) to synthesize a
 * tailored, one-page Markdown resume. source.yml is the only source of truth; the model is
 * instructed never to fabricate beyond it. The legacy skill rendered HTML + PDF through the
 * job-slack gateway; this version returns Markdown for the caller to render or convert downstream.
 */
export async function buildResume(env: Env, input: BuildResumeInput): Promise<BuildResumeResult> {
  // 1. Load the source of truth (and the optional base template) from R2.
  const sourceProfile = input.sourceProfile ?? (await readR2Text(env, SOURCE_KEY));
  if (!sourceProfile) {
    throw new Error(
      `buildResume: '${SOURCE_KEY}' not found in the R2 bucket. Cannot build a resume without the source of truth.`,
    );
  }
  const baseResume = await readR2Text(env, BASE_RESUME_KEY);

  // 2. Assemble the prompt.
  const model = env.RESUME_MODEL || DEFAULT_RESUME_MODEL;
  const userPrompt = [
    `Target company: ${input.company}`,
    "",
    "Job posting / requirements:",
    input.jobDescription || "(none provided)",
    "",
    "Candidate profile (source.yml — authoritative, do not invent beyond this):",
    sourceProfile,
    "",
    "Supporting technical evidence (context only, never fabricate claims from this):",
    input.vectorContext || "(none)",
    "",
    "Company research context (for framing only):",
    input.companyContext || "(none)",
    baseResume
      ? "\nA base resume template exists in storage; preserve its section ordering and hierarchy where possible."
      : "",
    "",
    "Write the tailored one-page resume in Markdown now.",
  ].join("\n");

  // 3. Synthesize with Workers AI.
  const run = env.AI.run as unknown as (
    m: string,
    inputs: Record<string, unknown>,
  ) => Promise<ChatResponse>;
  const result = await run(model, {
    messages: [
      { role: "system", content: `${AGENT_PERSONA}\n\n${RESUME_SYSTEM_PROMPT}` },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 2048,
    temperature: 0.2,
  });

  const markdown = (result?.response ?? "").trim();
  if (!markdown) throw new Error("buildResume: model returned an empty resume.");

  return { markdown, model, usedSourceOfTruth: true };
}

async function readR2Text(env: Env, key: string): Promise<string | null> {
  const object = await env.JOB_SOURCE.get(key);
  if (!object) return null;
  return object.text();
}
