import type { Env } from '../index'
import {
  AGENT_PERSONA,
  RESUME_SYSTEM_PROMPT,
  REFINE_GRADE_A_PROMPT,
  REFINE_GRADE_B_PROMPT,
  REFINE_GRADE_C_PROMPT,
  REFINE_GRADE_D_PROMPT,
  REFINE_GRADE_F_PROMPT,
} from '../../config/prompts'

export interface RefinePayload {
  job_id: string
  grade?: string
  feedback?: string
  company?: string
  [key: string]: unknown
}

export interface RefineResult {
  type: 'tailor'
  resume_key: string
}

const DEFAULT_RESUME_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

interface ChatResponse {
  response: string
}

// --- gateway helpers ---

async function gatewayGetR2(env: Env, key: string): Promise<string | null> {
  const res = await env.RESUMAESTRO.fetch(`https://worker/data/r2?key=${encodeURIComponent(key)}`)
  if (!res.ok) return null
  return res.text()
}

async function gatewayPutR2(env: Env, key: string, body: string, contentType: string): Promise<void> {
  await env.RESUMAESTRO.fetch(`https://worker/data/r2?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  })
}

async function gatewayGetKV(env: Env, key: string): Promise<string | null> {
  const res = await env.RESUMAESTRO.fetch(`https://worker/data/kv/${encodeURIComponent(key)}`)
  if (!res.ok) return null
  return res.text()
}

async function gatewayPutKV(env: Env, key: string, value: string): Promise<void> {
  await env.RESUMAESTRO.fetch(`https://worker/data/kv/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: value,
  })
}

async function gatewayGetJob(env: Env, jobId: string): Promise<Record<string, unknown> | null> {
  const res = await env.RESUMAESTRO.fetch(`https://worker/data/d1/jobs/${encodeURIComponent(jobId)}`)
  if (!res.ok) return null
  return res.json() as Promise<Record<string, unknown>>
}

async function gatewayGetRefinements(env: Env, jobId: string): Promise<Array<Record<string, unknown>>> {
  const res = await env.RESUMAESTRO.fetch(`https://worker/data/d1/refinements/${encodeURIComponent(jobId)}`)
  if (!res.ok) return []
  return res.json() as Promise<Array<Record<string, unknown>>>
}

const GRADE_ORDER = ['A', 'B', 'C', 'D', 'F'] as const
type Grade = typeof GRADE_ORDER[number]

function gradeIndex(g: string): number {
  return GRADE_ORDER.indexOf(g.toUpperCase() as Grade)
}

/** Returns true if gradeA is higher (better) than gradeB */
function gradeIsHigher(a: string, b: string): boolean {
  const ia = gradeIndex(a)
  const ib = gradeIndex(b)
  if (ia === -1 || ib === -1) return false
  return ia < ib
}

/**
 * Iterative resume refinement. Grade determines context strategy and rewrite depth.
 */
export async function refineResume(env: Env, payload: RefinePayload): Promise<Record<string, unknown>> {
  const jobId = payload.job_id
  const grade = (payload.grade ?? 'C').toUpperCase()
  const feedback = payload.feedback ?? ''

  // 1. Determine version number from refinement history.
  const refinements = await gatewayGetRefinements(env, jobId)
  const versionNumber = refinements.length + 2 // v1 is the initial tailor; refinements start at v2

  // 2. Load the current (latest) resume from R2.
  const currentVersion = versionNumber - 1
  const currentResumeKey = `resumes/${jobId}/v${currentVersion}.md`
  const currentResume = await gatewayGetR2(env, currentResumeKey)
  if (!currentResume) {
    throw new Error(`refineResume: could not load current resume at ${currentResumeKey}`)
  }

  // 3. Load context based on grade.
  let brief: string | null = null
  let rawResearch: string | null = null
  let jobInfo: Record<string, unknown> | null = null
  let priorVersionContext = ''

  if (grade === 'A') {
    // Minimal context: only the job record summary fields
    jobInfo = await gatewayGetJob(env, jobId)
  } else if (grade === 'B') {
    brief = await gatewayGetKV(env, `research:${jobId}`)
  } else if (grade === 'C') {
    brief = await gatewayGetKV(env, `research:${jobId}`)
    // signals_json and sources_json live in the job record
    jobInfo = await gatewayGetJob(env, jobId)
  } else if (grade === 'D') {
    brief = await gatewayGetKV(env, `research:${jobId}`)
    jobInfo = await gatewayGetJob(env, jobId)
  } else if (grade === 'F') {
    // Full synthesis reset
    rawResearch = await gatewayGetR2(env, `research/${jobId}/raw.json`)
    // Mark current brief as failed
    const currentBrief = await gatewayGetKV(env, `research:${jobId}`)
    if (currentBrief) {
      await gatewayPutKV(env, `research:${jobId}:failed`, currentBrief)
    }
  }

  // 4. Prior grade check: if a prior refinement had a higher grade, include that version as context.
  if (refinements.length > 0) {
    let bestPrior: { grade: string; version: number } | null = null
    for (const r of refinements) {
      const rGrade = typeof r.grade === 'string' ? r.grade : ''
      const rVersion = typeof r.version === 'number' ? r.version : 0
      if (rGrade && rVersion && gradeIsHigher(rGrade, grade)) {
        if (!bestPrior || gradeIsHigher(rGrade, bestPrior.grade)) {
          bestPrior = { grade: rGrade, version: rVersion }
        }
      }
    }
    if (bestPrior) {
      priorVersionContext = `\n\nNOTE: A prior version (v${bestPrior.version}) was graded ${bestPrior.grade}. Consider what worked in that version.`
    }
  }

  // 5. Build the system + user prompt based on grade.
  let gradePrompt: string
  switch (grade) {
    case 'A':
      gradePrompt = REFINE_GRADE_A_PROMPT
      break
    case 'B':
      gradePrompt = REFINE_GRADE_B_PROMPT
      break
    case 'C':
      gradePrompt = REFINE_GRADE_C_PROMPT
      break
    case 'D':
      gradePrompt = REFINE_GRADE_D_PROMPT.replace('{feedback}', feedback)
      break
    case 'F':
      gradePrompt = REFINE_GRADE_F_PROMPT
      break
    default:
      gradePrompt = REFINE_GRADE_C_PROMPT
  }

  const contextParts: string[] = [
    `Current resume (v${currentVersion}):`,
    currentResume,
  ]

  if (grade === 'A' && jobInfo) {
    contextParts.push(
      '',
      'Job context:',
      `Company: ${jobInfo.company ?? ''}`,
      `Role: ${jobInfo.role ?? ''}`,
      `Comp: ${jobInfo.comp ?? ''}`,
      `Location: ${jobInfo.location ?? ''}`,
    )
  }

  if (brief) {
    contextParts.push('', 'Company research brief:', brief)
  }

  if (grade === 'C' && jobInfo) {
    const signalsJson = typeof jobInfo.signals_json === 'string' ? jobInfo.signals_json : '[]'
    const sourcesJson = typeof jobInfo.sources_json === 'string' ? jobInfo.sources_json : '[]'
    contextParts.push('', 'Research signals:', signalsJson)
    contextParts.push('', 'Research sources:', sourcesJson)
  }

  if (rawResearch) {
    contextParts.push('', 'Raw research data:', rawResearch)
  }

  if (feedback) {
    contextParts.push('', `User feedback: ${feedback}`)
  }

  if (priorVersionContext) {
    contextParts.push(priorVersionContext)
  }

  const userPrompt = contextParts.join('\n')

  // 6. Synthesize with Workers AI.
  const model = env.RESUME_MODEL || DEFAULT_RESUME_MODEL
  const run = env.AI.run as unknown as (
    m: string,
    inputs: Record<string, unknown>,
  ) => Promise<ChatResponse>

  const result = await run(model, {
    messages: [
      { role: 'system', content: `${AGENT_PERSONA}\n\n${RESUME_SYSTEM_PROMPT}\n\n${gradePrompt}` },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 2048,
    temperature: 0.2,
  })

  const markdown = (result?.response ?? '').trim()
  if (!markdown) throw new Error('refineResume: model returned an empty resume.')

  // 7. Save new version to R2.
  const newKey = `resumes/${jobId}/v${versionNumber}.md`
  await gatewayPutR2(env, newKey, markdown, 'text/markdown; charset=utf-8')

  // 8. If grade F, write new brief back to KV.
  if (grade === 'F' && rawResearch) {
    // Write the new markdown as the updated brief (it embeds the reassessed framing)
    await gatewayPutKV(env, `research:${jobId}`, markdown)
  }

  return { type: 'tailor', resume_key: newKey } satisfies RefineResult
}
