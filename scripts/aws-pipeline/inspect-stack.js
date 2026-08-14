import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildDeploymentPacket, DEPLOYMENT } from "./create-change-set.js";

function fail(message) {
  throw new Error(message);
}

export function parseInspectArguments(argv) {
  const result = { expectedDisabled: false };
  for (const raw of argv) {
    if (raw === "--expected-disabled") result.expectedDisabled = true;
    else if (raw.startsWith("--") && raw.includes("=")) {
      const at = raw.indexOf("=");
      const key = raw.slice(2, at).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      if (Object.hasOwn(result, key) || !raw.slice(at + 1)) fail("Invalid or duplicate inspection argument");
      result[key] = raw.slice(at + 1);
    } else fail(`Unknown inspection argument: ${raw}`);
  }
  for (const key of ["profile", "region", "stack", "accountId"]) {
    if (!result[key]) fail(`Missing inspection argument: ${key}`);
  }
  if (!result.expectedDisabled || result.profile !== DEPLOYMENT.profile ||
      result.region !== DEPLOYMENT.region || result.stack !== DEPLOYMENT.stack ||
      !/^\d{12}$/u.test(result.accountId)) fail("Inspection identity does not match G14");
  return Object.freeze({ ...result, environment: DEPLOYMENT.environment, phase: "full" });
}

function aws(options, args, { allowFailure = false } = {}) {
  const command = [...args, "--profile", options.profile, "--region", options.region,
    "--no-cli-pager", "--output", "json"];
  const result = spawnSync("aws", command, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowFailure) return { failed: true, stderr: result.stderr || "" };
    fail(`Read-only AWS inspection failed: aws ${args.slice(0, 2).join(" ")}`);
  }
  try { return result.stdout.trim() ? JSON.parse(result.stdout) : {}; }
  catch { fail(`AWS inspection returned invalid JSON: aws ${args.slice(0, 2).join(" ")}`); }
}

function equal(left, right, message) {
  if (JSON.stringify(left) !== JSON.stringify(right)) fail(message);
}

function outputMap(stack) {
  return Object.fromEntries((stack.Outputs || []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
}

function assertPolicy(policy) {
  const statements = policy?.Statement || [];
  for (const statement of statements) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    if (statement.Effect === "Allow" && actions.some((action) => /^(?:s3|sqs):\*$/u.test(action))) {
      fail("Deployed IAM contains a broad data-plane action");
    }
    if (statement.Effect === "Allow" && actions.some((action) => /^(?:s3|sqs):/u.test(action)) &&
        resources.includes("*")) fail("Deployed IAM contains a wildcard data-plane resource");
  }
}

const queueExpectations = Object.freeze({
  Discovery: 1800, DiscoveryCheck: 1800, Lead: 540,
  LeadCheck: 1800, Traffic: 5410, TrafficCheck: 1800
});
const functionExpectations = Object.freeze({
  DiscoveryWorker: [300, 1], DomainAggregator: [300, 2], LeadWorker: [90, 2],
  LeadAggregator: [300, 2], TrafficWorker: [900, 1], FinalAggregator: [300, 2], Recovery: [300, 1]
});
const mappingExpectations = Object.freeze({
  DiscoveryWorker: [1, 0, null], DomainAggregator: [1, 0, 2], LeadWorker: [1, 0, 2],
  LeadAggregator: [1, 0, 2], TrafficWorker: [1000, 10, null], FinalAggregator: [1, 0, 2]
});

export async function inspect(options) {
  const identity = aws(options, ["sts", "get-caller-identity"]);
  if (identity.Account !== options.accountId) fail("STS account differs from the approved account");
  const packet = await buildDeploymentPacket(options);
  const described = aws(options, ["cloudformation", "describe-stacks", "--stack-name", options.stack]);
  const stack = described.Stacks?.[0];
  if (!stack || !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus)) {
    fail("Production stack is not complete");
  }
  const outputs = outputMap(stack);
  if (outputs.ArtifactBucketName !== packet.bucket) fail("Artifact bucket output drift");

  const listed = aws(options, ["cloudformation", "list-stack-resources", "--stack-name", options.stack]);
  const actualInventory = (listed.StackResourceSummaries || []).map(({ LogicalResourceId, ResourceType }) => ({
    logicalId: LogicalResourceId, type: ResourceType
  })).sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  equal(actualInventory, packet.full.resources, "Deployed stack resource inventory drift");

  const [versioning, encryption, publicAccess, ownership, lifecycle] = [
    aws(options, ["s3api", "get-bucket-versioning", "--bucket", packet.bucket]),
    aws(options, ["s3api", "get-bucket-encryption", "--bucket", packet.bucket]),
    aws(options, ["s3api", "get-public-access-block", "--bucket", packet.bucket]),
    aws(options, ["s3api", "get-bucket-ownership-controls", "--bucket", packet.bucket]),
    aws(options, ["s3api", "get-bucket-lifecycle-configuration", "--bucket", packet.bucket])
  ];
  if (versioning.Status !== "Enabled" ||
      encryption.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm !== "AES256" ||
      Object.values(publicAccess.PublicAccessBlockConfiguration || {}).some((value) => value !== true) ||
      ownership.OwnershipControls?.Rules?.[0]?.ObjectOwnership !== "BucketOwnerEnforced") {
    fail("Artifact bucket security settings drift");
  }
  const lifecycleRules = lifecycle.Rules || [];
  if (lifecycleRules.length !== 1 || lifecycleRules[0].Status !== "Enabled" ||
      lifecycleRules[0].AbortIncompleteMultipartUpload?.DaysAfterInitiation !== 7 ||
      lifecycleRules[0].Expiration || lifecycleRules[0].NoncurrentVersionExpiration) {
    fail("Artifact bucket lifecycle drift");
  }

  let sourceMessages = 0;
  let dlqMessages = 0;
  for (const [id, visibility] of Object.entries(queueExpectations)) {
    const queueUrl = outputs[`${id}QueueUrl`];
    if (!queueUrl) fail(`Missing queue output: ${id}`);
    const attrs = aws(options, ["sqs", "get-queue-attributes", "--queue-url", queueUrl,
      "--attribute-names", "All"]).Attributes || {};
    if (Number(attrs.VisibilityTimeout) !== visibility || Number(attrs.MessageRetentionPeriod) !== 345600 ||
        attrs.SqsManagedSseEnabled !== "true" || Number(JSON.parse(attrs.RedrivePolicy).maxReceiveCount) !== 5) {
      fail(`Source queue attribute drift: ${id}`);
    }
    sourceMessages += Number(attrs.ApproximateNumberOfMessages || 0) +
      Number(attrs.ApproximateNumberOfMessagesNotVisible || 0) +
      Number(attrs.ApproximateNumberOfMessagesDelayed || 0);
    const dlqUrl = aws(options, ["sqs", "get-queue-url", "--queue-name",
      outputs[`${id}DlqArn`].split(":").at(-1)]).QueueUrl;
    const dlq = aws(options, ["sqs", "get-queue-attributes", "--queue-url", dlqUrl,
      "--attribute-names", "All"]).Attributes || {};
    if (Number(dlq.MessageRetentionPeriod) !== 1209600 || dlq.SqsManagedSseEnabled !== "true") {
      fail(`DLQ attribute drift: ${id}`);
    }
    dlqMessages += Number(dlq.ApproximateNumberOfMessages || 0) +
      Number(dlq.ApproximateNumberOfMessagesNotVisible || 0) +
      Number(dlq.ApproximateNumberOfMessagesDelayed || 0);
  }
  if (sourceMessages || dlqMessages) fail("Expected-disabled queues are not empty");

  let mappings = 0;
  for (const [id, [timeout, reserved]] of Object.entries(functionExpectations)) {
    const arn = outputs[`${id}FunctionArn`];
    const config = aws(options, ["lambda", "get-function-configuration", "--function-name", arn]);
    const concurrency = aws(options, ["lambda", "get-function-concurrency", "--function-name", arn]);
    if (config.Runtime !== "nodejs24.x" || config.Architectures?.[0] !== "x86_64" ||
        config.MemorySize !== 512 || config.Timeout !== timeout || config.EphemeralStorage?.Size !== 512 ||
        concurrency.ReservedConcurrentExecutions !== reserved) fail(`Lambda configuration drift: ${id}`);
    const envKeys = Object.keys(config.Environment?.Variables || {}).sort();
    if (envKeys.some((key) => /(?:TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL|API_KEY)/u.test(key)) ||
        envKeys.includes("AWS_REGION")) fail(`Lambda environment privacy drift: ${id}`);
    const expected = mappingExpectations[id];
    const eventMappings = aws(options, ["lambda", "list-event-source-mappings", "--function-name", arn])
      .EventSourceMappings || [];
    if (!expected) {
      if (eventMappings.length) fail("Recovery function unexpectedly has an event mapping");
    } else {
      if (eventMappings.length !== 1) fail(`Mapping cardinality drift: ${id}`);
      const mapping = eventMappings[0];
      if (mapping.State !== "Disabled" || mapping.BatchSize !== expected[0] ||
          mapping.MaximumBatchingWindowInSeconds !== expected[1] ||
          !mapping.FunctionResponseTypes?.includes("ReportBatchItemFailures") ||
          (expected[2] === null ? mapping.ScalingConfig?.MaximumConcurrency != null :
            mapping.ScalingConfig?.MaximumConcurrency !== expected[2])) fail(`Mapping drift: ${id}`);
      mappings += 1;
    }
    const logGroup = `/aws/lambda/${options.stack}-${DEPLOYMENT.handlers.find(([logical]) => logical === id)[1]}`;
    const streams = aws(options, ["logs", "describe-log-streams", "--log-group-name", logGroup,
      "--limit", "1"]).logStreams || [];
    if (streams.length) fail(`Unexpected G14 Lambda activity: ${id}`);
  }
  if (mappings !== 6) fail("Expected six disabled mappings");

  const rule = aws(options, ["events", "describe-rule", "--name", outputs.RecoveryScheduleName]);
  if (rule.State !== "DISABLED" || rule.ScheduleExpression !== "rate(5 minutes)") {
    fail("Recovery schedule drift");
  }
  const targets = aws(options, ["events", "list-targets-by-rule", "--rule", outputs.RecoveryScheduleName]);
  if (targets.Targets?.length !== 1) fail("Recovery target drift");

  const secret = aws(options, ["secretsmanager", "describe-secret", "--secret-id", outputs.PipelineSecretArn]);
  if (Object.keys(secret.VersionIdsToStages || {}).length) fail("G14 secret unexpectedly has a version");
  const value = aws(options, ["secretsmanager", "get-secret-value", "--secret-id", outputs.PipelineSecretArn],
    { allowFailure: true });
  if (!value.failed || !/ResourceNotFoundException|no version/iu.test(value.stderr)) {
    fail("G14 secret is not provably empty");
  }

  for (const summary of listed.StackResourceSummaries || []) {
    if (summary.ResourceType !== "AWS::IAM::Role") continue;
    const policies = aws(options, ["iam", "list-role-policies", "--role-name", summary.PhysicalResourceId]);
    equal(policies.PolicyNames, ["PipelineAccess"], `IAM inline-policy drift: ${summary.LogicalResourceId}`);
    const policy = aws(options, ["iam", "get-role-policy", "--role-name", summary.PhysicalResourceId,
      "--policy-name", "PipelineAccess"]);
    assertPolicy(policy.PolicyDocument);
  }

  const alarmNames = (listed.StackResourceSummaries || []).filter(({ ResourceType }) =>
    ResourceType === "AWS::CloudWatch::Alarm").map(({ PhysicalResourceId }) => PhysicalResourceId);
  if (alarmNames.length !== 27) fail("Alarm cardinality drift");
  const alarms = aws(options, ["cloudwatch", "describe-alarms", "--alarm-names", ...alarmNames]).MetricAlarms || [];
  if (alarms.length !== 27 || alarms.some(({ AlarmActions }) => AlarmActions?.length)) {
    fail("Alarm definition drift");
  }

  return Object.freeze({ outcome: "EXPECTED_DISABLED_STACK_VERIFIED", accountId: identity.Account,
    region: options.region, stack: options.stack, resources: actualInventory.length, queues: 6,
    dlqs: 6, functions: 7, disabledMappings: mappings, disabledRecoveryRule: true,
    emptySecret: true, emptySourceMessages: sourceMessages, emptyDlqMessages: dlqMessages, alarms: 27 });
}

export async function main(argv = process.argv.slice(2)) {
  const result = await inspect(parseInspectArguments(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || "G14 inspection failed"}\n`);
    process.exitCode = 1;
  });
}
