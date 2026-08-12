# AWS pipeline operations

Neon is the coordinator and sole completion authority. SQS is an at-least-once
trigger transport. S3 contains private immutable evidence; object counts and S3
events never establish completion.

## Safe inspection

Use CloudWatch structured events and identifiers only: `runId`, stage,
generation, task/item ID, safe code, counts, attempts, and durations. In Neon,
inspect the selected Run, PipelineStage, PipelineTask, and paid-ledger state by
exact ID. In S3, inspect object metadata and deterministic keys before reading a
bounded validated artifact. In SQS/DLQs, inspect a bounded number of message
identity envelopes and redrive selected messages; never print provider bodies,
HTML, contacts, credentials, tokens, authorization headers, or secret-bearing
URLs.

Alarm on queue age, DLQ depth, Lambda errors/throttles/duration, stale
collecting/ready stages, expired leases, paid ambiguity, artifact conflicts, and
recovery failures. Initial discovery and traffic Lambda reserved concurrency
remain one. Do not set event-source `MaximumConcurrency=1`.

## Recovery and cancellation

Scheduled recovery reconstructs messages only from durable task/stage rows and
is bounded to 100 rows. It marks stale in-flight DataForSEO requests ambiguous
before requeueing. It never lists S3, infers queue emptiness, retries paid
ambiguity, or invents work.

Cancel only with the guarded internal command:

```text
node scripts/cancel-aws-run.js --run-id RUN_ID --generation N --confirm RUN_ID:N
```

The command atomically cancels the exact generation and prints only safe counts.
It preserves private checkpoints, immutable artifacts, profiles, Leads, and
owner history. Late worker and aggregator tokens are fenced.

## Kill switch and rollback

Disable the relevant Lambda event-source mappings, then disable scheduled
recovery. Route new runs to the local backend through the existing server-side
control only after the separately approved cutover procedure. Preserve already
committed private checkpoints. A ready stage can be recovered; an ambiguous
paid request requires operator/provider reconciliation; an artifact conflict
requires investigation and no overwrite; a cancelled Run stays cancelled.

Never purge a queue or DLQ, delete a bucket/prefix/object, clean database rows,
edit coordinator counters manually, overwrite an artifact, output secrets, or
automatically resend paid ambiguous work. G14/G15 production creation,
credentials, provider smoke calls, mappings, deployment, and cutover require
their separate approvals.
