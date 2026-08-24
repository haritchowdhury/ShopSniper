import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const W7_OWNER_REGISTRY = Object.freeze({"owner":"infrastructure","requiredCases":["W7-INFRA-01","W7-INFRA-02","W7-INFRA-03","W7-INFRA-04","W7-INFRA-05","W7-INFRA-06"],"requiredControls":["W7-NC-05","W7-NC-06","W7-NC-07","W7-NC-08","W7-NC-09"]}); // W7-REGISTRY

const TEMPLATE_URL = new URL("../infrastructure/aws/template.yaml", import.meta.url);
const KEYWORD_PARAMETERS = Object.freeze([
  "KeywordWorkerCodeKey",
  "KeywordWorkerCodeVersion",
  "KeywordResearchEnabled"
]);
const KEYWORD_RESOURCES = Object.freeze([
  "KeywordResearchDlq",
  "KeywordResearchQueue",
  "KeywordWorkerLogGroup",
  "KeywordWorkerRole",
  "KeywordWorker",
  "KeywordResearchMapping",
  "KeywordResearchDlqDepthAlarm",
  "KeywordResearchOldestMessageAlarm",
  "KeywordWorkerErrorsAlarm",
  "KeywordWorkerThrottlesAlarm"
]);
const KEYWORD_OUTPUTS = Object.freeze([
  "KeywordResearchQueueUrl",
  "KeywordResearchQueueArn",
  "KeywordResearchDlqArn",
  "KeywordWorkerFunctionArn"
]);
const KEYWORD_QUEUE_ARN = Object.freeze({ "Fn::GetAtt": ["KeywordResearchQueue", "Arn"] });
const BASELINE_PROJECTION = Object.freeze({
  sha256: "36b23545968066165369fa32ecb4d9b6fe323f46ce7ab61564deb0b98a8edb95",
  topLevelNames: ["AWSTemplateFormatVersion", "Transform", "Description", "Parameters", "Resources", "Outputs"],
  parameterNames: [
    "Environment", "ArtifactBucketName", "DiscoveryWorkerCodeKey", "DiscoveryWorkerCodeVersion",
    "DomainAggregatorCodeKey", "DomainAggregatorCodeVersion", "LeadWorkerCodeKey",
    "LeadWorkerCodeVersion", "LeadAggregatorCodeKey", "LeadAggregatorCodeVersion",
    "TrafficWorkerCodeKey", "TrafficWorkerCodeVersion", "FinalAggregatorCodeKey",
    "FinalAggregatorCodeVersion", "RecoveryCodeKey", "RecoveryCodeVersion"
  ],
  resourceNames: [
    "ArtifactBucket", "ArtifactBucketPolicy", "DiscoveryDlq", "DiscoveryCheckDlq", "LeadDlq",
    "LeadCheckDlq", "TrafficDlq", "TrafficCheckDlq", "DiscoveryQueue", "DiscoveryCheckQueue",
    "LeadQueue", "LeadCheckQueue", "TrafficQueue", "TrafficCheckQueue", "PipelineSecret",
    "DiscoveryWorkerLogGroup", "DiscoveryWorkerRole", "DomainAggregatorLogGroup",
    "DomainAggregatorRole", "LeadWorkerLogGroup", "LeadWorkerRole", "LeadAggregatorLogGroup",
    "LeadAggregatorRole", "TrafficWorkerLogGroup", "TrafficWorkerRole", "FinalAggregatorLogGroup",
    "FinalAggregatorRole", "RecoveryLogGroup", "RecoveryRole", "ControlPlanePolicy",
    "DiscoveryWorker", "DomainAggregator", "LeadWorker", "LeadAggregator", "TrafficWorker",
    "FinalAggregator", "Recovery", "DiscoveryMapping", "DomainAggregationMapping", "LeadMapping",
    "LeadAggregationMapping", "TrafficMapping", "FinalAggregationMapping", "RecoverySchedule",
    "RecoveryInvokePermission", "DiscoveryDlqDepthAlarm", "DiscoveryOldestMessageAlarm",
    "DiscoveryCheckDlqDepthAlarm", "DiscoveryCheckOldestMessageAlarm", "LeadDlqDepthAlarm",
    "LeadOldestMessageAlarm", "LeadCheckDlqDepthAlarm", "LeadCheckOldestMessageAlarm",
    "TrafficDlqDepthAlarm", "TrafficOldestMessageAlarm", "TrafficCheckDlqDepthAlarm",
    "TrafficCheckOldestMessageAlarm", "DiscoveryWorkerErrorsAlarm", "DiscoveryWorkerThrottlesAlarm",
    "DomainAggregatorErrorsAlarm", "DomainAggregatorThrottlesAlarm", "LeadWorkerErrorsAlarm",
    "LeadWorkerThrottlesAlarm", "LeadAggregatorErrorsAlarm", "LeadAggregatorThrottlesAlarm",
    "TrafficWorkerErrorsAlarm", "TrafficWorkerThrottlesAlarm", "FinalAggregatorErrorsAlarm",
    "FinalAggregatorThrottlesAlarm", "RecoveryErrorsAlarm", "RecoveryThrottlesAlarm",
    "RecoveryRuleFailureAlarm"
  ],
  outputNames: [
    "ArtifactBucketName", "ArtifactBucketArn", "PipelineSecretArn", "ControlPlanePolicyArn",
    "RecoveryScheduleName", "DiscoveryQueueUrl", "DiscoveryQueueArn", "DiscoveryDlqArn",
    "DiscoveryCheckQueueUrl", "DiscoveryCheckQueueArn", "DiscoveryCheckDlqArn", "LeadQueueUrl",
    "LeadQueueArn", "LeadDlqArn", "LeadCheckQueueUrl", "LeadCheckQueueArn", "LeadCheckDlqArn",
    "TrafficQueueUrl", "TrafficQueueArn", "TrafficDlqArn", "TrafficCheckQueueUrl",
    "TrafficCheckQueueArn", "TrafficCheckDlqArn", "DiscoveryWorkerFunctionArn",
    "DomainAggregatorFunctionArn", "LeadWorkerFunctionArn", "LeadAggregatorFunctionArn",
    "TrafficWorkerFunctionArn", "FinalAggregatorFunctionArn", "RecoveryFunctionArn"
  ]
});

function parseTemplate() {
  return JSON.parse(readFileSync(TEMPLATE_URL, "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function sorted(values) {
  return [...values].sort();
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function policyStatements(resource) {
  return resource.Properties.Policies.flatMap(({ PolicyDocument }) => PolicyDocument.Statement);
}

function statement(resource, sid) {
  const statements = resource.Type === "AWS::IAM::ManagedPolicy"
    ? resource.Properties.PolicyDocument.Statement
    : policyStatements(resource);
  return statements.find((candidate) => candidate.Sid === sid);
}

function removeQueueArn(resources, resourceName, sid) {
  const target = statement(resources[resourceName], sid);
  target.Resource = target.Resource.filter((resource) =>
    JSON.stringify(resource) !== JSON.stringify(KEYWORD_QUEUE_ARN));
}

function withoutKeywordExtensions(candidate) {
  const baseline = clone(candidate);
  for (const name of KEYWORD_PARAMETERS) delete baseline.Parameters[name];
  delete baseline.Conditions.KeywordResearchEnabledCondition;
  if (Object.keys(baseline.Conditions).length === 0) delete baseline.Conditions;
  for (const name of KEYWORD_RESOURCES) delete baseline.Resources[name];
  for (const name of KEYWORD_OUTPUTS) delete baseline.Outputs[name];
  removeQueueArn(baseline.Resources, "RecoveryRole", "SendAssignedQueues");
  removeQueueArn(baseline.Resources, "ControlPlanePolicy", "StartDiscoveryOnly");
  delete baseline.Resources.Recovery.Properties.Environment.Variables.AWS_PIPELINE_KEYWORD_RESEARCH_QUEUE_URL;
  delete baseline.Resources.Recovery.Properties.Environment.Variables.AWS_PIPELINE_KEYWORD_RESEARCH_ENABLED;
  return baseline;
}

function baselineProjection(candidate) {
  const baseline = withoutKeywordExtensions(candidate);
  return {
    sha256: sha256(baseline),
    topLevelNames: Object.keys(baseline),
    parameterNames: Object.keys(baseline.Parameters),
    resourceNames: Object.keys(baseline.Resources),
    outputNames: Object.keys(baseline.Outputs)
  };
}

function queueTags(role) {
  return [
    { Key: "Project", Value: "StoreSignal" },
    { Key: "Environment", Value: { Ref: "Environment" } },
    { Key: "QueueRole", Value: role }
  ];
}

function executionRecord(id, kind) {
  const common = {
    schema: "ki-w7-execution-record-v1",
    id,
    kind,
    owner: W7_OWNER_REGISTRY.owner,
    executed: true,
    activated: true
  };
  if (kind === "case") {
    return `KI_W7_EXECUTION_RECORD_V1=${JSON.stringify({
      ...common,
      oraclePassed: true,
      skipped: false
    })}`;
  }
  return `KI_W7_EXECUTION_RECORD_V1=${JSON.stringify({
    ...common,
    positivePassed: true,
    mutationFalsified: true,
    freshPositivePassed: true,
    skipped: false
  })}`;
}

function assertInventory(candidate) {
  const baseline = withoutKeywordExtensions(candidate);
  assert.deepEqual(
    sorted(Object.keys(candidate.Parameters).filter((name) => !Object.hasOwn(baseline.Parameters, name))),
    sorted(KEYWORD_PARAMETERS)
  );
  assert.deepEqual(Object.keys(candidate.Conditions), ["KeywordResearchEnabledCondition"]);
  assert.deepEqual(
    sorted(Object.keys(candidate.Resources).filter((name) => !Object.hasOwn(baseline.Resources, name))),
    sorted(KEYWORD_RESOURCES)
  );
  assert.deepEqual(
    sorted(Object.keys(candidate.Outputs).filter((name) => !Object.hasOwn(baseline.Outputs, name))),
    sorted(KEYWORD_OUTPUTS)
  );
  assert.deepEqual(candidate.Parameters.KeywordWorkerCodeKey, {
    Type: "String",
    AllowedPattern: "^deployment/[a-f0-9]{64}/keyword-worker\\.zip$"
  });
  assert.deepEqual(candidate.Parameters.KeywordWorkerCodeVersion, {
    Type: "String",
    MinLength: 1,
    MaxLength: 1024
  });
  assert.deepEqual(candidate.Parameters.KeywordResearchEnabled, {
    Type: "String",
    AllowedValues: ["false", "true"],
    Default: "false"
  });
  assert.deepEqual(candidate.Conditions.KeywordResearchEnabledCondition, {
    "Fn::Equals": [{ Ref: "KeywordResearchEnabled" }, "true"]
  });
  assert.deepEqual(candidate.Outputs.KeywordResearchQueueUrl, { Value: { Ref: "KeywordResearchQueue" } });
  assert.deepEqual(candidate.Outputs.KeywordResearchQueueArn, { Value: KEYWORD_QUEUE_ARN });
  assert.deepEqual(candidate.Outputs.KeywordResearchDlqArn, {
    Value: { "Fn::GetAtt": ["KeywordResearchDlq", "Arn"] }
  });
  assert.deepEqual(candidate.Outputs.KeywordWorkerFunctionArn, {
    Value: { "Fn::GetAtt": ["KeywordWorker", "Arn"] }
  });
}

function assertQueueTopology(candidate) {
  assert.deepEqual(candidate.Resources.KeywordResearchDlq, {
    Type: "AWS::SQS::Queue",
    Properties: {
      QueueName: { "Fn::Sub": "${AWS::StackName}-keyword-research-dlq" },
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
      Tags: queueTags("dead-letter")
    }
  });
  assert.deepEqual(candidate.Resources.KeywordResearchQueue, {
    Type: "AWS::SQS::Queue",
    Properties: {
      QueueName: { "Fn::Sub": "${AWS::StackName}-keyword-research" },
      MessageRetentionPeriod: 345600,
      VisibilityTimeout: 1080,
      MaximumMessageSize: 262144,
      ReceiveMessageWaitTimeSeconds: 20,
      SqsManagedSseEnabled: true,
      RedrivePolicy: {
        deadLetterTargetArn: { "Fn::GetAtt": ["KeywordResearchDlq", "Arn"] },
        maxReceiveCount: 5
      },
      Tags: queueTags("source")
    }
  });
  assert.equal(candidate.Resources.KeywordResearchQueue.Properties.VisibilityTimeout,
    6 * candidate.Resources.KeywordWorker.Properties.Timeout);
}

function assertAlarmTopology(candidate) {
  const expected = {
    KeywordResearchDlqDepthAlarm: [
      "${AWS::StackName}-keyword-research-dlq-depth", "ApproximateNumberOfMessagesVisible",
      "Sum", 1, "KeywordResearchDlq"
    ],
    KeywordResearchOldestMessageAlarm: [
      "${AWS::StackName}-keyword-research-oldest-message", "ApproximateAgeOfOldestMessage",
      "Maximum", 300, "KeywordResearchQueue"
    ],
    KeywordWorkerErrorsAlarm: [
      "${AWS::StackName}-keyword-worker-errors", "Errors", "Sum", 1, "KeywordWorker"
    ],
    KeywordWorkerThrottlesAlarm: [
      "${AWS::StackName}-keyword-worker-throttles", "Throttles", "Sum", 1, "KeywordWorker"
    ]
  };
  for (const [name, [alarmName, metric, statistic, threshold, target]] of Object.entries(expected)) {
    const dimension = name.startsWith("KeywordWorker")
      ? { Name: "FunctionName", Value: { Ref: target } }
      : { Name: "QueueName", Value: { "Fn::GetAtt": [target, "QueueName"] } };
    assert.deepEqual(candidate.Resources[name], {
      Type: "AWS::CloudWatch::Alarm",
      Properties: {
        AlarmName: { "Fn::Sub": alarmName },
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        MetricName: metric,
        Namespace: name.startsWith("KeywordWorker") ? "AWS/Lambda" : "AWS/SQS",
        Period: 300,
        Statistic: statistic,
        Threshold: threshold,
        TreatMissingData: "notBreaching",
        Dimensions: [dimension]
      }
    });
  }
}

function assertWorkerTopology(candidate) {
  const resources = candidate.Resources;
  assert.deepEqual(resources.KeywordWorkerLogGroup, {
    Type: "AWS::Logs::LogGroup",
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
    Properties: {
      LogGroupName: { "Fn::Sub": "/aws/lambda/${AWS::StackName}-keyword-worker" },
      RetentionInDays: 30
    }
  });
  const keyword = resources.KeywordWorker;
  assert.equal(keyword.Type, "AWS::Serverless::Function");
  assert.deepEqual(keyword.DependsOn, ["KeywordWorkerLogGroup"]);
  assert.deepEqual(keyword.Properties, {
    FunctionName: { "Fn::Sub": "${AWS::StackName}-keyword-worker" },
    Description: "StoreSignal keyword-worker pipeline handler",
    CodeUri: {
      Bucket: { Ref: "ArtifactBucketName" },
      Key: { Ref: "KeywordWorkerCodeKey" },
      Version: { Ref: "KeywordWorkerCodeVersion" }
    },
    Handler: "index.handler",
    Runtime: "nodejs24.x",
    Architectures: ["x86_64"],
    MemorySize: 1024,
    ReservedConcurrentExecutions: 1,
    Timeout: 180,
    EphemeralStorage: { Size: 512 },
    Role: { "Fn::GetAtt": ["KeywordWorkerRole", "Arn"] },
    Environment: clone(resources.Recovery.Properties.Environment),
    Tracing: "Disabled",
    Tags: { Project: "StoreSignal", Environment: { Ref: "Environment" } }
  });
  assert.deepEqual(resources.KeywordResearchMapping, {
    Type: "AWS::Lambda::EventSourceMapping",
    Properties: {
      Enabled: { "Fn::If": ["KeywordResearchEnabledCondition", true, false] },
      EventSourceArn: { "Fn::GetAtt": ["KeywordResearchQueue", "Arn"] },
      FunctionName: { Ref: "KeywordWorker" },
      BatchSize: 1,
      MaximumBatchingWindowInSeconds: 0,
      FunctionResponseTypes: ["ReportBatchItemFailures"]
    }
  });
  assert.equal(Object.hasOwn(resources.KeywordResearchMapping.Properties, "ScalingConfig"), false);
  assert.equal(Object.hasOwn(resources.KeywordResearchMapping.Properties, "ProvisionedPollerConfig"), false);
  assertAlarmTopology(candidate);
}

function assertRecoveryTopology(candidate) {
  const resources = candidate.Resources;
  const schedules = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Events::Rule");
  assert.deepEqual(schedules.map(([name]) => name), ["RecoverySchedule"]);
  assert.deepEqual(resources.RecoverySchedule, {
    Type: "AWS::Events::Rule",
    Properties: {
      Name: { "Fn::Sub": "${AWS::StackName}-recovery" },
      Description: "Disabled five-minute StoreSignal pipeline recovery scan.",
      ScheduleExpression: "rate(5 minutes)",
      State: "ENABLED",
      Targets: [{
        Arn: { "Fn::GetAtt": ["Recovery", "Arn"] },
        Id: "RecoveryLambda",
        Input: "{\"limit\":100}"
      }]
    }
  });
  const recoveries = Object.entries(resources).filter(([name, resource]) =>
    resource.Type === "AWS::Serverless::Function" && name === "Recovery");
  assert.equal(recoveries.length, 1);
  assert.equal(resources.Recovery.Properties.Handler, "index.handler");
  assert.deepEqual(resources.Recovery.Properties.Environment.Variables.AWS_PIPELINE_KEYWORD_RESEARCH_QUEUE_URL,
    { Ref: "KeywordResearchQueue" });
  assert.deepEqual(resources.Recovery.Properties.Environment.Variables.AWS_PIPELINE_KEYWORD_RESEARCH_ENABLED,
    { "Fn::If": ["KeywordResearchEnabledCondition", "true", "false"] });
}

function assertIamTopology(candidate) {
  const resources = candidate.Resources;
  assert.deepEqual(resources.KeywordWorkerRole, {
    Type: "AWS::IAM::Role",
    Properties: {
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: ["lambda.amazonaws.com"] },
          Action: ["sts:AssumeRole"]
        }]
      },
      Policies: [{
        PolicyName: "PipelineAccess",
        PolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "WriteOwnLogs", Effect: "Allow",
              Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
              Resource: { "Fn::Sub": "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${AWS::StackName}-keyword-worker:*" }
            },
            {
              Sid: "ReadPipelineSecret", Effect: "Allow", Action: ["secretsmanager:GetSecretValue"],
              Resource: { Ref: "PipelineSecret" }
            },
            {
              Sid: "ConsumeAssignedQueues", Effect: "Allow",
              Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"],
              Resource: [KEYWORD_QUEUE_ARN]
            },
            {
              Sid: "SendAssignedQueues", Effect: "Allow", Action: ["sqs:SendMessage"],
              Resource: [KEYWORD_QUEUE_ARN]
            },
            {
              Sid: "ListAssignedArtifactKeys", Effect: "Allow", Action: ["s3:ListBucket"],
              Resource: { "Fn::Sub": "arn:${AWS::Partition}:s3:::${ArtifactBucketName}" },
              Condition: { StringLike: { "s3:prefix": ["runs/keyword-research/*"] } }
            },
            {
              Sid: "ReadAssignedArtifacts", Effect: "Allow", Action: ["s3:GetObject"],
              Resource: [{ "Fn::Sub": "arn:${AWS::Partition}:s3:::${ArtifactBucketName}/runs/keyword-research/*" }]
            },
            {
              Sid: "WriteAssignedArtifacts", Effect: "Allow", Action: ["s3:PutObject"],
              Resource: [{ "Fn::Sub": "arn:${AWS::Partition}:s3:::${ArtifactBucketName}/runs/keyword-research/*" }]
            }
          ]
        }
      }],
      Tags: [
        { Key: "Project", Value: "StoreSignal" },
        { Key: "Environment", Value: { Ref: "Environment" } }
      ]
    }
  });
  assert.deepEqual(statement(resources.RecoveryRole, "SendAssignedQueues").Resource, [
    { "Fn::GetAtt": ["DiscoveryQueue", "Arn"] },
    { "Fn::GetAtt": ["DiscoveryCheckQueue", "Arn"] },
    { "Fn::GetAtt": ["LeadQueue", "Arn"] },
    { "Fn::GetAtt": ["LeadCheckQueue", "Arn"] },
    { "Fn::GetAtt": ["TrafficQueue", "Arn"] },
    { "Fn::GetAtt": ["TrafficCheckQueue", "Arn"] },
    KEYWORD_QUEUE_ARN
  ]);
  assert.deepEqual(statement(resources.ControlPlanePolicy, "StartDiscoveryOnly").Resource, [
    { "Fn::GetAtt": ["DiscoveryQueue", "Arn"] },
    { "Fn::GetAtt": ["DiscoveryCheckQueue", "Arn"] },
    KEYWORD_QUEUE_ARN
  ]);
  for (const resource of [resources.KeywordWorkerRole, resources.RecoveryRole, resources.ControlPlanePolicy]) {
    const statements = resource.Type === "AWS::IAM::ManagedPolicy"
      ? resource.Properties.PolicyDocument.Statement
      : policyStatements(resource);
    for (const item of statements) {
      const actions = Array.isArray(item.Action) ? item.Action : [item.Action];
      const targets = Array.isArray(item.Resource) ? item.Resource : [item.Resource];
      if (actions.some((action) => /^(?:s3|sqs):/u.test(action))) {
        assert.equal(targets.includes("*"), false);
      }
      assert.equal(actions.includes("s3:DeleteObject"), false);
      assert.equal(actions.includes("sqs:PurgeQueue"), false);
    }
  }
}

function evaluateIf(value, active) {
  assert.deepEqual(value["Fn::If"].slice(0, 1), ["KeywordResearchEnabledCondition"]);
  return value["Fn::If"][active ? 1 : 2];
}

function assertActivationAndBaseline(candidate) {
  assert.equal(candidate.Parameters.KeywordResearchEnabled.Default, "false");
  assert.deepEqual(candidate.Conditions.KeywordResearchEnabledCondition,
    { "Fn::Equals": [{ Ref: "KeywordResearchEnabled" }, "true"] });
  const mapping = candidate.Resources.KeywordResearchMapping.Properties.Enabled;
  const worker = candidate.Resources.KeywordWorker.Properties.Environment.Variables
    .AWS_PIPELINE_KEYWORD_RESEARCH_ENABLED;
  const recovery = candidate.Resources.Recovery.Properties.Environment.Variables
    .AWS_PIPELINE_KEYWORD_RESEARCH_ENABLED;
  assert.deepEqual([evaluateIf(mapping, false), evaluateIf(worker, false), evaluateIf(recovery, false)],
    [false, "false", "false"]);
  assert.deepEqual([evaluateIf(mapping, true), evaluateIf(worker, true), evaluateIf(recovery, true)],
    [true, "true", "true"]);
  assert.deepEqual(baselineProjection(candidate), BASELINE_PROJECTION);
}

function runControl(t, id, oracle, mutate) {
  oracle(parseTemplate());
  const changed = parseTemplate();
  mutate(changed);
  assert.throws(() => oracle(changed));
  oracle(parseTemplate());
  t.diagnostic(executionRecord(id, "control"));
}

test("[W7 CASE W7-INFRA-01] exact keyword template member inventory", (t) => {
  assertInventory(parseTemplate());
  t.diagnostic(executionRecord("W7-INFRA-01", "case"));
});

test("[W7 CASE W7-INFRA-02] keyword queue and DLQ properties satisfy the 1080-second visibility contract", (t) => {
  assertQueueTopology(parseTemplate());
  t.diagnostic(executionRecord("W7-INFRA-02", "case"));
});

test("[W7 CASE W7-INFRA-03] keyword worker log mapping alarms and runtime bounds are exact", (t) => {
  assertWorkerTopology(parseTemplate());
  t.diagnostic(executionRecord("W7-INFRA-03", "case"));
});

test("[W7 CASE W7-INFRA-04] the single five-minute schedule invokes the combined recovery handler", (t) => {
  assertRecoveryTopology(parseTemplate());
  t.diagnostic(executionRecord("W7-INFRA-04", "case"));
});

test("[W7 CASE W7-INFRA-05] keyword worker recovery and control-plane IAM remain least privilege", (t) => {
  assertIamTopology(parseTemplate());
  t.diagnostic(executionRecord("W7-INFRA-05", "case"));
});

test("[W7 CASE W7-INFRA-06] activation is default-disabled and every pre-existing member is unchanged", (t) => {
  assertActivationAndBaseline(parseTemplate());
  t.diagnostic(executionRecord("W7-INFRA-06", "case"));
});

test("[W7 CONTROL W7-NC-05] a 360-second keyword visibility timeout is rejected", (t) => {
  runControl(t, "W7-NC-05", assertQueueTopology, (candidate) => {
    candidate.Resources.KeywordResearchQueue.Properties.VisibilityTimeout = 360;
  });
});

test("[W7 CONTROL W7-NC-06] mapping MaximumConcurrency one is rejected", (t) => {
  runControl(t, "W7-NC-06", assertWorkerTopology, (candidate) => {
    candidate.Resources.KeywordResearchMapping.Properties.ScalingConfig = { MaximumConcurrency: 1 };
  });
});

test("[W7 CONTROL W7-NC-07] a second recovery schedule is rejected", (t) => {
  runControl(t, "W7-NC-07", assertRecoveryTopology, (candidate) => {
    candidate.Resources.SecondRecoverySchedule = clone(candidate.Resources.RecoverySchedule);
  });
});

test("[W7 CONTROL W7-NC-08] wildcard keyword data-plane IAM is rejected", (t) => {
  runControl(t, "W7-NC-08", assertIamTopology, (candidate) => {
    statement(candidate.Resources.KeywordWorkerRole, "SendAssignedQueues").Resource[0] = "*";
  });
});

test("[W7 CONTROL W7-NC-09] literal true mapping activation is rejected", (t) => {
  runControl(t, "W7-NC-09", assertActivationAndBaseline, (candidate) => {
    candidate.Resources.KeywordResearchMapping.Properties.Enabled = true;
  });
});
