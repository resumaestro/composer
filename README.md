# composer

The **intelligence plane**. Does all the work that requires outbound calls, AI inference, or document synthesis. It has no Slack awareness — it receives a job payload, does its work, and POSTs a result back. resumaestro owns the state; composer owns the thinking.

---

## Responsibilities

- Run each pipeline mode (`surface_scan`, `deep_research`, `tailor`, `refine`, `apply`) as a discrete, self-contained operation
- Research companies via Vectorize cache first, then Tavily web search — only spending credits on what isn't already known
- Build per-facet research queries based on the depth and focus areas the user selected
- Synthesize tailored resumes from the candidate's `source/experience.yml` and company context
- Fill application forms, identify unknowns, and return them as structured questions
- Cache all research output back to Vectorize so future runs on the same company are cheaper

## What it does not own

- Pipeline state — it reads the job record once (from the resumaestro data gateway) and never writes to D1 directly
- Slack — it has no idea a Slack surface exists; the callback URL it receives is an opaque HTTP endpoint
- User interaction — if it needs input it can't resolve, it returns `apply_needs_input` and stops; resumaestro handles surfacing the questions

---

## Contract with resumaestro

composer is the **callee**. resumaestro wakes it; composer delivers a result.

### Inbound — the agent payload

resumaestro POSTs to `POST /agent`:

```ts
{
  mode: 'surface_scan' | 'deep_research' | 'tailor' | 'refine' | 'apply'
  job_id: string
  callback_url: string     // where to deliver the result
  company?: string
  listing_url?: string
  depth?: 'quick' | 'standard' | 'deep'
  facets?: string[]        // vision | funding | culture | tech_stack | red_flags | manager
  manager_name?: string
  concern?: string
  feedback?: string
  tone?: string
  emphasis?: string
}
```

composer acknowledges immediately with `202` and runs the work asynchronously.

### Outbound — the result callback

composer POSTs the result to `callback_url`. The shape is determined by `mode`:

```ts
// surface_scan — what we learned from the listing
{ type: 'surface_scan', company, role, comp, work_model, company_url, job_url, scores_json }

// deep_research — company intel brief
{ type: 'research', summary, signals_json, sources_json, brief_key }

// tailor or refine — synthesized resume
{ type: 'tailor', resume_pdf_key }

// apply — application submitted or ready
{ type: 'apply' }

// apply — blocked on missing info
{ type: 'apply_needs_input', questions: [{ field, question }] }

// any mode — something went wrong
{ type: 'error', error: string }
```

composer must always POST to `callback_url`, even on error. resumaestro is waiting.

### Data gateway

composer reads source files and writes research artifacts through resumaestro's bearer-authenticated `/data/*` gateway. It never touches D1 or Vectorize directly — everything goes through the gateway.

---

## Research model

### Vectorize-first

Before making any outbound web requests, `deep_research` queries `RESUMAESTRO_COMPANIES` for a cached brief on the same company. If the score is high enough and the cache is fresh (< 30 days), that brief is used as base context. Tavily is only called for facets not already covered.

After every research run, the result is upserted back to Vectorize with metadata (`company`, `facets`, `researchedAt`) so the next research on the same company benefits.

### Depth × facets

`depth` sets the base strategy. Each checked `facet` adds an incremental Tavily query on top.

| depth | base behavior |
|---|---|
| `quick` | 1 query, `search_depth: basic` — overview and red flags |
| `standard` | 2 queries, `search_depth: basic` — overview + culture/stack |
| `deep` | 1 query per facet, `search_depth: advanced` |

Facet → query mapping:
- `vision` — roadmaps, priorities, executive trajectory
- `funding` — investors, financials, business model
- `culture` — Glassdoor, WFH policy, engineering reviews
- `tech_stack` — architecture, tools, open source
- `red_flags` — lawsuits, layoffs, compliance
- `manager` — interviewer profile; uses `exact_match` if `manager_name` is provided, otherwise searches LinkedIn

All queries run in parallel. Results are deduped by URL.

---

## Deploy

```bash
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put ROZZY_KEY
npx wrangler deploy
```

Set the deployed URL as `AGENT_WEBHOOK_URL` in resumaestro's `wrangler.toml`.
