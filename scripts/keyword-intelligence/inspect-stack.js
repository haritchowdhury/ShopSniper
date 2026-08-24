import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDeploymentPacket, DEPLOYMENT } from "./create-change-set.js";

const templatePath = fileURLToPath(new URL("../../infrastructure/aws/template.yaml", import.meta.url));

const READ_ONLY_AWS_COMMANDS = new Set([
  "sts get-caller-identity",
  "cloudformation describe-stacks",
  "cloudformation list-stack-resources",
  "sqs get-queue-attributes",
  "sqs get-queue-url",
  "lambda get-function-configuration",
  "lambda get-function-concurrency",
  "lambda list-event-source-mappings",
  "logs describe-log-groups",
  "logs describe-log-streams",
  "iam list-role-policies",
  "iam get-role-policy",
  "iam get-policy",
  "iam get-policy-version",
  "cloudwatch describe-alarms"
]);

const QUEUES = Object.freeze([
  Object.freeze({ logicalId: "Discovery", slug: "discovery", visibility: 1800 }),
  Object.freeze({ logicalId: "DiscoveryCheck", slug: "discovery-check", visibility: 1800 }),
  Object.freeze({ logicalId: "Lead", slug: "lead", visibility: 540 }),
  Object.freeze({ logicalId: "LeadCheck", slug: "lead-check", visibility: 1800 }),
  Object.freeze({ logicalId: "Traffic", slug: "traffic", visibility: 5410 }),
  Object.freeze({ logicalId: "TrafficCheck", slug: "traffic-check", visibility: 1800 }),
  Object.freeze({ logicalId: "KeywordResearch", slug: "keyword-research", visibility: 1080 })
]);

const FUNCTIONS = Object.freeze([
  Object.freeze({ logicalId: "DiscoveryWorker", suffix: "discovery-worker", timeout: 300,
    concurrency: 1, memory: 512, queue: "Discovery", batch: 1, window: 0, scaling: null }),
  Object.freeze({ logicalId: "DomainAggregator", suffix: "domain-aggregator", timeout: 300,
    concurrency: 2, memory: 512, queue: "DiscoveryCheck", batch: 1, window: 0, scaling: 2 }),
  Object.freeze({ logicalId: "LeadWorker", suffix: "lead-worker", timeout: 90,
    concurrency: 2, memory: 512, queue: "Lead", batch: 1, window: 0, scaling: 2 }),
  Object.freeze({ logicalId: "LeadAggregator", suffix: "lead-aggregator", timeout: 300,
    concurrency: 2, memory: 512, queue: "LeadCheck", batch: 1, window: 0, scaling: 2 }),
  Object.freeze({ logicalId: "TrafficWorker", suffix: "traffic-worker", timeout: 900,
    concurrency: 1, memory: 512, queue: "Traffic", batch: 1000, window: 10, scaling: null }),
  Object.freeze({ logicalId: "FinalAggregator", suffix: "final-aggregator", timeout: 300,
    concurrency: 2, memory: 512, queue: "TrafficCheck", batch: 1, window: 0, scaling: 2 }),
  Object.freeze({ logicalId: "Recovery", suffix: "recovery", timeout: 300,
    concurrency: 1, memory: 512, queue: null, batch: null, window: null, scaling: null }),
  Object.freeze({ logicalId: "KeywordWorker", suffix: "keyword-worker", timeout: 180,
    concurrency: 1, memory: 1024, queue: "KeywordResearch", batch: 1, window: 0, scaling: null })
]);

function fail(message) {
  throw new Error(message);
}

function equal(actual, expected, message) {
  if (canonical(actual) !== canonical(expected)) fail(message);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseInspectArguments(argv) {
  if (!Array.isArray(argv)) fail("Inspection arguments must be an array");
  const result = { expectedDisabled: false, expectedActive: false };
  const seen = new Set();
  for (const raw of argv) {
    if (raw === "--expected-disabled" || raw === "--expected-active") {
      const key = raw === "--expected-disabled" ? "expectedDisabled" : "expectedActive";
      if (seen.has(key)) fail("Invalid or duplicate inspection argument");
      seen.add(key);
      result[key] = true;
      continue;
    }
    if (typeof raw !== "string" || !raw.startsWith("--") || !raw.includes("=")) {
      fail(`Unknown inspection argument: ${String(raw)}`);
    }
    const at = raw.indexOf("=");
    const rawKey = raw.slice(2, at);
    const key = rawKey.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const value = raw.slice(at + 1);
    if (!value || !["profile", "region", "stack", "accountId"].includes(key) || seen.has(key)) {
      fail("Invalid or duplicate inspection argument");
    }
    seen.add(key);
    result[key] = value;
  }
  for (const key of ["profile", "region", "stack", "accountId"]) {
    if (!result[key]) fail(`Missing inspection argument: ${key}`);
  }
  if (result.expectedDisabled === result.expectedActive || result.profile !== DEPLOYMENT.profile ||
      result.region !== DEPLOYMENT.region || result.stack !== DEPLOYMENT.stack ||
      !/^\d{12}$/u.test(result.accountId)) {
    fail("Inspection identity does not match the locked keyword deployment");
  }
  return Object.freeze({
    ...result,
    environment: DEPLOYMENT.environment,
    phase: result.expectedActive ? "activate" : "full"
  });
}

function aws(options, args) {
  const operation = args.slice(0, 2).join(" ");
  if (!READ_ONLY_AWS_COMMANDS.has(operation)) fail(`AWS inspection operation is not read-only: ${operation}`);
  const command = [
    ...args,
    "--profile", options.profile,
    "--region", options.region,
    "--no-cli-pager",
    "--output", "json"
  ];
  const result = spawnSync("aws", command, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) fail(`Read-only AWS inspection failed: aws ${operation}`);
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  } catch {
    fail(`AWS inspection returned invalid JSON: aws ${operation}`);
  }
}

function outputMap(stack) {
  return Object.fromEntries((stack.Outputs || []).map(({ OutputKey, OutputValue }) =>
    [OutputKey, OutputValue]));
}

function parameterMap(stack) {
  return Object.fromEntries((stack.Parameters || []).map(({ ParameterKey, ParameterValue }) =>
    [ParameterKey, ParameterValue]));
}

function deployedType(type) {
  return type === "AWS::Serverless::Function" ? "AWS::Lambda::Function" : type;
}

function decodePolicyDocument(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") fail("IAM policy document is absent");
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    fail("IAM policy document is invalid");
  }
}

function assertNoBroadDataPlane(policy) {
  for (const statement of policy?.Statement || []) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    if (statement.Effect === "Allow" && actions.some((action) => /^(?:s3|sqs):\*$/u.test(action))) {
      fail("Deployed IAM contains a broad data-plane action");
    }
    if (statement.Effect === "Allow" && actions.some((action) => /^(?:s3|sqs):/u.test(action)) &&
        resources.includes("*")) {
      fail("Deployed IAM contains a wildcard data-plane resource");
    }
  }
}

function createResolverContext({ options, outputs, parameters, physical }) {
  const refs = new Map(Object.entries(parameters));
  const attrs = new Map();
  for (const [logicalId, physicalId] of physical) refs.set(logicalId, physicalId);
  refs.set("ArtifactBucketName", parameters.ArtifactBucketName);
  refs.set("PipelineSecret", outputs.PipelineSecretArn);
  refs.set("ControlPlanePolicy", outputs.ControlPlanePolicyArn);
  refs.set("RecoverySchedule", outputs.RecoveryScheduleName);
  attrs.set("ArtifactBucket.Arn", outputs.ArtifactBucketArn);
  for (const queue of QUEUES) {
    refs.set(`${queue.logicalId}Queue`, outputs[`${queue.logicalId}QueueUrl`]);
    attrs.set(`${queue.logicalId}Queue.Arn`, outputs[`${queue.logicalId}QueueArn`]);
    attrs.set(`${queue.logicalId}Dlq.Arn`, outputs[`${queue.logicalId}DlqArn`]);
    attrs.set(`${queue.logicalId}Queue.QueueName`, `${options.stack}-${queue.slug}`);
    attrs.set(`${queue.logicalId}Dlq.QueueName`, `${options.stack}-${queue.slug}-dlq`);
  }
  for (const item of FUNCTIONS) {
    attrs.set(`${item.logicalId}.Arn`, outputs[`${item.logicalId}FunctionArn`]);
  }
  const substitutions = new Map([
    ["AWS::Partition", "aws"],
    ["AWS::Region", options.region],
    ["AWS::AccountId", options.accountId],
    ["AWS::StackName", options.stack],
    ["ArtifactBucketName", parameters.ArtifactBucketName],
    ["ArtifactBucket.Arn", outputs.ArtifactBucketArn]
  ]);
  return { refs, attrs, substitutions, expectedActive: options.expectedActive };
}

function resolveTemplate(value, context) {
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, context));
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "Ref") {
    if (!context.refs.has(value.Ref)) fail(`Unresolved template reference: ${value.Ref}`);
    return context.refs.get(value.Ref);
  }
  if (keys.length === 1 && keys[0] === "Fn::GetAtt") {
    const name = value["Fn::GetAtt"].join(".");
    if (!context.attrs.has(name)) fail(`Unresolved template attribute: ${name}`);
    return context.attrs.get(name);
  }
  if (keys.length === 1 && keys[0] === "Fn::If") {
    const [condition, whenTrue, whenFalse] = value["Fn::If"];
    if (condition !== "KeywordResearchEnabledCondition") fail(`Unresolved template condition: ${condition}`);
    return resolveTemplate(context.expectedActive ? whenTrue : whenFalse, context);
  }
  if (keys.length === 1 && keys[0] === "Fn::Sub") {
    const source = value["Fn::Sub"];
    const template = Array.isArray(source) ? source[0] : source;
    const locals = Array.isArray(source) ? Object.fromEntries(Object.entries(source[1]).map(([key, item]) =>
      [key, resolveTemplate(item, context)])) : {};
    return template.replace(/\$\{([^}]+)\}/gu, (_, name) => {
      if (Object.hasOwn(locals, name)) return locals[name];
      if (context.substitutions.has(name)) return context.substitutions.get(name);
      if (context.refs.has(name)) return context.refs.get(name);
      if (context.attrs.has(name)) return context.attrs.get(name);
      fail(`Unresolved template substitution: ${name}`);
    });
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, resolveTemplate(item, context)]));
}

function assertQueueName(url, expectedName) {
  let pathname;
  try { pathname = new URL(url).pathname; }
  catch { fail("Queue output is not a URL"); }
  if (!pathname.endsWith(`/${expectedName}`)) fail("Queue output name drift");
}

function queueMessageCount(attributes) {
  return Number(attributes.ApproximateNumberOfMessages || 0) +
    Number(attributes.ApproximateNumberOfMessagesNotVisible || 0) +
    Number(attributes.ApproximateNumberOfMessagesDelayed || 0);
}

function alarmProjection(alarm) {
  return {
    AlarmName: alarm.AlarmName,
    ComparisonOperator: alarm.ComparisonOperator,
    EvaluationPeriods: alarm.EvaluationPeriods,
    DatapointsToAlarm: alarm.DatapointsToAlarm,
    MetricName: alarm.MetricName,
    Namespace: alarm.Namespace,
    Period: alarm.Period,
    Statistic: alarm.Statistic,
    Threshold: alarm.Threshold,
    TreatMissingData: alarm.TreatMissingData,
    Dimensions: alarm.Dimensions || []
  };
}

export async function inspect(options) {
  if (!options || options.profile !== DEPLOYMENT.profile || options.region !== DEPLOYMENT.region ||
      options.stack !== DEPLOYMENT.stack || options.environment !== DEPLOYMENT.environment ||
      options.expectedDisabled === options.expectedActive ||
      options.phase !== (options.expectedActive ? "activate" : "full") ||
      !/^\d{12}$/u.test(options.accountId || "")) {
    fail("Inspection options do not match the locked keyword deployment");
  }
  const identity = aws(options, ["sts", "get-caller-identity"]);
  if (identity.Account !== options.accountId) fail("STS account differs from the approved account");

  const [packet, templateBody] = await Promise.all([
    buildDeploymentPacket(options),
    readFile(templatePath, "utf8")
  ]);
  let template;
  try { template = JSON.parse(templateBody); }
  catch { fail("Accepted deployment template is not valid JSON"); }

  const described = aws(options, ["cloudformation", "describe-stacks", "--stack-name", options.stack]);
  const stack = described.Stacks?.[0];
  if (!stack || !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus)) {
    fail("Production stack is not complete");
  }
  const outputs = outputMap(stack);
  const parameters = parameterMap(stack);
  const expectedOutputKeys = Object.keys(template.Outputs).sort();
  equal(Object.keys(outputs).sort(), expectedOutputKeys, "Deployed stack output inventory drift");
  if (outputs.ArtifactBucketName !== packet.bucket || parameters.Environment !== DEPLOYMENT.environment ||
      parameters.ArtifactBucketName !== packet.bucket ||
      parameters.KeywordResearchEnabled !== (options.expectedActive ? "true" : "false")) {
    fail("Deployed stack parameter/output identity drift");
  }
  for (const item of packet.zips) {
    if (parameters[`${item.logicalId}CodeKey`] !== item.key ||
        !parameters[`${item.logicalId}CodeVersion`]) fail(`Deployed code identity drift: ${item.logicalId}`);
  }

  const listed = aws(options, ["cloudformation", "list-stack-resources", "--stack-name", options.stack]);
  const summaries = listed.StackResourceSummaries || [];
  const actualInventory = summaries.map(({ LogicalResourceId, ResourceType }) => ({
    logicalId: LogicalResourceId,
    type: ResourceType
  })).sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  const expectedInventory = Object.entries(template.Resources).map(([logicalId, resource]) => ({
    logicalId,
    type: deployedType(resource.Type)
  })).sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  equal(actualInventory, expectedInventory, "Deployed stack resource inventory drift");
  const physical = new Map(summaries.map(({ LogicalResourceId, PhysicalResourceId }) =>
    [LogicalResourceId, PhysicalResourceId]));

  let keywordSourceMessages = 0;
  let keywordDlqMessages = 0;
  for (const queue of QUEUES) {
    const sourceUrl = outputs[`${queue.logicalId}QueueUrl`];
    const sourceArn = outputs[`${queue.logicalId}QueueArn`];
    const dlqArn = outputs[`${queue.logicalId}DlqArn`];
    if (!sourceUrl || !sourceArn || !dlqArn) fail(`Missing queue output: ${queue.logicalId}`);
    assertQueueName(sourceUrl, `${options.stack}-${queue.slug}`);
    const source = aws(options, ["sqs", "get-queue-attributes", "--queue-url", sourceUrl,
      "--attribute-names", "All"]).Attributes || {};
    let redrive;
    try { redrive = JSON.parse(source.RedrivePolicy); }
    catch { fail(`Source queue redrive policy drift: ${queue.logicalId}`); }
    if (source.QueueArn !== sourceArn || Number(source.VisibilityTimeout) !== queue.visibility ||
        Number(source.MessageRetentionPeriod) !== 345600 || Number(source.MaximumMessageSize) !== 262144 ||
        Number(source.ReceiveMessageWaitTimeSeconds) !== 20 || source.SqsManagedSseEnabled !== "true" ||
        Number(redrive.maxReceiveCount) !== 5 || redrive.deadLetterTargetArn !== dlqArn) {
      fail(`Source queue attribute drift: ${queue.logicalId}`);
    }
    const dlqName = `${options.stack}-${queue.slug}-dlq`;
    const dlqUrl = aws(options, ["sqs", "get-queue-url", "--queue-name", dlqName]).QueueUrl;
    assertQueueName(dlqUrl, dlqName);
    const dlq = aws(options, ["sqs", "get-queue-attributes", "--queue-url", dlqUrl,
      "--attribute-names", "All"]).Attributes || {};
    if (dlq.QueueArn !== dlqArn || Number(dlq.MessageRetentionPeriod) !== 1209600 ||
        dlq.SqsManagedSseEnabled !== "true" || dlq.RedrivePolicy != null) {
      fail(`DLQ attribute drift: ${queue.logicalId}`);
    }
    if (queue.logicalId === "KeywordResearch") {
      keywordSourceMessages = queueMessageCount(source);
      keywordDlqMessages = queueMessageCount(dlq);
    }
  }
  if (options.expectedDisabled && (keywordSourceMessages !== 0 || keywordDlqMessages !== 0)) {
    fail("Expected-disabled keyword queues are not empty");
  }

  const context = createResolverContext({ options, outputs, parameters, physical });
  let mappingCount = 0;
  for (const item of FUNCTIONS) {
    const arn = outputs[`${item.logicalId}FunctionArn`];
    if (!arn) fail(`Missing function output: ${item.logicalId}`);
    const config = aws(options, ["lambda", "get-function-configuration", "--function-name", arn]);
    const concurrency = aws(options, ["lambda", "get-function-concurrency", "--function-name", arn]);
    if (config.FunctionArn !== arn || config.FunctionName !== `${options.stack}-${item.suffix}` ||
        config.Handler !== "index.handler" || config.Runtime !== "nodejs24.x" ||
        canonical(config.Architectures) !== canonical(["x86_64"]) || config.MemorySize !== item.memory ||
        config.Timeout !== item.timeout || config.EphemeralStorage?.Size !== 512 ||
        config.TracingConfig?.Mode !== "PassThrough" ||
        concurrency.ReservedConcurrentExecutions !== item.concurrency) {
      fail(`Lambda configuration drift: ${item.logicalId}`);
    }
    const expectedEnvironment = resolveTemplate(template.Resources[item.logicalId].Properties.Environment.Variables,
      context);
    equal(config.Environment?.Variables || {}, expectedEnvironment, `Lambda environment drift: ${item.logicalId}`);
    const environmentKeys = Object.keys(config.Environment?.Variables || {});
    if (environmentKeys.some((key) => /(?:TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL|API_KEY)/u.test(key)) ||
        environmentKeys.includes("AWS_REGION")) fail(`Lambda environment privacy drift: ${item.logicalId}`);

    const mappings = aws(options, ["lambda", "list-event-source-mappings", "--function-name", arn])
      .EventSourceMappings || [];
    if (item.queue === null) {
      if (mappings.length !== 0) fail("Recovery function unexpectedly has an event mapping");
    } else {
      if (mappings.length !== 1) fail(`Mapping cardinality drift: ${item.logicalId}`);
      const mapping = mappings[0];
      const expectedState = item.logicalId === "KeywordWorker"
        ? (options.expectedActive ? "Enabled" : "Disabled")
        : "Enabled";
      if (mapping.State !== expectedState || mapping.FunctionArn !== arn ||
          mapping.EventSourceArn !== outputs[`${item.queue}QueueArn`] || mapping.BatchSize !== item.batch ||
          mapping.MaximumBatchingWindowInSeconds !== item.window ||
          canonical(mapping.FunctionResponseTypes || []) !== canonical(["ReportBatchItemFailures"]) ||
          (item.scaling === null ? mapping.ScalingConfig?.MaximumConcurrency != null :
            mapping.ScalingConfig?.MaximumConcurrency !== item.scaling)) {
        fail(`Mapping drift: ${item.logicalId}`);
      }
      mappingCount += 1;
    }

    const logGroupName = `/aws/lambda/${options.stack}-${item.suffix}`;
    const groups = aws(options, ["logs", "describe-log-groups", "--log-group-name-prefix", logGroupName,
      "--limit", "2"]).logGroups || [];
    const exactGroups = groups.filter(({ logGroupName: name }) => name === logGroupName);
    if (exactGroups.length !== 1 || exactGroups[0].retentionInDays !== 30) {
      fail(`Lambda log-group drift: ${item.logicalId}`);
    }
    if (options.expectedDisabled && item.logicalId === "KeywordWorker") {
      const streams = aws(options, ["logs", "describe-log-streams", "--log-group-name", logGroupName,
        "--limit", "1"]).logStreams || [];
      if (streams.length !== 0) fail("Expected-disabled keyword worker has log activity");
    }
  }
  if (mappingCount !== 7) fail("Expected seven event-source mappings");

  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== "AWS::IAM::Role") continue;
    const roleName = physical.get(logicalId);
    if (!roleName) fail(`Missing role physical identity: ${logicalId}`);
    const expectedPolicies = resource.Properties.Policies || [];
    const listedPolicies = aws(options, ["iam", "list-role-policies", "--role-name", roleName]);
    equal((listedPolicies.PolicyNames || []).sort(), expectedPolicies.map(({ PolicyName }) => PolicyName).sort(),
      `IAM inline-policy inventory drift: ${logicalId}`);
    for (const expected of expectedPolicies) {
      const actual = aws(options, ["iam", "get-role-policy", "--role-name", roleName,
        "--policy-name", expected.PolicyName]);
      const actualDocument = decodePolicyDocument(actual.PolicyDocument);
      const expectedDocument = resolveTemplate(expected.PolicyDocument, context);
      equal(actualDocument, expectedDocument, `IAM inline-policy drift: ${logicalId}`);
      assertNoBroadDataPlane(actualDocument);
    }
  }

  const policyArn = outputs.ControlPlanePolicyArn;
  const policy = aws(options, ["iam", "get-policy", "--policy-arn", policyArn]).Policy;
  if (!policy?.DefaultVersionId) fail("Control-plane policy has no default version");
  const policyVersion = aws(options, ["iam", "get-policy-version", "--policy-arn", policyArn,
    "--version-id", policy.DefaultVersionId]).PolicyVersion;
  const actualManagedPolicy = decodePolicyDocument(policyVersion?.Document);
  const expectedManagedPolicy = resolveTemplate(template.Resources.ControlPlanePolicy.Properties.PolicyDocument,
    context);
  equal(actualManagedPolicy, expectedManagedPolicy, "Control-plane policy drift");
  assertNoBroadDataPlane(actualManagedPolicy);

  const alarmResources = Object.entries(template.Resources).filter(([, resource]) =>
    resource.Type === "AWS::CloudWatch::Alarm");
  const alarmNames = alarmResources.map(([logicalId]) => physical.get(logicalId));
  if (alarmNames.some((name) => !name)) fail("CloudWatch alarm physical identity is absent");
  const alarms = aws(options, ["cloudwatch", "describe-alarms", "--alarm-names", ...alarmNames])
    .MetricAlarms || [];
  if (alarms.length !== alarmResources.length) fail("CloudWatch alarm inventory drift");
  const alarmsByName = new Map(alarms.map((alarm) => [alarm.AlarmName, alarm]));
  for (const [logicalId, resource] of alarmResources) {
    const actual = alarmsByName.get(physical.get(logicalId));
    if (!actual || (actual.AlarmActions || []).length !== 0) fail(`CloudWatch alarm drift: ${logicalId}`);
    const expected = resolveTemplate(resource.Properties, context);
    equal(alarmProjection(actual), alarmProjection(expected), `CloudWatch alarm definition drift: ${logicalId}`);
  }

  const keywordExpected = options.expectedActive ? "true" : "false";
  for (const logicalId of ["KeywordWorker", "Recovery"]) {
    const expected = resolveTemplate(template.Resources[logicalId].Properties.Environment.Variables, context);
    if (expected.AWS_PIPELINE_KEYWORD_RESEARCH_ENABLED !== keywordExpected ||
        expected.AWS_PIPELINE_KEYWORD_RESEARCH_QUEUE_URL !== outputs.KeywordResearchQueueUrl) {
      fail(`Keyword environment projection drift: ${logicalId}`);
    }
  }

  return Object.freeze({
    outcome: options.expectedActive ? "EXPECTED_ACTIVE_KEYWORD_STACK_VERIFIED" :
      "EXPECTED_DISABLED_KEYWORD_STACK_VERIFIED",
    identityVerified: true,
    deployment: "production",
    resources: actualInventory.length,
    queues: 7,
    dlqs: 7,
    functions: 8,
    mappings: mappingCount,
    alarms: alarmResources.length,
    keywordActive: options.expectedActive,
    keywordSourceMessages,
    keywordDlqMessages
  });
}

export async function main(argv = process.argv.slice(2)) {
  const result = await inspect(parseInspectArguments(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || "Keyword stack inspection failed"}\n`);
    process.exitCode = 1;
  });
}
