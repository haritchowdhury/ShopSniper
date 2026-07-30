# AWS Async Deployment Direction

## Objective

Deploy the lead-generation workflow behind a separate frontend while supporting
jobs that can run for 30 minutes or longer across multiple shop categories.

The frontend must start work asynchronously, receive a run identifier immediately,
track progress, and download the query audit and lead CSVs after completion.

## Core decision

Do not place the complete workflow inside one Lambda invocation.

AWS Lambda has a maximum execution time of 15 minutes. The recommended first
production architecture is:

- API Gateway and Lambda for the API/control plane
- Step Functions Standard for durable orchestration
- ECS Fargate for the current long-running Node.js worker
- DynamoDB for run status
- S3 for inputs, intermediate artifacts, and outputs
- Secrets Manager for external API credentials
- A separately deployed static frontend

This hybrid architecture is the leanest path because the proven Node.js pipeline
can initially run almost unchanged inside a Fargate container. Individual stages
can later move to Lambda when scaling data shows that the additional distribution
is worthwhile.

AWS references:

- Lambda execution limits:
  https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
- Step Functions workflow types:
  https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html
- Step Functions with ECS/Fargate:
  https://docs.aws.amazon.com/step-functions/latest/dg/connect-ecs.html

## Recommended first architecture

```text
Static frontend
S3 + CloudFront or Amplify
            |
            v
    API Gateway HTTP API
            |
   POST /runs | GET /runs/:id
            |
            v
     Run-control Lambda
       |            |
       v            v
   DynamoDB      Step Functions Standard
   run status            |
                         v
                 ECS Fargate worker
                 current Node.js flow
                         |
              +----------+----------+
              |                     |
              v                     v
      Query audit in S3       Leads CSV in S3
              |
              v
       Presigned download URLs
```

## Why Step Functions Standard

Use a Standard Workflow, not Express.

- Standard supports durable, auditable workflows lasting up to one year.
- Express workflows have a five-minute maximum duration.
- Standard provides execution history, retries, catches, cancellation, and native
  Fargate integration.
- The state machine can run the worker with `ecs:runTask.sync` and wait without
  keeping an API request open.

The state machine should pass S3 object keys between stages rather than large
payloads. Step Functions limits task, state, and execution input/output to 256 KiB:

https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html

## Frontend API contract

### Start a run

```http
POST /runs
Content-Type: application/json
Authorization: Bearer <token>

{
  "shopTypes": ["eyewear", "clothing", "baby food"]
}
```

Immediate response:

```http
HTTP/1.1 202 Accepted
```

```json
{
  "runId": "run_01...",
  "state": "queued",
  "statusUrl": "/runs/run_01..."
}
```

The request must only validate the input, create the run record, start the state
machine, and return. It must not wait for query planning or lead extraction.

### Read status

```http
GET /runs/{runId}
Authorization: Bearer <token>
```

Example running response:

```json
{
  "state": "running",
  "stage": "extracting_leads",
  "shopTypesTotal": 3,
  "shopTypesProcessed": 1,
  "queryCandidatesGenerated": 50,
  "queryCandidatesProbed": 50,
  "queriesSelected": 20,
  "storesDiscovered": 146,
  "storesQualified": 82,
  "failures": 2
}
```

Example completed response:

```json
{
  "state": "completed",
  "leadsDownloadUrl": "<temporary-presigned-url>",
  "queryAuditDownloadUrl": "<temporary-presigned-url>"
}
```

### Additional endpoints

```text
GET  /runs
GET  /runs/{runId}
POST /runs/{runId}/cancel
GET  /runs/{runId}/downloads
```

Polling every three to five seconds is sufficient for the first frontend.
WebSockets or push notifications can be added later.

## Frontend direction

The frontend can be developed and deployed separately:

- React, Next.js, or Vite
- S3 and CloudFront, or AWS Amplify Hosting
- Cognito/JWT authentication
- Category entry and optional one-column CSV upload
- Run history
- Stage and counter display
- Cancellation
- Lead and query-audit download actions

Keep the S3 buckets private. Return time-limited presigned URLs for downloads:

https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html

## How the current implementation maps to AWS

| Current component | AWS direction |
|---|---|
| `src/pipeline.js` | Initial Fargate worker entry point |
| `src/query-planner.js` | Planning stage; later separable by category |
| Google query probing | Initially remains in Fargate; later Step Functions Map |
| Domain resolution | Initially remains in Fargate; later one Lambda per result |
| Store extraction | Initially remains in Fargate; later one Lambda per store |
| Mutable in-memory status | DynamoDB run record |
| Input CSV | S3 object or API-provided category list |
| In-memory probe cache | Run-scoped S3 manifest |
| Local output writer | S3 output adapter |
| `src/server.js` | Replaced by API Gateway Lambda handlers in AWS |
| `src/run-once.js` | Fargate container command |
| `.env` credentials | AWS Secrets Manager |

Most discovery, validation, extraction, ranking, and scoring modules remain useful
without significant changes.

The main refactor is to introduce infrastructure adapters:

```text
storage
  local filesystem adapter
  S3 adapter

run repository
  in-memory/local status adapter
  DynamoDB adapter

secrets
  local .env adapter
  Secrets Manager adapter

worker entry point
  local run-once entry point
  Fargate task entry point
```

## DynamoDB run record

Recommended fields:

```text
runId
userId
state
stage
executionArn
inputS3Key
queryAuditS3Key
leadsS3Key
shopTypesTotal
shopTypesProcessed
queryCandidatesGenerated
queryCandidatesValidated
queryCandidatesProbed
queriesSelected
queriesProcessed
storesDiscovered
storesQualified
storesRejected
failures
createdAt
startedAt
completedAt
error
version
```

Use conditional updates or a version field so concurrent status updates do not
silently overwrite one another.

## S3 artifact structure

Example:

```text
runs/{runId}/input/categories.csv
runs/{runId}/planning/research.json
runs/{runId}/planning/probes.json
runs/{runId}/planning/selected-queries.json
runs/{runId}/output/generated-queries.csv
runs/{runId}/output/leads.csv
runs/{runId}/output/summary.json
```

Enable bucket encryption, block public access, and define a lifecycle rule for old
run artifacts.

## Secrets and networking

Store these values in Secrets Manager:

```text
OPENAI_API_KEY
GOOGLE_API_KEY
GOOGLE_SEARCH_ENGINE_ID
BROWSERLESS_TOKEN
BROWSERLESS_FALLBACK_TOKEN
```

Use least-privilege IAM permissions for each Lambda and Fargate task. Do not place
secret values in state-machine input, DynamoDB status records, S3 artifacts, logs,
or frontend responses.

AWS Secrets Manager guidance:

https://docs.aws.amazon.com/lambda/latest/dg/with-secrets-manager.html

The worker needs outbound internet access for OpenAI, Google, Browserless, Shopify,
and merchant domains. If it is placed in private VPC subnets, it will need
appropriate NAT egress. NAT cost should be included in the deployment decision.

## Reliability requirements

Every task must be idempotent because retries are expected.

Recommended keys:

```text
runId + shopType
runId + generatedQuery
runId + Google result URL
runId + resolvedDomain
```

Other requirements:

- Persist stage outputs before marking the stage complete.
- Retry timeouts, rate limits, and transient `5xx` responses with bounded backoff.
- Do not retry deterministic input/schema failures.
- Preserve partial successes.
- Configure Step Functions `Retry` and `Catch` rules.
- Write failure records into the lead or query audit when useful.
- Support cancellation through `StopExecution`.
- Include `runId`, `shopType`, `query`, and `resolvedDomain` in structured logs.
- Add CloudWatch alarms for failed executions and elevated error rates.

## Eventual all-Lambda architecture

When volume justifies finer-grained scaling, split the worker into bounded stages:

```text
Normalize input
      |
      v
Map: research and generate per category
      |
      v
Map: probe each candidate query
      |
      v
Select diverse queries
      |
      v
Map: resolve each Google result
      |
      v
Deduplicate resolved domains
      |
      v
Map: extract one store
      |
      v
Aggregate, score, and write CSVs
```

Each Lambda invocation must remain comfortably under 15 minutes.

Recommended initial concurrency:

```text
Category research:   2
Google probing:      3
Domain resolution:   5-10
Store extraction:    5
Browserless calls:   2-3
```

These are protective starting points. Tune them from observed API quotas, error
rates, latency, and cost.

Step Functions Inline Map supports up to 40 concurrent iterations:

https://docs.aws.amazon.com/step-functions/latest/dg/state-map-inline.html

Distributed Map supports larger S3-backed datasets and much higher concurrency:

https://docs.aws.amazon.com/step-functions/latest/dg/state-map-distributed.html

Never accept the maximum Distributed Map concurrency by default. External API and
merchant-site limits are substantially lower and must determine the actual
concurrency.

## When to add SQS

Step Functions is sufficient for the first orchestration layer.

Add SQS when the system needs:

- Explicit worker backpressure
- Independent replay of failed work items
- Multiple worker implementations consuming the same task type
- Very large bursts that should drain gradually
- A dead-letter queue for long-lived failures

If SQS triggers Lambda, implement partial batch responses so successfully processed
messages are not retried when one message fails:

https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html

## Delivery phases

### Phase 1: Cloud-ready application boundaries

- Add S3 storage and DynamoDB run-repository interfaces.
- Preserve local filesystem and in-memory adapters for development.
- Move credentials behind a secrets provider.
- Add `runId` to logs and persisted artifacts.
- Make stage operations explicitly idempotent.

### Phase 2: Asynchronous hybrid deployment

- Add a Fargate-compatible container entry point.
- Add a Dockerfile and health/exit conventions.
- Create the Step Functions Standard workflow.
- Create the run-control and status Lambdas.
- Add API Gateway routes.
- Store input/output artifacts in S3.
- Store run state in DynamoDB.
- Add IAM, Secrets Manager, and CloudWatch configuration.

### Phase 3: Frontend

- Add authentication.
- Create the category/run form.
- Add progress polling and run history.
- Add cancellation.
- Add presigned result downloads.
- Handle partial-success and failed states clearly.

### Phase 4: Parallelization and cost tuning

- Measure planning, resolution, and extraction time separately.
- Identify the actual bottleneck.
- Split store resolution or extraction into Lambda Map workers first.
- Add SQS only when explicit queue backpressure is needed.
- Tune concurrency from Google, OpenAI, Browserless, and merchant-site behavior.
- Compare Fargate and Lambda cost using representative runs.

## Definition of done

The first asynchronous AWS version is complete when:

1. A signed-in frontend user can submit one or more shop types.
2. The API returns `202 Accepted` with a unique run identifier.
3. The workflow continues after the browser closes.
4. A run can safely exceed 30 minutes.
5. The frontend can retrieve reliable stage and counter information.
6. Failures remain isolated and auditable.
7. Outputs are stored privately in S3.
8. The frontend receives expiring download URLs.
9. Credentials never appear in logs, state, artifacts, or frontend responses.
10. Repeated or retried tasks do not create duplicate leads.

## Recommended implementation order

Start with the hybrid Fargate worker architecture. It provides asynchronous,
long-running execution with the least change to the proven workflow.

Do not begin by decomposing every operation into Lambda functions. Introduce the
cloud storage, status, secrets, and orchestration boundaries first. Move individual
stages to Lambda only after production measurements identify where that additional
parallelism creates a meaningful reliability, latency, or cost improvement.
