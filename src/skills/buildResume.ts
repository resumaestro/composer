/**
 * src/skills/buildResume.ts
 *
 * Migrates the legacy `job-resume` skill's drafting step with a tiered,
 * config-driven model architecture (Step 5):
 *
 *  - edge tier (default): Workers AI (`env.AI.run`). Zero egress, cheap,
 *    good enough for base structure and stitching.
 *  - premium tier: an external provider (Anthropic by default) reached ONLY
 *    through a Cloudflare AI Gateway URL, so identical prompts are cached by
 *    the gateway and not re-billed.
 *
 * The target model for each tier lives in config/agentConfig.json so routing
 * can be retuned without code changes. Token budgets are set generously there
 * to avoid truncating a full one-page resume, while the system prompt enforces
 * the "data only, no filler" guardrail.
 *
 * If premium is selected but the gateway/key is not configured, the build
 * degrades gracefully to the edge tier rather than failing the job.
 */

import config from "../../config/agentConfig.json";
import {
  RESUME_SYSTEM_PROMPT,
  buildResumeUserPrompt,
  type ResumePromptInput,
} from "../../config/prompts.js";
import type { Env, ModelTier, ResumeResult } from "../types.js";

type AiRun = (model: string, inputs: Record<string, unknown>) => Promise<unknown>;

interface EdgeChatResponse {
  response?: string;
}

interface AnthropicTextBlock {
  type: string;
  text?: string;
}
interface AnthropicResponse {
  content?: AnthropicTextBlock[];
}

/** Workers AI chat completion (edge tier). */
async function runEdge(env: Env, system: string, user: string): Promise<string> {
  const { model, maxTokens, temperature } = config.modelRouting.edge;
  const run = env.AI.run as unknown as AiRun;
  const result = (await run(model, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature,
  })) as EdgeChatResponse;

  const text = (result?.response || "").trim();
  if (!text) throw new Error(`Edge model ${model} returned empty output`);
  return text;
}

/**
 * Premium tier through the Cloudflare AI Gateway. The provider endpoint is
 * appended to AI_GATEWAY_URL so the request is always proxied (and cached) by
 * the gateway — never sent direct to the provider.
 */
async function runPremium(env: Env, system: string, user: string): Promise<string> {
  const gateway = (env.AI_GATEWAY_URL || "").replace(/\/+$/, "");
  if (!gateway || !env.PREMIUM_API_KEY) {
    throw new Error("premium tier requires AI_GATEWAY_URL and PREMIUM_API_KEY");
  }

  const cfg = config.modelRouting.premium;
  const endpoint = `${gateway}/anthropic/v1/messages`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.PREMIUM_API_KEY,
      "anthropic-version": cfg.anthropicVersion,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`premium provider responded ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as AnthropicResponse;
  const text = (data.content || [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join("")
    .trim();

  if (!text) throw new Error("premium provider returned no text content");
  return text;
}

/**
 * Builds the tailored resume. Resolves the tier (request override > config),
 * runs the matching provider, and returns the markdown plus routing metadata.
 */
export async function buildResume(
  env: Env,
  input: ResumePromptInput,
  tierOverride?: ModelTier,
): Promise<ResumeResult> {
  const requestedTier: ModelTier =
    tierOverride || (config.modelRouting.tier as ModelTier);

  const system = RESUME_SYSTEM_PROMPT;
  const user = buildResumeUserPrompt(input);

  let tier: ModelTier = requestedTier;
  let markdown: string;
  let model: string;

  if (requestedTier === "premium") {
    try {
      markdown = await runPremium(env, system, user);
      model = config.modelRouting.premium.model;
    } catch (err) {
      // Graceful degradation: premium misconfigured or upstream failed.
      console.warn(`[buildResume] premium tier unavailable, falling back to edge:`, err);
      tier = "edge";
      markdown = await runEdge(env, system, user);
      model = config.modelRouting.edge.model;
    }
  } else {
    markdown = await runEdge(env, system, user);
    model = config.modelRouting.edge.model;
  }

  return { role: input.role, company: input.company, tier, model, markdown };
}
