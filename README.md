# Resumaestro Composer

A unified, framework-agnostic **Cloudflare Worker** (TypeScript) that migrates the
legacy Hyperagent job-application skills — `job-research`, `job-vector`, and
`job-resume` — into a single asynchronous orchestration service running natively on
the Cloudflare Developer Platform.

| Legacy skill | Migrated to | Responsibility |
|---|---|---|
| `job-research` | `src/skills/researchCompany.ts` | Scrape a company/posting page with Browser Rendering |
| `job-vector`   | `src/skills/queryVectorDatabase.ts` | Embed + query Vectorize for supporting evidence |
| `job-resume`   | `src/skills/buildResume.ts` | Build a tailored one-page resume via tiered model routing |

---

## Architecture

```
POST /action ─▶ src/index.ts (router)
                  │  parse + validate
                  │  KV cache pre-check  ── fresh hit? ──┐
                  │                                       │
                  └─ HTTP 202 (immediate ack)             │
                  └─ ctx.waitUntil(runOrchestration) ─────┘
                                  │
                       src/agent.ts (coordinator)
                                  │
        ┌─────────────┬──────────┴───────────┬────────────────┐
        ▼             ▼                       ▼                ▼
 researchCompany  queryVectorDatabase    buildResume      lib/callback
 (Browser Rend.)  (Workers AI + Vectorize) (Workers AI /  POST ${CALLBACK_BASE_URL}
                                            AI Gateway)        /jobs/:id/result
```

### Asynchronous orchestration loop

Inbound requests are **acknowledged immediately** with `HTTP 202`. The heavy work
(browser rendering, embeddings, vector query, model calls) is offloaded into
`ctx.waitUntil()` so the client connection never hangs open or times out. When the
pipeline finishes, the worker POSTs a terminal `JobResult` to the resumaestro
framework seam at `POST ${CALLBACK_BASE_URL}/jobs/:id/result`.

> **Billing / scaling caveat (read this).** `ctx.waitUntil()` does **not** make
> background work free. CPU consumed by the background promises is billed exactly
> like CPU in the request handler, and the work must still complete within the
> Worker's wall-clock and CPU limits. `waitUntil` only decouples the *response*
> from the *work* — it is **not** a durable job queue.
>
> For genuinely long-running or heavy jobs, lift the body of `runOrchestration`
> into a durable primitive: **Cloudflare Queues** (this worker becomes the
> producer, a second worker the consumer) or **Cloudflare Workflows** (durable,
> multi-step, automatic retries). The coordinator is intentionally a single async
> function with no router coupling so it can be relocated with no change to the
> skills.

---

## File layout

```
composer/
├── config/
│   ├── agentConfig.json     # Code-free tuning surface: cache TTL, browser, embedding,
│   │                        #   vector topK cap, and model-routing tiers.
│   └── prompts.ts           # Resume system/user prompts + token guardrails.
├── src/
│   ├── index.ts             # Router: POST /action | /commands/add, 202 ack, waitUntil.
│   ├── agent.ts             # Coordinator: cache → research → vector → resume → callback.
│   ├── types.ts             # Env bindings + shared data contracts.
│   ├── lib/
│   │   ├── cache.ts         # KV research cache (7-day TTL + cachedAt freshness check).
│   │   ├── callback.ts      # Outbound result webhook (never throws into waitUntil).
│   │   └── text.ts          # Stop-word normalization, slugify, clamp.
│   └── skills/
│       ├── researchCompany.ts      # Browser Rendering scraper (@cloudflare/puppeteer).
│       ├── queryVectorDatabase.ts  # Workers AI embed + Vectorize query (topK ≤ 3).
│       └── buildResume.ts          # Tiered model routing (edge / premium via AI Gateway).
├── wrangler.toml
├── tsconfig.json
├── package.json
├── .env.example
└── .gitignore
```

---

## Cloudflare bindings

Declared in `wrangler.toml`:

| Binding | Type | Purpose |
|---|---|---|
| `RESEARCH_CACHE` | Workers KV | Historical scrape cache (7-day TTL) |
| `VECTOR_INDEX` | Vectorize | Semantic matching index (1024-dim, cosine) |
| `MY_BROWSER` | Browser Rendering | Edge headless Chrome |
| `AI` | Workers AI | Embeddings + edge text generation |

Before first deploy, fill the placeholders in `wrangler.toml`:

```bash
# Mint a KV namespace and copy the id into [[kv_namespaces]].id
npx wrangler kv namespace create RESEARCH_CACHE

# Point [[vectorize]].index_name at your index (1024-dim, cosine).
# e.g. source-code-rag, job-company, job-role.
npx wrangler vectorize create source-code-rag --dimensions=1024 --metric=cosine
```

### Secrets and vars

| Key | Where | Purpose |
|---|---|---|
| `EMBEDDING_MODEL` | var | Embedding model id (default `@cf/qwen/qwen3-embedding-0.6b`) |
| `CALLBACK_BASE_URL` | var | resumaestro seam base for result webhooks |
| `AI_GATEWAY_URL` | var | Cloudflare AI Gateway base; empty disables the premium tier |
| `CALLBACK_TOKEN` | secret | Optional bearer token on the result webhook |
| `PREMIUM_API_KEY` | secret | API key for the premium provider (Anthropic by default) |

```bash
npx wrangler secret put PREMIUM_API_KEY
npx wrangler secret put CALLBACK_TOKEN
```

For local dev, copy `.env.example` values into a gitignored `.dev.vars` file.

---

## Data caching mechanics

The research cache (`src/lib/cache.ts`) guards the same 7-day window with two layers:

1. **KV native TTL** — `put(..., { expirationTtl: 604800 })` evicts the key server-side.
2. **Stored `cachedAt` timestamp** — the reader computes age and treats anything
   older than the TTL as a miss, so stale research is never served even on an edge
   case. A fresh hit lets the router skip launching a browser entirely (Step 2).

Cache key: `research:v{configVersion}:{company-slug}`.

---

## Semantic filtering cost cap

`queryVectorDatabase` (`src/skills/queryVectorDatabase.ts`):

- **`topK` is hard-capped at 3** (`MAX_TOP_K`). Any caller-requested value is clamped
  into `[1, 3]` — it is never trusted past the ceiling.
- Query text is **normalized** (lowercased, punctuation-stripped, stop words removed)
  before embedding to concentrate similarity signal.
- **RAG safety:** metadata keys on the block list (`secret`, `credential`, `raw_code`,
  `token`, `api_key`) are dropped; records flagged `verified: false` are returned as
  unverified so downstream prompts phrase them conservatively. Raw code and secrets
  are never surfaced.

---

## Tiered model routing

`buildResume` (`src/skills/buildResume.ts`) selects a tier from
`config/agentConfig.json` (`modelRouting.tier`), overridable per request via
`options.tier`:

- **`edge` (default):** Workers AI (`env.AI.run`) — zero egress, cheap, good for base
  structure and stitching.
- **`premium`:** an external provider (Anthropic by default) reached **only** through
  a **Cloudflare AI Gateway** URL, so identical prompts are cached by the gateway and
  not re-billed. If the gateway or key is not configured, the build **degrades
  gracefully to edge** rather than failing.

**Token guardrails:** the system prompt forbids conversational filler, preambles, and
sign-offs (data-only output), while `maxTokens` is sized generously per tier to avoid
truncating a full one-page resume. Both live in config and prompts, not in code.

---

## API contract

### `POST /action`  (alias `POST /commands/add`)

```jsonc
{
  "jobId": "optional-caller-id",        // generated if omitted
  "company": "Acme",                    // required
  "companyUrl": "https://acme.com/about",
  "role": "Senior Frontend Engineer",
  "jobPostingUrl": "https://acme.com/jobs/123",
  "jobPostingText": "…inline posting text (skips scraping the posting)…",
  "sourceProfile": "…authoritative profile / source.yml projection…",
  "options": { "tier": "edge", "topK": 3 }
}
```

Immediate response:

```json
{ "jobId": "…", "status": "accepted", "company": "Acme", "cacheHit": false }
```

Terminal result (POSTed to `${CALLBACK_BASE_URL}/jobs/:id/result`):

```jsonc
{
  "jobId": "…", "status": "completed", "company": "Acme", "role": "…",
  "cacheHit": false,
  "research": { "...": "..." },
  "evidence": [ { "id": "…", "score": 0.81, "snippet": "…", "verified": true } ],
  "resume": { "tier": "edge", "model": "@cf/meta/llama-3-8b-instruct", "markdown": "…" },
  "finishedAt": "2026-06-13T20:00:00.000Z"
}
```

> **Note on `sourceProfile`.** The legacy stack reads `source.yml` and `BASE_RESUME.html`
> from R2 through the job-vector data worker. This worker is intentionally **not** bound
> to R2 — the resumaestro framework supplies the authoritative profile text in the
> request payload (`sourceProfile`), keeping Composer free of storage coupling. Bind R2
> here later if you want Composer to own that read directly.

---

## Commands

```bash
npm install            # install dependencies
npm run typecheck      # tsc --noEmit
npx wrangler dev       # local dev server
npx wrangler deploy    # deploy to Cloudflare
npx wrangler tail      # stream live logs
```

---

## Migration notes (corrections folded into this build)

- **Browser Rendering** uses the official `@cloudflare/puppeteer` API
  (`puppeteer.launch(env.MY_BROWSER)` → `newPage` → `goto` → single `evaluate`
  harvest → `close()` in a `finally`). The session is never held open across
  embedding/vector work.
- **`ctx.waitUntil()`** is used for response decoupling, with the billing/scaling
  caveat documented in `src/index.ts` and above. Heavy jobs should graduate to
  Queues/Workflows.
- **Resume model routing** is configurable (`config/agentConfig.json`) with a
  generous token budget to prevent truncation, rather than a fixed tiny limit.
