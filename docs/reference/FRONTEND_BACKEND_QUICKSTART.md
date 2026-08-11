# Frontend–Backend Quick Start

This is the copyable frontend contract for the durable query-review workflow.
The complete rules and result schema are in
`BACKEND_FRONTEND_JSON_HANDOFF_SPEC.md`.

## Server-only frontend environment

```env
BACKEND_API_BASE_URL=http://127.0.0.1:3000
BACKEND_API_TOKEN=the-same-private-backend-token
```

Never use `NEXT_PUBLIC_` for either value. Google, OpenAI, Browserless,
`DATABASE_URL`, the service token, and `X-User-Id` must never reach browser code.
The Next.js BFF derives the user ID from the verified session.

## BFF route map

| Browser route | Backend route | Method | Timeout |
|---|---|---:|---:|
| `/api/runs` | `/api/runs` | POST | 15 s |
| `/api/runs/[runId]` | `/api/runs/{runId}` | GET | 10 s |
| `/api/runs/[runId]/queries` | `/api/runs/{runId}/queries` | GET | 10 s |
| `/api/runs/[runId]/queries` | `/api/runs/{runId}/queries` | PUT | 15 s |
| `/api/runs/[runId]/start` | `/api/runs/{runId}/start` | POST | 15 s |
| `/api/runs/[runId]/results` | `/api/runs/{runId}/results` | GET | 20 s |

Every BFF handler validates the opaque run ID, forwards only approved JSON and
query parameters, uses `cache: "no-store"`, and returns the backend status and
JSON body. It adds `Authorization` and `X-User-Id` only on the server-to-server
request.

## Browser flow

### 1. Create the planning run

```ts
const run = await apiRequest<StartRunResponse>("/api/runs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ shopTypes }),
}, parseStartRunResponse);
```

The response is:

```json
{
  "runId": "run_abcdefghijklmnop",
  "state": "queued",
  "phase": "query_planning",
  "stage": "queued_query_planning",
  "statusUrl": "/api/runs/run_abcdefghijklmnop",
  "queriesUrl": "/api/runs/run_abcdefghijklmnop/queries",
  "resultsUrl": "/api/runs/run_abcdefghijklmnop/results",
  "createdAt": "2026-08-01T12:00:00.000Z"
}
```

Poll `statusUrl` every three seconds while state is `queued` or `running`.

### 2. Load and edit revision 1

When state becomes `awaiting_query_confirmation`, stop polling and fetch:

```ts
const draft = await apiRequest<QuerySet>(run.queriesUrl, {}, parseQuerySet);
```

Send the complete replacement list when saving:

```ts
const saved = await apiRequest<QuerySet>(run.queriesUrl, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    revision: draft.revision,
    queries: rows.map(({ id, categoryIndex, query }) => ({
      ...(id ? { id } : {}),
      categoryIndex,
      query,
    })),
  }),
}, parseQuerySet);
```

Keep `saved.revision`. On `QUERY_REVISION_CONFLICT`, refetch and warn instead of
overwriting another tab. Disable Continue while local edits are unsaved.

### 3. Confirm the exact saved revision

```ts
await apiRequest<StartScrapeResponse>(`${run.statusUrl}/start`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ revision: saved.revision }),
}, parseStartScrapeResponse);
```

Resume three-second status polling. If final validation returns the run to
`awaiting_query_confirmation`, refetch the query set and focus the first row with
`validationState: "invalid"`. Fetch results only after `resultsAvailable` is
true.

## TypeScript shapes

```ts
type RunState =
  | "queued"
  | "running"
  | "awaiting_query_confirmation"
  | "completed"
  | "failed"
  | "cancelled";

type RunPhase = "query_planning" | "query_review" | "scraping" | "finished";
type QuerySource = "generated" | "user_added" | "user_edited";
type QueryValidationState = "pending" | "valid" | "invalid";

type QueryCategory = {
  categoryIndex: number;
  originalShopType: string;
  shopType: string;
  businessQualifier: string;
};

type RunQuery = {
  id: string;
  categoryIndex: number;
  sequence: number;
  query: string;
  source: QuerySource;
  validationState: QueryValidationState;
  rejectionReason: string | null;
  queryScore: number | null;
  generationReason: string | null;
  probedAt: string | null;
};

type QuerySet = {
  runId: string;
  revision: number;
  editable: boolean;
  categories: QueryCategory[];
  queries: RunQuery[];
};

type QueryReviewStatus = {
  revision: number;
  confirmedRevision: number | null;
  editable: boolean;
  queriesUrl: string;
  valid: boolean | null;
  invalidQueryCount: number | null;
};

type RunStatus = {
  runId: string;
  state: RunState;
  phase: RunPhase | null;
  stage: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: RunProgress;
  resultsAvailable: boolean;
  pipelineVersion: number | null;
  scoringVersion: number | null;
  queryReview: QueryReviewStatus | null;
  error: { code: string; message: string } | null;
};

type StartRunResponse = {
  runId: string;
  state: RunState;
  phase: RunPhase;
  stage: string;
  statusUrl: string;
  queriesUrl: string;
  resultsUrl: string;
  createdAt: string;
};

type StartScrapeResponse = {
  runId: string;
  state: "queued";
  phase: "scraping";
  stage: "queued_query_validation";
  revision: number;
};
```

Keep the existing `RunProgress`, lead, pagination, evidence, and CSV types.

## Editor rules

- Group rows by `categoryIndex`; category metadata is read-only.
- Prefill a new row with `site:myshopify.com/products `.
- Allow add, edit, delete, and reorder; keep at least one row per category.
- Show generated score/reason and row-level `rejectionReason`.
- Send only `id`, `categoryIndex`, and `query` in a save item.
- The backend normalizes and authoritatively validates every row.
- Keep the last deleted generated row in browser state only for Undo.

## Stage labels

```ts
const stageLabels: Record<string, string> = {
  queued_query_planning: "Waiting to plan queries",
  reading_categories: "Preparing categories",
  researching_category: "Researching categories",
  generating_candidates: "Generating search ideas",
  validating_candidates: "Validating search ideas",
  probing_queries: "Testing search coverage",
  selecting_queries: "Selecting the strongest queries",
  awaiting_query_confirmation: "Review your search queries",
  queued_query_validation: "Waiting to validate your queries",
  validating_confirmed_queries: "Checking your saved queries",
  probing_confirmed_queries: "Testing updated query coverage",
  discovering_stores: "Discovering Shopify stores",
  extracting_leads: "Finding contact details",
  writing_results: "Saving your results",
  completed: "Run completed",
  failed: "Run failed",
  cancelled: "Run cancelled",
};
```

## Error handling

| Error | Frontend behavior |
|---|---|
| `QUERY_LIST_INVALID` (422) | Map `details.errors` to rows/categories |
| `QUERY_REVISION_CONFLICT` (409) | Refetch and warn; never overwrite silently |
| `RUN_NOT_AWAITING_QUERY_CONFIRMATION` (409) | Refetch run status |
| `QUERY_CONFIRMATION_IN_PROGRESS` (409) | Continue planning-status polling |
| `QUERY_CONFIRMATION_RATE_LIMITED` (429) | Disable Continue briefly and offer retry |
| `RESULTS_NOT_READY` (409) | Continue status polling |
| `RESULTS_UNAVAILABLE` (409) | Show the safe terminal run error |
| `502`, `503`, `504` | Preserve local edits and offer retry |

Completed results and review drafts have no scheduled application expiry. Both
survive API restarts because PostgreSQL, not browser or worker memory, is the
source of truth.
