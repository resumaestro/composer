import type { Env } from './index'

const DEFAULTS = {
  resume: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  embedding: '@cf/qwen/qwen3-embedding-0.6b',
} as const

export type ModelType = keyof typeof DEFAULTS

export async function selectModel(env: Env, type: ModelType): Promise<string> {
  try {
    const kvValue = await env.RESUMAESTRO_CONFIG.get(`model:${type}`)
    if (kvValue) return kvValue
  } catch {
    // KV unavailable — fall through to env/default
  }

  if (type === 'resume' && env.RESUME_MODEL) return env.RESUME_MODEL
  if (type === 'embedding' && env.EMBEDDING_MODEL) return env.EMBEDDING_MODEL

  return DEFAULTS[type]
}
