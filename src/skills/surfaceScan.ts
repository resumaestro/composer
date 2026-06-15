import type { Env } from '../index'
import { selectModel } from '../models'
import { SURFACE_SCAN_PROMPT } from '../../config/prompts'

interface SurfaceScanPayload {
  job_id: string
  listing_url?: string
}

interface SurfaceScanResult {
  type: 'surface_scan'
  company: string | null
  role: string | null
  responsibilities: string[]
  requirements: string[]
  comp: string | null
  work_model: 'remote' | 'hybrid' | 'onsite' | null
  location: string | null
  company_url: string | null
  job_url: string | null
  scores_json: string
}

interface ChatResponse {
  response: string
}

/**
 * Fetches the job listing URL, uses Workers AI to extract structured data.
 * Saves raw HTML to R2 and returns the surface_scan result shape.
 */
export async function surfaceScan(env: Env, payload: SurfaceScanPayload): Promise<Record<string, unknown>> {
  const listingUrl = payload.listing_url
  if (!listingUrl) {
    throw new Error('surfaceScan: listing_url is required')
  }

  // 1. Fetch the listing page.
  let html: string
  try {
    const response = await fetch(listingUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Resumaestro/1.0)' },
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    html = await response.text()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new Error(`surfaceScan: failed to fetch listing URL "${listingUrl}": ${message}`)
  }

  // 2. Save raw HTML to R2 via gateway.
  const htmlKey = `listings/${payload.job_id}.html`
  await gatewayPutR2(env, htmlKey, html, 'text/html; charset=utf-8')

  // 3. Extract structured data with Workers AI.
  // Truncate HTML to a manageable size — most relevant content is in the first ~50k chars.
  const truncatedHtml = html.slice(0, 50000)
  const run = env.AI.run as unknown as (
    m: string,
    inputs: Record<string, unknown>,
  ) => Promise<ChatResponse>

  const model = await selectModel(env, 'model:research:surface')
  const result = await run(model, {
    messages: [
      { role: 'system', content: SURFACE_SCAN_PROMPT },
      { role: 'user', content: `Extract structured job data from the following HTML:\n\n${truncatedHtml}` },
    ],
    max_tokens: 1024,
    temperature: 0,
  })

  let extracted: Partial<{
    company: string | null
    role: string | null
    responsibilities: string[]
    requirements: string[]
    comp: string | null
    work_model: string | null
    location: string | null
    company_url: string | null
    job_url: string | null
  }> = {}

  try {
    const raw = (result?.response ?? '').trim()
    // Strip markdown fences if model wrapped output
    const jsonStr = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim()
    extracted = JSON.parse(jsonStr)
  } catch {
    // If parsing fails, return nulls rather than throwing — surface_scan is best-effort
    extracted = {}
  }

  const company = extracted.company ?? null
  const role = extracted.role ?? null
  const comp = extracted.comp ?? null
  const work_model = (extracted.work_model as SurfaceScanResult['work_model']) ?? null
  const location = extracted.location ?? null

  const scores_json = JSON.stringify({ company, role, comp, work_model, location })

  return {
    type: 'surface_scan',
    company,
    role,
    responsibilities: extracted.responsibilities ?? [],
    requirements: extracted.requirements ?? [],
    comp,
    work_model,
    location,
    company_url: extracted.company_url ?? listingUrl,
    job_url: extracted.job_url ?? listingUrl,
    scores_json,
  } satisfies SurfaceScanResult
}

// --- gateway helpers ---

async function gatewayPutR2(env: Env, key: string, body: string, contentType: string): Promise<void> {
  await env.RESUMAESTRO.fetch(`https://worker/data/r2?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  })
}
