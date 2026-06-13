# Composer

A standalone **TypeScript Cloudflare Worker** that auto-assembles a tailored job application end to end. It is a migration of the legacy **Conductor** agent (and its `job-*` skills) off the Hyperagent platform and onto the native Cloudflare Developer Platform.

Given a job posting, Composer:

1. queries a **Vectorize** index for supporting technical evidence,
2. **researches the company** with outbound web `fetch()` calls and screens the role against hard criteria, and
3. synthesizes a tailored, one-page **resume** with **Workers AI**.

It never fabricates employment claims (the candidate's `source.yml` is the only source of truth), and it never submits an application on its own. Every run stops at a human review gate and returns a result for approval.

---

## Migration map: legacy `job-*` concepts → new modules

| Legacy (Hyperagent) | New module | What changed |
|---|---|---|
| `job-vector` skill (`job_data.py` calling the job-slack `/data` gateway with a bearer token) | `src/skills/queryVectorDatabase.ts` | Uses the **native** `env.AI.run()` for embeddings and `env.VECTOR_INDEX.query()` for search. No gateway, no bearer token. |
| `job-research` skill (Python + commute worker + cache lookups) | `src/skills/researchCompany.ts` | Outbound intelligence via standard `fetch()` (Tavily-compatible search + the geoapify commute worker). Hard-criteria screen + fit score preserved. |
| `job-resume` skill (HTML/PDF via the gateway) | `src/skills/buildResume.ts` | Reads `source.yml` from the **R2** binding and uses **Workers AI** (`env.AI.run()`) to synthesize Markdown. |
| Conductor orchestration + human gate | `src/agent.ts` | `runPipeline()` runs the three skills in order, honors auto-rejection, and always returns `humanGate: true`. |
| Agent persona, model settings, system prompt | `config/agentConfig.json`, `config/prompts.ts` | Persona + model settings extracted to JSON; prompt strings exported as constants. |
| Cloudflare bindings (R2 `job-source`, Vectorize indices, Workers AI) | `wrangler.toml` | Declared as native Worker bindings. |

> **Architecture note.** The legacy skills routed all Cloudflare I/O through the `job-slack` worker's `/data/*` gateway (holding the R2 / Vectorize / Workers AI bindings behind a token). This migration follows the target's native-binding architecture: the worker holds the bindings directly. The embedding model (`@cf/qwen/qwen3-embedding-0.6b`, 1024-dim cosine) and the hard criteria are unchanged.

---

## Project structure

```
composer/
├── config/
│   ├── agentConfig.json          # Extracted persona parameters & model settings
│   └── prompts.ts                # Exported system-prompt string constants
├── src/
│   ├── index.ts                  # Worker entry point (POST handler + async callback)
│   ├── agent.ts                  # Execution orchestrator coordinating the skills
│   └── skills/
│       ├── queryVectorDatabase.ts  # env.AI.run() embed + env.VECTOR_INDEX.query()
│       ├── researchCompany.ts      # outbound fetch() intelligence + hard-criteria screen
│       └── buildResume.ts          # env.AI.run() resume synthesis from R2 source of truth
├── .env.example                  # Local env keys (dummy values)
├── wrangler.toml                 # R2, Vectorize, and AI bindings + vars
├── package.json
├── tsconfig.json                 # Strict TypeScript
└── README.md
```

---

## API

### `GET /`
Service descriptor and health check.

### `POST /` or `POST /jobs`
Kicks off the pipeline. JSON body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `company` | string | yes | Company name to research. |
| `query` or `jobDescription` | string | yes (one of) | Drives vector evidence + resume tailoring. |
| `id` | string | no | Job id; a UUID is generated if omitted. |
| `address` | string | no | Office address for the commute check. |
| `workType` | `"remote" \| "hybrid" \| "onsite"` | no | Commute is only checked for hybrid/onsite. |
| `topK` | number | no | Vector matches to retrieve (default 6). |
| `callbackUrl` | string | no | If set (or `CALLBACK_BASE_URL` is configured), the worker returns `202` immediately and POSTs the result to `<callbackUrl>/jobs/:id/result`. |

**Async callback flow.** When a callback base is configured, the worker acknowledges with `202 { accepted, jobId }` and later delivers the full `PipelineResult` to `POST /jobs/:id/result`. With no callback configured, it runs synchronously and returns the result inline.

Example:

```bash
curl -X POST http://localhost:8787/jobs \
  -H 'content-type: application/json' \
  -d '{ "company": "Acme", "jobDescription": "Senior frontend engineer, React/TypeScript ...", "workType": "hybrid", "address": "123 Market St, San Francisco" }'
```

---

## Configuration

Resource bindings live in `wrangler.toml`:

- `AI` — Workers AI
- `VECTOR_INDEX` — Vectorize (defaults to `source-code-rag`; 1024-dim, cosine)
- `JOB_SOURCE` — R2 bucket `job-source`

Non-secret vars (in `wrangler.toml [vars]`): `EMBEDDING_MODEL`, `RESUME_MODEL`, `COMMUTE_WORKER_URL`, `SEARCH_API_URL`, `CALLBACK_BASE_URL`.

**Secrets** (never committed; see `.env.example` for local dummies):

```bash
wrangler secret put TAVILY_API_KEY   # web search API key (researchCompany)
wrangler secret put ROZZY_KEY        # x-rozzy-key header for the commute worker
```

For local dev, copy `.env.example` to `.dev.vars` and fill in values.

---

## Develop & deploy

```bash
npm install          # install typescript, wrangler, @cloudflare/workers-types
npm run typecheck    # tsc --noEmit (strict)
npx wrangler dev     # run locally at http://localhost:8787
npx wrangler deploy  # deploy to Cloudflare
```

Before deploying, ensure the R2 bucket (`job-source`) and the Vectorize index (`source-code-rag`) exist in your Cloudflare account and that the bindings in `wrangler.toml` match their names.

---

## Guardrails carried over from Conductor

- **Source of truth.** `source.yml` (read from R2) is authoritative. Vector and research results are supporting context only and can never create employment claims.
- **No fabrication.** Missing data is reported, never invented.
- **Human gate.** The pipeline never submits. It returns `status: "ready_for_review"` (or `"rejected"` when the role fails the hard criteria) for human approval.
- **No secrets in the repo.** All credentials are Worker secrets / bindings.
