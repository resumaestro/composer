import type { Env } from './index'

const RESUME_DEFAULT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
const EMBEDDING_DEFAULT = '@cf/qwen/qwen3-embedding-0.6b'

export const MODEL_DEFAULTS = {
  'model:research:surface': RESUME_DEFAULT,
  'model:apply': RESUME_DEFAULT,
  'model:research:deep': RESUME_DEFAULT,
  'model:resume:refine': RESUME_DEFAULT,
  'model:resume:build': RESUME_DEFAULT,
  'model:company:query': EMBEDDING_DEFAULT,
  'model:company:write': EMBEDDING_DEFAULT,
} as const

export type ModelKey = keyof typeof MODEL_DEFAULTS

export async function selectModel(env: Env, key: ModelKey): Promise<string> {
  try {
    const kvValue = await env.RESUMAESTRO_CONFIG.get(key)
    if (kvValue) {
      return kvValue
    }
  } catch {
    // KV unavailable — fall through to default
  }

  return MODEL_DEFAULTS[key]
}
