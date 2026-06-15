import type { Env } from '../index'
import { APPLY_PROMPT } from '../../config/prompts'

export interface ApplyPayload {
  jobId: string
  emphasis?: string
}

export interface ApplyResult {
  type: 'apply' | 'apply_needs_input'
  job_id: string
  questions?: Array<{ field: string; question: string }>
}

interface ChatResponse {
  response: string
}

interface ResolvedField {
  field: string
  value: string
}

interface UnresolvedField {
  field: string
  question: string
}

interface ApplyExtraction {
  resolved?: ResolvedField[]
  unresolved?: UnresolvedField[]
}

// --- gateway helpers ---

async function gatewayGetR2(env: Env, key: string): Promise<string | null> {
  const res = await env.RESUMAESTRO.fetch(`https://worker/data/r2?key=${encodeURIComponent(key)}`)
  if (!res.ok) return null
  return res.text()
}

async function gatewayGetJob(env: Env, jobId: string): Promise<Record<string, unknown> | null> {
  const res = await env.RESUMAESTRO.fetch(`https://worker/data/d1/jobs/${encodeURIComponent(jobId)}`)
  if (!res.ok) return null
  return res.json() as Promise<Record<string, unknown>>
}

/**
 * Attempts to fill application form fields from resume + research context.
 * If all fields are resolvable, returns { type: 'apply' }.
 * If unknowns remain, returns { type: 'apply_needs_input', questions: [...] }.
 */
export async function applyToJob(env: Env, payload: ApplyPayload): Promise<ApplyResult> {
  const jobId = payload.jobId

  // 1. Load job record to find current resume version and any pending questions.
  const jobRecord = await gatewayGetJob(env, jobId)
  const resumeVersion = typeof jobRecord?.resume_version === 'number' ? jobRecord.resume_version : 1
  const pendingQuestionsRaw = typeof jobRecord?.apply_pending_json === 'string'
    ? jobRecord.apply_pending_json
    : null

  // 2. Load current resume from R2.
  const resumeKey = `resumes/${jobId}/v${resumeVersion}.md`
  const resume = await gatewayGetR2(env, resumeKey)
  if (!resume) {
    throw new Error(`applyToJob: could not load resume at ${resumeKey}`)
  }

  // 3. Load listing HTML for form field context.
  const listingHtml = await gatewayGetR2(env, `listings/${jobId}.html`)

  // 4. Build context for the model.
  const contextParts = [
    'Resume:',
    resume,
    '',
  ]

  if (listingHtml) {
    contextParts.push('Job listing (truncated for field context):')
    contextParts.push(listingHtml.slice(0, 10000))
    contextParts.push('')
  }

  if (pendingQuestionsRaw) {
    contextParts.push('Previously unresolved form fields (attempt to answer these):')
    contextParts.push(pendingQuestionsRaw)
    contextParts.push('')
  }

  if (payload.emphasis) {
    contextParts.push(`Additional emphasis: ${payload.emphasis}`)
  }

  const userPrompt = contextParts.join('\n')

  // 5. Use Workers AI to attempt to answer all form fields.
  const model = env.RESUME_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
  const run = env.AI.run as unknown as (
    m: string,
    inputs: Record<string, unknown>,
  ) => Promise<ChatResponse>

  const result = await run(model, {
    messages: [
      { role: 'system', content: APPLY_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 2048,
    temperature: 0.1,
  })

  let extraction: ApplyExtraction = {}
  try {
    const raw = (result?.response ?? '').trim()
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/\n?```$/, '')
      .trim()
    extraction = JSON.parse(raw) as ApplyExtraction
  } catch {
    // If parsing fails, treat everything as needing input
    return {
      type: 'apply_needs_input',
      job_id: jobId,
      questions: [{ field: 'unknown', question: 'Could not parse application fields. Please review manually.' }],
    }
  }

  const unresolved = extraction.unresolved ?? []

  if (unresolved.length === 0) {
    return { type: 'apply', job_id: jobId }
  }

  return {
    type: 'apply_needs_input',
    job_id: jobId,
    questions: unresolved.map((u) => ({ field: u.field, question: u.question })),
  }
}
