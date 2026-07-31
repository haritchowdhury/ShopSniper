# Authentication, Run Ownership, and Search Continuation Plan

## Status

Implemented in the backend and frontend source on 31 July 2026. The reviewed
Prisma migration is present but has not been applied to an unidentified/live
Neon branch by this implementation pass. Neon Auth must still be enabled in the
target Neon project and its two environment variables configured before live
authentication can work.

This plan supersedes two first-version decisions in
`BACKEND_FRONTEND_HANDOFF_IMPLEMENTATION_PLAN.md`:

- the application will now have user accounts; and
- the database may contain multiple queued runs, while the worker still executes
  only one run at a time.

All other scraper, JSON-result, pagination, polling, and CSV-export behavior stays
the same.

## Goal

Add simple email/password authentication so that:

- a visitor can enter a search before creating an account;
- an unauthenticated visitor is asked to sign up or sign in after submitting;
- the submitted search survives that authentication step;
- both a newly registered user and a returning signed-out user are redirected to
  the resulting `/runs/{runId}` page;
- every run and lead-result request is restricted to its owner; and
- an authenticated user can see a paginated history of all their runs.

## Recommended execution ownership

Implement the backend and frontend as one coordinated change, but keep the work
separated by an explicit API contract.

Recommended order:

1. Backend schema, ownership rules, pending-intent API, listing API, and serial
   queue.
2. Backend contract tests.
3. Frontend authentication and identity propagation.
4. Frontend continuation, run-history UI, and tests.
5. End-to-end verification using two separate user accounts.

The frontend-specific instructions are in
`../frontend/AUTH_FRONTEND_AGENT_HANDOFF.md`. A frontend agent can use that file
after the backend contract described here is stable.

## Fixed technical decisions

- Use Neon Auth with email/password. It is database-backed and uses the existing
  Neon project; do not build password hashing or session management manually.
- Pin the selected `@neondatabase/auth` version after checking its current
  Next.js 16 documentation. Do not code from older Neon Auth examples.
- Authentication and browser sessions live in the Next.js frontend/BFF.
- The scraper backend remains a private service authenticated by
  `BACKEND_API_TOKEN`; it does not receive browser cookies.
- Next.js derives the authenticated user ID from the server-side session and
  forwards it as `X-User-Id` only on authenticated server-to-server calls.
- Never accept `ownerId` or `userId` from browser JSON, query parameters, form
  fields, or route parameters.
- Anonymous submission creates a cheap, expiring `RunIntent`; it does not invoke
  Google, OpenAI, Browserless, or storefront fetching.
- The actual `Run` is created only after authentication succeeds.
- Store only an opaque intent ID in a secure HTTP-only cookie. Do not put search
  categories in cookies, local storage, or authentication metadata.
- Keep the existing opaque run slug. A slug is an identifier, not an
  authorization mechanism.
- Return `404 RUN_NOT_FOUND` for missing and foreign-owned runs so the API does
  not reveal another user's run IDs.
- Existing unowned runs remain inaccessible unless they are explicitly assigned
  to a user during migration.
- For v0.1, execute one run at a time but allow multiple database-backed queued
  runs. Do not introduce SQS solely for this auth change.

## Target request flow

### Authenticated submission

1. The browser submits `POST /api/runs` to Next.js.
2. Next.js validates the session and obtains `session.user.id`.
3. Next.js proxies the existing request to the backend with the service token and
   `X-User-Id`.
4. The backend creates an owned queued run and returns `202` with `runId`.
5. The browser redirects directly to `/runs/{runId}`.

### Anonymous submission followed by sign-up or sign-in

1. The browser submits `POST /api/runs` to Next.js.
2. Next.js finds no authenticated session and asks the backend to create a
   validated `RunIntent`.
3. Next.js stores the returned opaque intent ID in the
   `storesignal_pending_run_intent` HTTP-only cookie.
4. Next.js returns `401 AUTHENTICATION_REQUIRED` with a fixed internal
   `continueUrl` such as `/sign-up`.
5. The browser opens the sign-up screen. The screen also links to sign-in.
6. Successful sign-up or sign-in redirects to `/runs/continue`.
7. `/runs/continue` calls `POST /api/run-intents/claim`.
8. Next.js reads the authenticated session and pending-intent cookie, then calls
   the backend claim endpoint with `X-User-Id`.
9. The backend atomically creates the owned run and records its ID on the intent.
10. Next.js clears the pending cookie and returns the run response.
11. The browser replaces the continuation URL with `/runs/{runId}`.

The claim operation must be idempotent. A callback retry, browser reload, or
React development remount returns the same run to the same user and never starts
a duplicate.

## Phase 1: Enable Neon Auth

### Work

1. Enable Neon Auth on the same Neon project/branch used by the application.
2. Add the current pinned Neon Auth SDK to `frontend/package.json`.
3. Configure server-only values in Vercel and `.env.local`:

   ```text
   NEON_AUTH_BASE_URL=<branch auth endpoint>
   NEON_AUTH_COOKIE_SECRET=<at least 32 random characters>
   ```

4. Add only safe placeholders to `frontend/.env.example`.
5. Create the central server auth instance and the client auth instance.
6. Mount the Neon Auth handler under `/api/auth/[...path]` using the API exposed
   by the pinned SDK.
7. Add minimal email/password sign-up, sign-in, and sign-out UI.
8. Use a fixed internal continuation route. Do not accept an arbitrary external
   redirect URL from query parameters.

### v0.1 account policy

For a private or access-controlled v0.1, email/password signup may establish a
session immediately. Before a public launch, require verified email or add an
equivalent abuse control before an account can claim an intent and consume paid
scraping APIs. Password-reset email must be configured before presenting the
application as production-ready.

### Exit condition

A user can sign up, sign in, sign out, and retrieve a valid user ID from a
server-side Next.js request.

## Phase 2: Add ownership and pending intents to Prisma

### Run changes

Add an initially nullable owner ID so the migration does not fail on existing
rows:

```prisma
model Run {
  id      String  @id
  ownerId String?

  // existing fields remain unchanged

  @@index([ownerId, createdAt])
}
```

All newly created HTTP runs must have a non-empty owner ID. The nullable state is
only for legacy migration compatibility. After old rows are assigned or
intentionally abandoned, a later migration may make `ownerId` required.

Do not add an application `User` model or a cross-schema Prisma relation to the
Neon Auth user table in this version. Treat the auth user ID as an opaque stable
string. This avoids sync webhooks and schema coupling.

### RunIntent model

Add an intent model equivalent to:

```prisma
model RunIntent {
  id                  String   @id
  normalizedShopTypes Json
  createdAt           DateTime @default(now())
  expiresAt           DateTime
  claimedByUserId     String?
  claimedRunId        String?  @unique

  @@index([expiresAt])
}
```

Intent IDs must contain at least 192 bits of cryptographic randomness and use a
distinct `intent_` prefix. Default expiry is one hour.

### Queue migration

The existing partial unique index treats both `queued` and `running` as globally
active. Replace it with a constraint/claim strategy that permits many queued
rows but permits only one running row.

The database, not an in-process Boolean, must arbitrate the transition from
`queued` to `running`.

### Legacy data

- Leave existing `ownerId = NULL` runs invisible through authenticated APIs.
- Optionally assign selected historical runs to the first administrative user
  with a reviewed one-time SQL migration.
- Never expose unowned runs merely because the requester is authenticated.

### Exit condition

The schema represents owned runs, expiring anonymous intents, and multiple
queued jobs without allowing multiple running jobs.

## Phase 3: Make the backend identity-aware

### Trusted user context

After validating `BACKEND_API_TOKEN`, extract `X-User-Id` for endpoints that act
on user data. Reject missing, repeated, blank, or unreasonably long values.

`X-User-Id` is valid only because the backend service token authenticates the
Next.js BFF. Production must not run with an empty backend service token.

### Repository signatures

Change or add repository operations along these lines:

```text
createRun(ownerId, normalizedShopTypes)
createRunIntent(normalizedShopTypes, expiresAt)
claimRunIntent(intentId, ownerId)
listRuns(ownerId, pagination)
getRun(runId, ownerId)
getResultsPage(runId, ownerId, filters)
getActiveRunForOwner(ownerId)
claimNextQueuedRun()
recoverInterruptedRuns()
```

Internal worker methods that already possess a trusted `runId` may continue to
operate by run ID. Public reads must always include ownership.

### Atomic intent claim

`claimRunIntent` must use a transaction:

1. Read/lock the intent.
2. Reject an expired or missing intent.
3. If already claimed by the same user, return the existing run.
4. If claimed by a different user, behave as not found.
5. Create one queued `Run` with `ownerId` and the normalized categories.
6. Store both `claimedByUserId` and `claimedRunId` on the intent.
7. Commit and return the run.

Concurrent claims must not create two runs.

### Ownership behavior

- `GET /api/runs/{runId}` filters by `id + ownerId`.
- `GET /api/runs/{runId}/results` verifies the owned run before returning leads.
- Lead pagination remains keyed by `runId` only after ownership has been proven
  in the same request path.
- `RUN_ALREADY_ACTIVE` must never expose another user's run ID. The new serial
  queue should normally eliminate this response for run creation.

### Exit condition

Two users cannot read, export, list, or infer each other's runs through any
public backend endpoint.

## Phase 4: Add the backend API contract

All routes below continue to require the server-to-server bearer token.

### Create anonymous intent

```http
POST /api/run-intents
Content-Type: application/json

{"shopTypes":["Independent eyewear"]}
```

```http
HTTP/1.1 201 Created
```

```json
{
  "intentId": "intent_<opaque>",
  "expiresAt": "2026-07-31T13:00:00.000Z"
}
```

This endpoint does not accept or require `X-User-Id` and never starts the
pipeline.

### Claim intent

```http
POST /api/run-intents/{intentId}/claim
X-User-Id: <trusted auth user id>
```

Return the existing `StartRunResponse` shape with `201` for the first claim and
`200` for an idempotent replay. Either response contains the same `runId`.

### Create authenticated run

The existing `POST /api/runs` body remains unchanged but now requires
`X-User-Id`. It returns `202 StartRunResponse`.

### List the current user's runs

```http
GET /api/runs?page=1&pageSize=20
X-User-Id: <trusted auth user id>
```

Return newest first:

```json
{
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 1,
    "totalPages": 1
  },
  "items": [
    {
      "runId": "run_<opaque>",
      "shopTypes": ["Independent eyewear"],
      "state": "queued",
      "stage": "queued",
      "createdAt": "2026-07-31T12:00:00.000Z",
      "startedAt": null,
      "completedAt": null,
      "progress": {},
      "resultsAvailable": false,
      "summary": null,
      "error": null
    }
  ]
}
```

Accept only `page` and `pageSize`; cap page size at 100.

### Error behavior

Add safe errors for:

```text
USER_CONTEXT_REQUIRED       401
AUTHENTICATION_REQUIRED     401 (Next.js BFF response to the browser)
INTENT_NOT_FOUND            404
INTENT_EXPIRED              410
RUN_NOT_FOUND               404 (also used for foreign-owned runs)
```

Do not include owner IDs, auth details, or foreign run IDs in error payloads.

## Phase 5: Replace the single-active-run rejection with a serial queue

### Work

1. Creating or claiming a run always persists a `queued` row and returns its
   slug immediately.
2. A dispatcher atomically claims the oldest queued run only when no run is
   currently `running`.
3. Completion or failure triggers another dispatch attempt.
4. On startup, mark only interrupted `running` rows failed. Preserve queued rows
   and resume dispatching them.
5. Multiple backend processes must not claim the same row or run two jobs at
   once. Use a transaction plus row/advisory locking or an equivalent PostgreSQL
   claim.
6. The run page continues polling while a job waits in `queued`.

This is deliberately a serial database queue for v0.1. SQS/Lambda workers can
replace the dispatcher later without changing user ownership or public URLs.

### Exit condition

Every authenticated submission receives a durable run slug even when another
user's run is already executing.

## Phase 6: Frontend integration

Follow `../frontend/AUTH_FRONTEND_AGENT_HANDOFF.md` exactly. The frontend must:

- integrate Neon Auth using the pinned SDK's current Next.js 16 API;
- keep the search form available before login;
- create an intent for anonymous submissions;
- maintain the intent ID in an HTTP-only cookie;
- send authenticated identity only from server-side Route Handlers;
- redirect both sign-up and sign-in through `/runs/continue`;
- protect run pages and APIs;
- add `/runs` as the user's run history; and
- preserve the existing run workspace, polling, filtering, and CSV export.

## Phase 7: Tests and verification

### Backend automated tests

- A run is created with the trusted user ID, never a body-supplied ID.
- Missing user context is rejected on owned endpoints.
- User A cannot read User B's run status or results.
- User A's run listing excludes User B and legacy unowned runs.
- An intent performs no scraper/API work before claim.
- An expired intent cannot be claimed.
- Two parallel claims produce exactly one run.
- A repeated same-user claim returns the same run.
- A different user cannot reclaim an intent.
- Multiple queued runs are accepted and processed serially.
- Restart recovery fails interrupted running work but preserves queued work.
- Error responses never reveal another user's run ID.

### Frontend automated tests

- Authenticated submission redirects directly to the new run slug.
- Anonymous submission creates the pending cookie and navigates to sign-up.
- Both sign-up and sign-in continue to `/runs/continue`.
- Successful claim clears the cookie and replaces the URL with the run slug.
- Claim retry/reload does not duplicate a run.
- Protected BFF routes return `401` without a session.
- The BFF ignores any browser-supplied `X-User-Id` and injects only the session
  user ID.
- `/runs` renders only the authenticated user's paginated history.
- A foreign or nonexistent slug has indistinguishable not-found behavior.
- Existing polling and CSV tests continue to pass.

### Manual two-user acceptance test

1. As a signed-out new user, enter a search, sign up, and confirm redirect to its
   slug.
2. Sign out, enter a different search, sign in to the same account, and confirm
   redirect to the new slug.
3. While signed in, submit another search and confirm direct redirect.
4. Create another account in a private window and create a run.
5. Confirm each account's `/runs` page shows only its own runs.
6. Paste one account's slug into the other account and confirm `404` behavior.
7. Start searches close together and confirm both receive slugs, one waits in
   `queued`, and execution remains serial.
8. Export a completed owned run and confirm the CSV remains unchanged.

## Deployment sequence

1. Enable Neon Auth on a development branch and configure frontend development
   secrets.
2. Apply the additive schema/queue migration to the development branch.
3. Deploy and test the backend contract first.
4. Deploy the frontend to a preview environment connected to that backend.
5. Complete the two-user acceptance test.
6. Apply the reviewed migration to production.
7. Deploy the backend, then the frontend.
8. Monitor authentication failures, intent expiry, queue depth, claim retries,
   and cross-user authorization denials without logging tokens or user emails.

## Definition of done

The work is complete when an anonymous visitor can submit a search, either create
an account or sign in, and reliably land on the one owned run slug created from
that search; signed-in users can see all and only their own runs; foreign run
slugs are inaccessible; and concurrent submissions queue safely without changing
the scraper's existing result behavior.
