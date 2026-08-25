import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEPLOYMENT = Object.freeze({
  profile: "storesignal-dev",
  region: "ap-south-2",
  stack: "storesignal-production-pipeline",
  environment: "production",
  phases: Object.freeze(["full", "activate"])
});

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspaceRoot = path.resolve(projectRoot, "..");
const templatePath = path.join(projectRoot, "infrastructure", "aws", "template.yaml");
const lambdaRoot = path.join(projectRoot, "dist", "lambda");
const deploymentRoot = path.join(projectRoot, "dist", "aws-deployment", "keyword-intelligence");
const packetPath = path.join(deploymentRoot, "packet.json");
const artifactRecordPath = path.join(deploymentRoot, "artifacts.json");
const statePath = path.join(workspaceRoot, "ACTIVE_EXECUTION_STATE.md");
const secretWord = /(?:secret|string|password|credential|authorization|token|private[-_]?key)/iu;

const ZIP_SOURCES = Object.freeze([
  Object.freeze({ logicalId: "KeywordWorker", basename: "keyword-worker.zip" }),
  Object.freeze({ logicalId: "Recovery", basename: "recovery.zip" })
]);

const FULL_ADDS = Object.freeze([
  ["KeywordResearchDlq", "AWS::SQS::Queue"],
  ["KeywordResearchQueue", "AWS::SQS::Queue"],
  ["KeywordWorkerLogGroup", "AWS::Logs::LogGroup"],
  ["KeywordWorkerRole", "AWS::IAM::Role"],
  ["KeywordWorker", "AWS::Lambda::Function"],
  ["KeywordResearchMapping", "AWS::Lambda::EventSourceMapping"],
  ["KeywordResearchDlqDepthAlarm", "AWS::CloudWatch::Alarm"],
  ["KeywordResearchOldestMessageAlarm", "AWS::CloudWatch::Alarm"],
  ["KeywordWorkerErrorsAlarm", "AWS::CloudWatch::Alarm"],
  ["KeywordWorkerThrottlesAlarm", "AWS::CloudWatch::Alarm"]
]);

const FULL_DIRECT = Object.freeze([
  ["ControlPlanePolicy", "AWS::IAM::ManagedPolicy"],
  ["RecoveryRole", "AWS::IAM::Role"],
  ["Recovery", "AWS::Lambda::Function"]
]);

const ACTIVATE_DIRECT = Object.freeze([
  ["KeywordResearchMapping", "AWS::Lambda::EventSourceMapping", "Enabled"],
  ["KeywordWorker", "AWS::Lambda::Function", "Environment"],
  ["Recovery", "AWS::Lambda::Function", "Environment"]
]);

const OPTIONAL_DEPENDENCIES = Object.freeze([
  ["RecoveryInvokePermission", "AWS::Lambda::Permission", "Conditional"],
  ["RecoverySchedule", "AWS::Events::Rule", "False"]
]);

const CODE_PARAMETERS = Object.freeze([
  "DiscoveryWorker", "DomainAggregator", "LeadWorker", "LeadAggregator",
  "TrafficWorker", "FinalAggregator", "Recovery", "KeywordWorker"
]);

function fail(message) {
  throw new Error(message);
}

function assertIdentity(options) {
  if (options.profile !== DEPLOYMENT.profile || options.region !== DEPLOYMENT.region ||
      options.stack !== DEPLOYMENT.stack || options.environment !== DEPLOYMENT.environment ||
      !DEPLOYMENT.phases.includes(options.phase) || !/^\d{12}$/u.test(options.accountId || "")) {
    fail("Deployment identity does not match the locked keyword deployment");
  }
}

export function parseArguments(argv) {
  const result = { execute: false, applyReviewedChangeSet: false };
  for (const raw of argv) {
    if (raw === "--execute") result.execute = true;
    else if (raw === "--apply-reviewed-change-set") result.applyReviewedChangeSet = true;
    else if (raw.startsWith("--") && raw.includes("=")) {
      const split = raw.indexOf("=");
      const rawKey = raw.slice(2, split);
      const key = rawKey.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      const value = raw.slice(split + 1);
      if (!value || Object.hasOwn(result, key)) fail(`Invalid or duplicate argument: --${rawKey}`);
      if (secretWord.test(key)) fail("Secret-bearing arguments are forbidden");
      result[key] = value;
    } else fail(`Unknown argument: ${raw}`);
  }
  for (const key of ["profile", "region", "stack", "environment", "phase", "accountId"]) {
    if (!result[key]) {
      const argument = key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
      fail(`Missing --${argument}`);
    }
  }
  assertIdentity(result);
  if (result.applyReviewedChangeSet && !result.execute) {
    fail("--apply-reviewed-change-set requires --execute");
  }
  return Object.freeze(result);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

async function sourceDetails(absolute, source, basename, logicalId = undefined) {
  const body = await readFile(absolute);
  return Object.freeze({
    ...(logicalId ? { logicalId } : {}),
    basename,
    source,
    bytes: body.byteLength,
    sha256: sha256(body),
    key: `deployment/${sha256(body)}/${basename}`
  });
}

export async function buildDeploymentPacket(options) {
  assertIdentity(options);
  const template = await sourceDetails(
    templatePath,
    "infrastructure/aws/template.yaml",
    "cloudformation-template.json"
  );
  const zips = [];
  for (const item of ZIP_SOURCES) {
    zips.push(await sourceDetails(
      path.join(lambdaRoot, item.basename),
      `dist/lambda/${item.basename}`,
      item.basename,
      item.logicalId
    ));
  }
  const packet = {
    contractVersion: "storesignal-keyword-deployment-v1",
    profile: options.profile,
    accountId: options.accountId,
    region: options.region,
    stack: options.stack,
    environment: options.environment,
    bucket: `storesignal-prod-pipeline-${options.accountId}-${options.region}`,
    template,
    zips
  };
  return Object.freeze({ ...packet, approvalToken: sha256(canonical(packet)) });
}

function sourcePath(item) {
  return path.join(projectRoot, ...item.source.split("/"));
}

async function assertSource(item) {
  const body = await readFile(sourcePath(item));
  if (body.byteLength !== item.bytes || sha256(body) !== item.sha256 ||
      item.key !== `deployment/${item.sha256}/${item.basename}`) {
    fail(`Deployment source/hash drift: ${item.basename}`);
  }
  return body;
}

async function assertAllSources(packet) {
  await assertSource(packet.template);
  for (const item of packet.zips) await assertSource(item);
}

function aws(options, args, { json = true, allowFailure = false } = {}) {
  const command = [
    ...args,
    "--profile", options.profile,
    "--region", options.region,
    "--no-cli-pager",
    ...(json ? ["--output", "json"] : [])
  ];
  const result = spawnSync("aws", command, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowFailure) return { failed: true, stderr: result.stderr || "" };
    fail(`AWS command failed safely: aws ${args.slice(0, 2).join(" ")}`);
  }
  if (!json) return result.stdout.trim();
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  } catch {
    fail(`AWS command returned invalid JSON: aws ${args.slice(0, 2).join(" ")}`);
  }
}

function expectedAction(options) {
  if (options.phase === "full") {
    return options.applyReviewedChangeSet ? "W8-ACT-02" : "W8-ACT-01";
  }
  return "W8-ACT-02";
}

async function requireApproval(packet, options) {
  const state = await readFile(statePath, "utf8");
  const token = state.match(/^aws_mutation_approval:\s*([a-f0-9]{64})\s*$/mu)?.[1];
  const action = expectedAction(options);
  if (!/^current_window:\s*KI-W8\s*$/mu.test(state) || token !== packet.approvalToken ||
      !new RegExp(`^authorized_actions:\\s*\\[[^\\]]*${action}[^\\]]*\\]\\s*$`, "mu").test(state)) {
    fail("Exact KI-W8 phase/action approval is absent or stale");
  }
}

function normalizedChanges(description) {
  return (description.Changes || []).map(({ ResourceChange: change }) => ({
    action: change?.Action,
    logicalId: change?.LogicalResourceId,
    type: change?.ResourceType,
    replacement: change?.Replacement || null,
    details: change?.Details || []
  })).sort((left, right) => left.logicalId.localeCompare(right.logicalId));
}

function projection(change) {
  return {
    action: change.action,
    logicalId: change.logicalId,
    type: change.type,
    replacement: change.replacement
  };
}

function expectedProjection(action, [logicalId, type, replacement = null]) {
  return { action, logicalId, type, replacement };
}

function assertDependencyDetails(change) {
  if (change.logicalId === "RecoveryInvokePermission") {
    if (change.details.length !== 1 || change.details[0].Evaluation !== "Dynamic" ||
        change.details[0].ChangeSource !== "ResourceAttribute" ||
        change.details[0].CausingEntity !== "RecoverySchedule.Arn" ||
        change.details[0].Target?.Name !== "SourceArn" ||
        change.details[0].Target?.RequiresRecreation !== "Always") {
      fail("Recovery permission dependency drift");
    }
    return;
  }
  if (change.details.length !== 1 || change.details[0].Evaluation !== "Dynamic" ||
      change.details[0].ChangeSource !== "ResourceAttribute" ||
      change.details[0].CausingEntity !== "Recovery.Arn" ||
      change.details[0].Target?.Name !== "Targets" ||
      change.details[0].Target?.RequiresRecreation !== "Never") {
    fail("Recovery schedule dependency drift");
  }
}

function assertActivationDetails(change, expectedTarget) {
  if (change.details.length !== 1 || change.details[0].Evaluation !== "Static" ||
      change.details[0].ChangeSource !== "DirectModification" ||
      change.details[0].CausingEntity != null ||
      change.details[0].Target?.Name !== expectedTarget ||
      change.details[0].Target?.RequiresRecreation !== "Never") {
    fail(`Activation detail drift: ${change.logicalId}`);
  }
}

export function assertReviewedChanges(phase, description) {
  if (!DEPLOYMENT.phases.includes(phase) || !description || typeof description !== "object") {
    fail("Reviewed change-set input is invalid");
  }
  const changes = normalizedChanges(description);
  if (!changes.length || changes.some((change) => change.action === "Remove" ||
      change.replacement === "True" || !change.logicalId || !change.type)) {
    fail("Reviewed change set contains a remove, replacement, or incomplete member");
  }
  const dependencyIds = new Set(OPTIONAL_DEPENDENCIES.map(([logicalId]) => logicalId));
  const dependencies = changes.filter(({ logicalId }) => dependencyIds.has(logicalId));
  if (new Set(dependencies.map(({ logicalId }) => logicalId)).size !== dependencies.length) {
    fail("Reviewed change set repeats a dependency member");
  }
  for (const dependency of dependencies) {
    const expected = OPTIONAL_DEPENDENCIES.find(([logicalId]) => logicalId === dependency.logicalId);
    if (canonical(projection(dependency)) !== canonical(expectedProjection("Modify", expected))) {
      fail(`Dependency allowlist drift: ${dependency.logicalId}`);
    }
    assertDependencyDetails(dependency);
  }
  const direct = changes.filter(({ logicalId }) => !dependencyIds.has(logicalId));
  const expected = phase === "full"
    ? [
        ...FULL_ADDS.map((entry) => expectedProjection("Add", entry)),
        ...FULL_DIRECT.map((entry) => expectedProjection("Modify", [...entry, "False"]))
      ]
    : ACTIVATE_DIRECT.map((entry) => expectedProjection("Modify", [entry[0], entry[1], "False"]));
  const actual = direct.map(projection);
  if (canonical(actual.sort((a, b) => a.logicalId.localeCompare(b.logicalId))) !==
      canonical(expected.sort((a, b) => a.logicalId.localeCompare(b.logicalId)))) {
    fail(`${phase} change-set inventory differs from the exact allowlist`);
  }
  if (phase === "activate") {
    for (const entry of ACTIVATE_DIRECT) {
      assertActivationDetails(direct.find(({ logicalId }) => logicalId === entry[0]), entry[2]);
    }
  }
  return Object.freeze(changes.map((change) => Object.freeze(projection(change))));
}

async function assertTarget(options, packet) {
  const identity = aws(options, ["sts", "get-caller-identity"]);
  if (identity.Account !== options.accountId) fail("STS account differs from the approved account");
  const response = aws(options, ["cloudformation", "describe-stacks", "--stack-name", options.stack]);
  const stack = response.Stacks?.[0];
  if (!stack || !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus)) {
    fail("Production stack is not complete");
  }
  const outputs = Object.fromEntries((stack.Outputs || [])
    .map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
  if (outputs.ArtifactBucketName !== packet.bucket) {
    fail("Production artifact bucket differs from the packet");
  }
}

async function storeObject(options, packet, item) {
  const prior = aws(options, ["s3api", "head-object", "--bucket", packet.bucket, "--key", item.key],
    { allowFailure: true });
  if (!prior.failed) {
    await assertSource(item);
    if (prior.Metadata?.sha256 !== item.sha256 || prior.ContentLength !== item.bytes ||
        prior.ServerSideEncryption !== "AES256" || !prior.VersionId) {
      fail(`Deployment key conflict: ${item.basename}`);
    }
    return Object.freeze({ ...item, versionId: prior.VersionId });
  }
  if (!/(?:404|Not Found|NoSuchKey)/iu.test(prior.stderr)) {
    fail(`Deployment object could not be reconciled: ${item.basename}`);
  }
  const body = await assertSource(item);
  const checksum = createHash("sha256").update(body).digest("base64");
  const response = aws(options, [
    "s3api", "put-object", "--bucket", packet.bucket, "--key", item.key,
    "--body", sourcePath(item), "--server-side-encryption", "AES256",
    "--checksum-algorithm", "SHA256", "--checksum-sha256", checksum,
    "--metadata", `sha256=${item.sha256}`,
    "--content-type", item.basename.endsWith(".zip") ? "application/zip" : "application/json"
  ]);
  if (!response.VersionId) fail(`Versioned PutObject did not return a version: ${item.basename}`);
  const confirmed = aws(options, ["s3api", "head-object", "--bucket", packet.bucket, "--key", item.key,
    "--version-id", response.VersionId]);
  if (confirmed.Metadata?.sha256 !== item.sha256 || confirmed.ContentLength !== item.bytes ||
      confirmed.ServerSideEncryption !== "AES256" || confirmed.VersionId !== response.VersionId) {
    fail(`Encrypted versioned object confirmation failed: ${item.basename}`);
  }
  return Object.freeze({ ...item, versionId: response.VersionId });
}

async function writePrivate(file, value) {
  await mkdir(deploymentRoot, { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function uploadArtifacts(options, packet) {
  const template = await storeObject(options, packet, packet.template);
  const zips = [];
  for (const item of packet.zips) zips.push(await storeObject(options, packet, item));
  const record = Object.freeze({
    contractVersion: "storesignal-keyword-artifacts-v1",
    approvalToken: packet.approvalToken,
    accountId: packet.accountId,
    region: packet.region,
    stack: packet.stack,
    bucket: packet.bucket,
    template,
    zips
  });
  await writePrivate(artifactRecordPath, record);
  return record;
}

function assertRecordedItem(recorded, expected) {
  if (recorded.basename !== expected.basename || recorded.source !== expected.source ||
      recorded.bytes !== expected.bytes || recorded.sha256 !== expected.sha256 ||
      recorded.key !== expected.key || recorded.logicalId !== expected.logicalId || !recorded.versionId) {
    fail(`Recorded deployment object drift: ${expected.basename}`);
  }
}

async function loadArtifacts(packet) {
  const record = JSON.parse(await readFile(artifactRecordPath, "utf8"));
  if (record.contractVersion !== "storesignal-keyword-artifacts-v1" ||
      record.approvalToken !== packet.approvalToken || record.accountId !== packet.accountId ||
      record.region !== packet.region || record.stack !== packet.stack || record.bucket !== packet.bucket ||
      record.zips?.length !== 2) {
    fail("Artifact record is absent or stale");
  }
  assertRecordedItem(record.template, packet.template);
  for (const item of packet.zips) {
    const recorded = record.zips.find(({ logicalId }) => logicalId === item.logicalId);
    if (!recorded) fail(`Artifact record is missing: ${item.basename}`);
    assertRecordedItem(recorded, item);
  }
  return record;
}

function templateUrl(options, packet, versionId) {
  if (!versionId) fail("Versioned CloudFormation template object is required");
  const key = packet.template.key.split("/").map(encodeURIComponent).join("/");
  return `https://${packet.bucket}.s3.${options.region}.amazonaws.com/${key}` +
    `?versionId=${encodeURIComponent(versionId)}`;
}

function parameterArguments(options, artifacts) {
  const values = [["Environment", null], ["ArtifactBucketName", null]];
  for (const logicalId of CODE_PARAMETERS) {
    const uploaded = artifacts.zips.find((item) => item.logicalId === logicalId);
    const useUploaded = options.phase === "full" && ["Recovery", "KeywordWorker"].includes(logicalId);
    values.push([`${logicalId}CodeKey`, useUploaded ? uploaded.key : null]);
    values.push([`${logicalId}CodeVersion`, useUploaded ? uploaded.versionId : null]);
  }
  values.push(["KeywordResearchEnabled", options.phase === "activate" ? "true" : "false"]);
  return values.map(([key, value]) => value == null
    ? `ParameterKey=${key},UsePreviousValue=true`
    : `ParameterKey=${key},ParameterValue=${value}`);
}

function changeSetName(options, packet) {
  return `ki-${options.phase}-${packet.approvalToken.slice(0, 12)}`;
}

function changeSetRecordPath(phase) {
  return path.join(deploymentRoot, `${phase}-change-set.json`);
}

async function createReviewedChangeSet(options, packet, artifacts) {
  await assertAllSources(packet);
  const name = changeSetName(options, packet);
  aws(options, [
    "cloudformation", "create-change-set", "--stack-name", options.stack,
    "--change-set-name", name, "--change-set-type", "UPDATE",
    "--template-url", templateUrl(options, packet, artifacts.template.versionId),
    "--parameters", ...parameterArguments(options, artifacts),
    "--capabilities", "CAPABILITY_IAM",
    "--description", options.phase === "full"
      ? "Approved disabled keyword-intelligence deployment"
      : "Approved keyword-intelligence activation"
  ]);
  aws(options, ["cloudformation", "wait", "change-set-create-complete", "--stack-name", options.stack,
    "--change-set-name", name], { json: false });
  const described = aws(options, ["cloudformation", "describe-change-set", "--stack-name", options.stack,
    "--change-set-name", name]);
  if (!described.ChangeSetId) fail("Reviewed change set has no stable ID");
  const changes = assertReviewedChanges(options.phase, described);
  const record = Object.freeze({
    contractVersion: "storesignal-keyword-change-set-v1",
    approvalToken: packet.approvalToken,
    phase: options.phase,
    changeSetName: name,
    changeSetId: described.ChangeSetId,
    changes
  });
  await writePrivate(changeSetRecordPath(options.phase), record);
  return Object.freeze({ outcome: "CHANGE_SET_REVIEWED", ...record });
}

async function applyReviewedChangeSet(options, packet) {
  await assertAllSources(packet);
  const record = JSON.parse(await readFile(changeSetRecordPath(options.phase), "utf8"));
  if (record.contractVersion !== "storesignal-keyword-change-set-v1" ||
      record.approvalToken !== packet.approvalToken || record.phase !== options.phase ||
      record.changeSetName !== changeSetName(options, packet) || !record.changeSetId) {
    fail("Reviewed change-set record is absent or stale");
  }
  const described = aws(options, ["cloudformation", "describe-change-set", "--stack-name", options.stack,
    "--change-set-name", record.changeSetId]);
  if (described.ChangeSetId !== record.changeSetId) fail("Reviewed change-set ID drift");
  const changes = assertReviewedChanges(options.phase, described);
  if (canonical(changes) !== canonical(record.changes)) fail("Reviewed change-set content drift");
  aws(options, ["cloudformation", "execute-change-set", "--stack-name", options.stack,
    "--change-set-name", record.changeSetId]);
  aws(options, ["cloudformation", "wait", "stack-update-complete", "--stack-name", options.stack],
    { json: false });
  return Object.freeze({ outcome: "REVIEWED_CHANGE_SET_APPLIED", phase: options.phase,
    changeSetId: record.changeSetId, changes });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const packet = await buildDeploymentPacket(options);
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify({ mode: "DRY_RUN_NO_AWS", phase: options.phase, ...packet }, null, 2)}\n`);
    return;
  }
  await requireApproval(packet, options);
  await assertTarget(options, packet);
  let result;
  if (options.applyReviewedChangeSet) {
    result = await applyReviewedChangeSet(options, packet);
  } else {
    const artifacts = options.phase === "full" ? await uploadArtifacts(options, packet) : await loadArtifacts(packet);
    await writePrivate(packetPath, packet);
    result = await createReviewedChangeSet(options, packet, artifacts);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || "Keyword deployment command failed"}\n`);
    process.exitCode = 1;
  });
}
