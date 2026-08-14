import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDeploymentPacket, DEPLOYMENT, parseArguments } from
  "../scripts/aws-pipeline/create-change-set.js";
import { parseInspectArguments } from "../scripts/aws-pipeline/inspect-stack.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const bootstrap = JSON.parse(await readFile(path.join(root, "infrastructure/aws/bootstrap-template.yaml"), "utf8"));
const template = JSON.parse(await readFile(path.join(root, "infrastructure/aws/template.yaml"), "utf8"));
const scriptSource = await readFile(path.join(root, "scripts/aws-pipeline/create-change-set.js"), "utf8");
const inspectSource = await readFile(path.join(root, "scripts/aws-pipeline/inspect-stack.js"), "utf8");

const expected = Object.freeze({
  profile: "storesignal-dev", region: "ap-south-2", stack: "storesignal-production-pipeline",
  environment: "production", phase: "full", accountId: "123456789012"
});

function clone(value) {
  return structuredClone(value);
}

function policyStatements(resource) {
  return resource.Properties.Policies.flatMap(({ PolicyDocument }) => PolicyDocument.Statement);
}

function validate(candidate) {
  const resources = candidate.Resources;
  assert.equal(candidate.Transform, "AWS::Serverless-2016-10-31");
  const bucket = resources.ArtifactBucket;
  assert.equal(bucket.DeletionPolicy, "Retain");
  assert.equal(bucket.UpdateReplacePolicy, "Retain");
  assert.equal(bucket.Properties.VersioningConfiguration.Status, "Enabled");
  assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0]
    .ServerSideEncryptionByDefault.SSEAlgorithm, "AES256");
  assert.equal(bucket.Properties.OwnershipControls.Rules[0].ObjectOwnership, "BucketOwnerEnforced");
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true
  });
  const lifecycle = bucket.Properties.LifecycleConfiguration.Rules;
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].AbortIncompleteMultipartUpload.DaysAfterInitiation, 7);
  assert.equal(lifecycle.some((rule) => rule.Expiration || rule.NoncurrentVersionExpiration), false);
  const bucketPolicy = resources.ArtifactBucketPolicy.Properties.PolicyDocument.Statement;
  assert(bucketPolicy.some(({ Sid, Condition }) => Sid === "DenyInsecureTransport" &&
    Condition.Bool["aws:SecureTransport"] === "false"));
  assert(bucketPolicy.some(({ Sid, Condition }) => Sid === "DenyIncorrectEncryption" &&
    Condition.StringNotEquals["s3:x-amz-server-side-encryption"] === "AES256"));

  assert.equal(Object.hasOwn(resources.PipelineSecret.Properties, "SecretString"), false);
  assert.equal(Object.hasOwn(resources.PipelineSecret.Properties, "GenerateSecretString"), false);
  assert.equal(resources.PipelineSecret.DeletionPolicy, "Retain");

  const queueVisibility = { Discovery: 1800, DiscoveryCheck: 1800, Lead: 540,
    LeadCheck: 1800, Traffic: 5410, TrafficCheck: 1800 };
  for (const [id, visibility] of Object.entries(queueVisibility)) {
    const source = resources[`${id}Queue`].Properties;
    const dlq = resources[`${id}Dlq`].Properties;
    assert.equal(source.VisibilityTimeout, visibility);
    assert.equal(source.MessageRetentionPeriod, 345600);
    assert.equal(source.SqsManagedSseEnabled, true);
    assert.equal(source.RedrivePolicy.maxReceiveCount, 5);
    assert.deepEqual(source.RedrivePolicy.deadLetterTargetArn, { "Fn::GetAtt": [`${id}Dlq`, "Arn"] });
    assert.equal(dlq.MessageRetentionPeriod, 1209600);
    assert.equal(dlq.SqsManagedSseEnabled, true);
  }

  const functions = { DiscoveryWorker: [300, 1], DomainAggregator: [300, 2], LeadWorker: [90, 2],
    LeadAggregator: [300, 2], TrafficWorker: [900, 1], FinalAggregator: [300, 2], Recovery: [300, 1] };
  for (const [id, [timeout, concurrency]] of Object.entries(functions)) {
    const fn = resources[id].Properties;
    assert.equal(fn.Runtime, "nodejs24.x");
    assert.equal(fn.MemorySize, 512);
    assert.equal(fn.Timeout, timeout);
    assert.equal(fn.ReservedConcurrentExecutions, concurrency);
    assert.equal(fn.EphemeralStorage.Size, 512);
    assert.deepEqual(fn.Architectures, ["x86_64"]);
    assert.deepEqual(fn.Role, { "Fn::GetAtt": [`${id}Role`, "Arn"] });
    assert.equal(fn.CodeUri.Key.Ref, `${id}CodeKey`);
    assert.equal(fn.CodeUri.Version.Ref, `${id}CodeVersion`);
    const env = fn.Environment.Variables;
    assert.equal(env.RUN_EXECUTION_BACKEND, "aws");
    assert.equal(env.AWS_PIPELINE_ENABLED, "true");
    assert.equal(Object.hasOwn(env, "AWS_REGION"), false);
    assert.equal(Object.keys(env).some((key) => /(?:TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL|API_KEY)/u.test(key)), false);
  }

  const mappingSettings = {
    DiscoveryMapping: [1, 0, null], DomainAggregationMapping: [1, 0, 2],
    LeadMapping: [1, 0, 2], LeadAggregationMapping: [1, 0, 2],
    TrafficMapping: [1000, 10, null], FinalAggregationMapping: [1, 0, 2]
  };
  for (const [id, [batch, window, maximum]] of Object.entries(mappingSettings)) {
    const mapping = resources[id].Properties;
    assert.equal(mapping.Enabled, false);
    assert.equal(mapping.BatchSize, batch);
    assert.equal(mapping.MaximumBatchingWindowInSeconds, window);
    assert.deepEqual(mapping.FunctionResponseTypes, ["ReportBatchItemFailures"]);
    if (maximum === null) assert.equal(Object.hasOwn(mapping, "ScalingConfig"), false);
    else assert.equal(mapping.ScalingConfig.MaximumConcurrency, maximum);
    assert.notEqual(mapping.ScalingConfig?.MaximumConcurrency, 1);
  }
  assert.equal(resources.RecoverySchedule.Properties.State, "DISABLED");
  assert.equal(resources.RecoverySchedule.Properties.ScheduleExpression, "rate(5 minutes)");

  const roles = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::IAM::Role");
  assert.equal(roles.length, 7);
  for (const [, role] of roles) for (const statement of policyStatements(role)) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const targets = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    assert.equal(actions.some((action) => /^(?:s3|sqs):\*$/u.test(action)), false);
    if (actions.some((action) => /^(?:s3|sqs):/u.test(action))) assert.equal(targets.includes("*"), false);
    assert.equal(actions.includes("s3:DeleteObject"), false);
    assert.equal(actions.includes("sqs:PurgeQueue"), false);
  }
  assert.equal(resources.ControlPlanePolicy.Properties.Roles, undefined);
  assert.equal(resources.ControlPlanePolicy.Properties.Users, undefined);
  assert.equal(resources.ControlPlanePolicy.Properties.Groups, undefined);

  const alarms = Object.values(resources).filter(({ Type }) => Type === "AWS::CloudWatch::Alarm");
  assert.equal(alarms.length, 27);
  assert(alarms.every(({ Properties }) => Properties.Dimensions?.length === 1 &&
    Properties.TreatMissingData === "notBreaching" && !Properties.AlarmActions));
  return true;
}

test("G14 template implements the exact disabled topology", () => {
  assert.equal(Object.keys(template.Resources).length, 72);
  assert.equal(validate(template), true);
});

test("bootstrap bucket and policy are byte-equivalent to the full stack resources", () => {
  assert.deepEqual(bootstrap.Resources.ArtifactBucket, template.Resources.ArtifactBucket);
  assert.deepEqual(bootstrap.Resources.ArtifactBucketPolicy, template.Resources.ArtifactBucketPolicy);
  assert.deepEqual(bootstrap.Parameters, {
    Environment: template.Parameters.Environment,
    ArtifactBucketName: template.Parameters.ArtifactBucketName
  });
  assert.deepEqual(Object.keys(bootstrap.Resources).sort(), ["ArtifactBucket", "ArtifactBucketPolicy"]);
});

test("policy test catches every locked unsafe template class", () => {
  const mutations = [
    (value) => { value.Resources.ArtifactBucket.Properties.PublicAccessBlockConfiguration.BlockPublicAcls = false; },
    (value) => { delete value.Resources.ArtifactBucket.Properties.BucketEncryption; },
    (value) => { value.Resources.ArtifactBucket.Properties.LifecycleConfiguration.Rules[0].Expiration = { Days: 7 }; },
    (value) => { value.Resources.PipelineSecret.Properties.SecretString = "forbidden"; },
    (value) => { value.Resources.DiscoveryMapping.Properties.Enabled = true; },
    (value) => { value.Resources.DiscoveryMapping.Properties.ScalingConfig = { MaximumConcurrency: 1 }; },
    (value) => { delete value.Resources.LeadMapping.Properties.FunctionResponseTypes; },
    (value) => { value.Resources.TrafficQueue.Properties.VisibilityTimeout = 5400; },
    (value) => { value.Resources.DiscoveryWorkerRole.Properties.Policies[0]
      .PolicyDocument.Statement.push({ Effect: "Allow", Action: "s3:*", Resource: "*" }); }
  ];
  for (const mutate of mutations) {
    const candidate = clone(template);
    mutate(candidate);
    assert.throws(() => validate(candidate));
  }
});

test("deployment commands are exact, dry-run-first, and secret-value hostile", async () => {
  const args = ["--profile=storesignal-dev", "--region=ap-south-2",
    "--stack=storesignal-production-pipeline", "--environment=production",
    "--phase=full", "--account-id=123456789012"];
  assert.deepEqual(parseArguments(args), { ...expected, execute: false, applyReviewedChangeSet: false });
  assert.throws(() => parseArguments([...args, "--execute", "--secret-value=nope"]));
  assert.throws(() => parseArguments(args.map((item) => item === "--region=ap-south-2" ? "--region=us-east-1" : item)));
  assert.throws(() => parseArguments([...args, "--apply-reviewed-change-set"]));
  const packet = await buildDeploymentPacket(expected);
  assert.equal(packet.zips.length, 7);
  assert.equal(packet.full.resources.length, 72);
  assert.equal(packet.bootstrap.resources.length, 2);
  assert.match(packet.approvalToken, /^[a-f0-9]{64}$/u);
  assert(packet.zips.every(({ key, sha256 }) => key.includes(sha256)));
  assert.equal(scriptSource.includes("shell: true"), false);
  assert.equal(scriptSource.includes("PurgeQueue"), false);
  assert.equal(scriptSource.includes("delete-object"), false);
});

test("stack inspector is read-only and requires the disabled-state assertion", () => {
  const parsed = parseInspectArguments(["--profile=storesignal-dev", "--region=ap-south-2",
    "--stack=storesignal-production-pipeline", "--account-id=123456789012", "--expected-disabled"]);
  assert.equal(parsed.expectedDisabled, true);
  assert.throws(() => parseInspectArguments(["--profile=storesignal-dev", "--region=ap-south-2",
    "--stack=storesignal-production-pipeline", "--account-id=123456789012"]));
  assert.equal(/aws\(options, \["(?:cloudformation|s3api|sqs|lambda|events|secretsmanager)", "(?:create|update|delete|put|execute|enable|disable|purge)/u.test(inspectSource), false);
});

test("deployment constants stay aligned with the packet", () => {
  assert.deepEqual(DEPLOYMENT, {
    profile: "storesignal-dev", region: "ap-south-2", stack: "storesignal-production-pipeline",
    environment: "production", phases: ["bootstrap", "package", "full"],
    handlers: [
      ["DiscoveryWorker", "discovery-worker"], ["DomainAggregator", "domain-aggregator"],
      ["LeadWorker", "lead-worker"], ["LeadAggregator", "lead-aggregator"],
      ["TrafficWorker", "traffic-worker"], ["FinalAggregator", "final-aggregator"],
      ["Recovery", "recovery"]
    ]
  });
});
