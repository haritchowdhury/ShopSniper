# Frontend Backend Quick Start

> Authentication update: the current owner-scoped contract is documented in
> `AUTH_AND_RUN_OWNERSHIP_IMPLEMENTATION_PLAN.md` and
> `../frontend/README.md`. The older unauthenticated examples below are retained
> as historical v0.1 reference and must not be exposed publicly.

This backend implements the JSON contract in
`BACKEND_FRONTEND_JSON_HANDOFF_SPEC.md`. It accepts manual categories, persists
runs and leads in Neon PostgreSQL, and does not use CSV files in the HTTP path.

## Start locally

Use Node.js 20 or newer. Configure the backend-only `.env`:

```env
DATABASE_URL=postgresql://...-pooler.../neondb?sslmode=require
GOOGLE_API_KEY=...
GOOGLE_SEARCH_ENGINE_ID=...
OPENAI_API_KEY=...
BACKEND_API_TOKEN=choose-a-long-random-value
```

The same `DATABASE_URL` is used for runtime and Prisma CLI commands. `DIRECT_URL`
is optional because `prisma.config.ts` falls back to `DATABASE_URL`; add a direct
Neon URL only if a future migration cannot run through the pooled connection.

Apply reviewed migrations to a non-production Neon branch, generate Prisma
Client, and start:

```bash
npm install
npm run db:migrate:deploy
npm run db:generate
npm start
```

The default backend base URL is `http://127.0.0.1:3000`.

For frontend work without Google/OpenAI calls, point `DATABASE_URL` at a
non-production migrated database and run:

```bash
FRONTEND_SEED_CONFIRM=non-production \
FRONTEND_SEED_OWNER_ID=the-neon-auth-user-id \
npm run seed:frontend
```

The command prints a completed fixture `runId` containing qualified, rejected,
and failed rows owned by that exact auth user. The guard refuses to run in
`NODE_ENV=production`.

## Next.js server-only environment

```env
BACKEND_API_BASE_URL=http://127.0.0.1:3000
BACKEND_API_TOKEN=the-same-private-backend-token
```

Never use a `NEXT_PUBLIC_` prefix for either value. Do not put `DATABASE_URL`,
Google, OpenAI, or Browserless credentials in the frontend project.

The browser calls same-origin Next.js Route Handlers. Those handlers forward to:

| Next.js route | Backend request |
|---|---|
| `GET /api/health` | `GET {BACKEND_API_BASE_URL}/api/health` |
| `POST /api/runs` | `POST {BACKEND_API_BASE_URL}/api/runs` |
| `GET /api/runs/[runId]` | `GET {BACKEND_API_BASE_URL}/api/runs/{runId}` |
| `GET /api/runs/[runId]/results` | Same path and query string |

When `BACKEND_API_TOKEN` is configured, send
`Authorization: Bearer {BACKEND_API_TOKEN}` from the Next.js server only.

## Copyable request

```http
POST /api/runs
Content-Type: application/json

{"shopTypes":["clothing","eyewear","baby food"]}
```

Accepted response:

```json
{
  "runId": "run_abcdefghijklmnop",
  "state": "queued",
  "statusUrl": "/api/runs/run_abcdefghijklmnop",
  "resultsUrl": "/api/runs/run_abcdefghijklmnop/results",
  "createdAt": "2026-07-31T12:00:00.000Z"
}
```

Poll `statusUrl` every three seconds. Stop for `completed`, `failed`, or
`cancelled`. Fetch `resultsUrl` only when `resultsAvailable` is `true`.

## TypeScript contract

```ts
type RunState = "queued" | "running" | "completed" | "failed" | "cancelled";
type LeadStatus = "qualified" | "rejected" | "failed";

type RunProgress = {
  shopTypesTotal: number;
  shopTypesProcessed: number;
  blankShopTypesSkipped: number;
  invalidShopTypes: number;
  queryCandidatesGenerated: number;
  queryCandidatesValidated: number;
  queryCandidatesProbed: number;
  queriesSelected: number;
  planningWarnings: number;
  queriesTotal: number;
  queriesProcessed: number;
  storesDiscovered: number;
  storesQualified: number;
  storesRejected: number;
  failures: number;
  outputRows: number;
};

type RunStatus = {
  runId: string;
  state: RunState;
  stage: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: RunProgress;
  resultsAvailable: boolean;
  error: { code: string; message: string } | null;
};

type Lead = {
  id: string;
  shop_type: string | null;
  generated_query: string | null;
  query_score: number | null;
  query_generation_reason: string | null;
  search_query: string | null;
  google_rank: number | null;
  google_result_url: string | null;
  myshopify_domain: string | null;
  final_url: string | null;
  canonical_url: string | null;
  resolved_domain: string | null;
  store_name: string | null;
  email: string | null;
  email_source_url: string | null;
  phone: string | null;
  phone_source_url: string | null;
  contact_url: string | null;
  social_profiles: string[];
  additional_information: string | null;
  shopify_confidence: number | null;
  relevance_score: number | null;
  lead_score: number | null;
  status: LeadStatus;
  rejection_reason: string | null;
  error: string | null;
};

type ResultPage = {
  runId: string;
  summary: {
    total: number;
    qualified: number;
    rejected: number;
    failed: number;
  };
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  items: Lead[];
};

type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
```

## Results, sorting, and export

Allowed query parameters are `page`, `pageSize`, `status`, `search`, `sortBy`,
and `sortDirection`. `pageSize` is 1–200. Allowed sorts are `lead_score`,
`store_name`, `shop_type`, and `google_rank`; directions are `asc` and `desc`.

JSON lead fields are snake_case. CSV export omits `id` and uses the header order
exported by `src/output.js`. Fetch every API page before “export all”; convert
null to an empty CSV cell and `JSON.stringify` `social_profiles`.

## Error handling

| Status | Frontend behavior |
|---:|---|
| `409 RUN_ALREADY_ACTIVE` | Link to the active `runId` from `details` when present |
| `409 RESULTS_NOT_READY` | Continue status polling; do not treat it as data loss |
| `409 RESULTS_UNAVAILABLE` | Show the run’s safe terminal error |
| `502` | Next.js could not reach the backend; offer retry |
| `503` | Backend database/configuration unavailable; offer retry |
| `504` | Next.js timed out; a POST outcome may be unknown, so do not blindly duplicate it |

Completed results have no scheduled application expiry. They remain available
while the Neon project and records are retained and the database remains
operational.
