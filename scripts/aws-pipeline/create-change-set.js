import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEPLOYMENT = Object.freeze({
  profile: "storesignal-dev",
  region: "ap-south-2",
  stack: "storesignal-production-pipeline",
  environment: "production",
  phases: Object.freeze(["bootstrap", "package", "full", "activate", "code", "engine", "artifact-access",
    "provider-identity", "lead-work-resume", "lead-memory", "lead-bounded-extraction", "bounded-bulk",
    "traffic-repair", "final-repair", "final-publication-repair", "traffic-publication-repair",
    "crux-month-repair", "provider-identity-fan-in", "run-isolation-repair",
    "traffic-final-lease-exclusion"]),
  handlers: Object.freeze([
    ["DiscoveryWorker", "discovery-worker"],
    ["DomainAggregator", "domain-aggregator"],
    ["LeadWorker", "lead-worker"],
    ["LeadAggregator", "lead-aggregator"],
    ["TrafficWorker", "traffic-worker"],
    ["FinalAggregator", "final-aggregator"],
    ["Recovery", "recovery"]
  ])
});

export const CODE_UPDATE = Object.freeze({
  reservedConcurrency: Object.freeze({
    DiscoveryWorker: 1,
    DomainAggregator: 2,
    LeadWorker: 2,
    LeadAggregator: 2,
    TrafficWorker: 1,
    FinalAggregator: 2,
    Recovery: 1
  }),
  dependentReevaluations: Object.freeze([
    Object.freeze({ logicalId: "RecoveryInvokePermission", type: "AWS::Lambda::Permission",
      replacement: "Conditional" }),
    Object.freeze({ logicalId: "RecoverySchedule", type: "AWS::Events::Rule", replacement: "False" })
  ])
});

export const ARTIFACT_ACCESS_UPDATE = Object.freeze({
  policies: Object.freeze([
    Object.freeze({ logicalId: "ControlPlanePolicy", type: "AWS::IAM::ManagedPolicy", replacement: "False" }),
    Object.freeze({ logicalId: "DiscoveryWorkerRole", type: "AWS::IAM::Role", replacement: "False" }),
    Object.freeze({ logicalId: "LeadWorkerRole", type: "AWS::IAM::Role", replacement: "False" }),
    Object.freeze({ logicalId: "TrafficWorkerRole", type: "AWS::IAM::Role", replacement: "False" })
  ]),
  dependentReevaluations: CODE_UPDATE.dependentReevaluations
});

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspaceRoot = path.resolve(projectRoot, "..");
const bootstrapPath = path.join(projectRoot, "infrastructure", "aws", "bootstrap-template.yaml");
const templatePath = path.join(projectRoot, "infrastructure", "aws", "template.yaml");
const lambdaRoot = path.join(projectRoot, "dist", "lambda");
const deploymentRoot = path.join(projectRoot, "dist", "aws-deployment");
const artifactManifestPath = path.join(deploymentRoot, "manifest.json");
const changeSetRecordPath = path.join(deploymentRoot, "full-change-set.json");
const statePath = path.join(workspaceRoot, "ACTIVE_EXECUTION_STATE.md");
const secretWord = /(?:secret|string|password|credential|authorization|token|private[-_]?key)/iu;

function fail(message) {
  throw new Error(message);
}

export function parseArguments(argv) {
  const result = { execute: false, applyReviewedChangeSet: false };
  for (const raw of argv) {
    if (raw === "--execute") result.execute = true;
    else if (raw === "--apply-reviewed-change-set") result.applyReviewedChangeSet = true;
    else if (raw.startsWith("--") && raw.includes("=")) {
      const split = raw.indexOf("=");
      const key = raw.slice(2, split).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      const value = raw.slice(split + 1);
      if (!value || Object.hasOwn(result, key)) fail(`Invalid or duplicate argument: --${raw.slice(2, split)}`);
      if (secretWord.test(key)) fail("Secret-bearing arguments are forbidden");
      result[key] = value;
    } else fail(`Unknown argument: ${raw}`);
  }
  for (const key of ["profile", "region", "stack", "environment", "phase", "accountId"]) {
    if (!result[key]) fail(`Missing --${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  if (result.profile !== DEPLOYMENT.profile || result.region !== DEPLOYMENT.region ||
      result.stack !== DEPLOYMENT.stack || result.environment !== DEPLOYMENT.environment ||
      !DEPLOYMENT.phases.includes(result.phase) || !/^\d{12}$/u.test(result.accountId)) {
    fail("Deployment identity does not match the locked G14 packet");
  }
  if (result.applyReviewedChangeSet &&
      (!result.execute || !["full", "activate", "code", "engine", "artifact-access", "provider-identity",
        "lead-work-resume", "lead-memory", "lead-bounded-extraction", "bounded-bulk", "traffic-repair",
        "final-repair", "final-publication-repair", "traffic-publication-repair", "crux-month-repair",
        "provider-identity-fan-in", "run-isolation-repair", "traffic-final-lease-exclusion"]
        .includes(result.phase))) {
    fail("--apply-reviewed-change-set requires a reviewed update phase with --execute");
  }
  return Object.freeze(result);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileDetails(file) {
  const body = await readFile(file);
  return { sha256: sha256(body), bytes: body.byteLength };
}

function deployedType(type) {
  return type === "AWS::Serverless::Function" ? "AWS::Lambda::Function" : type;
}

function resourceInventory(template) {
  return Object.entries(template.Resources).map(([logicalId, resource]) => ({
    logicalId, type: deployedType(resource.Type)
  })).sort((left, right) => left.logicalId.localeCompare(right.logicalId));
}

export async function buildDeploymentPacket(options) {
  const [bootstrapBody, templateBody] = await Promise.all([
    readFile(bootstrapPath, "utf8"), readFile(templatePath, "utf8")
  ]);
  const bootstrap = JSON.parse(bootstrapBody);
  const template = JSON.parse(templateBody);
  const templateSha256 = sha256(templateBody);
  const zips = [];
  for (const [logicalId, handler] of DEPLOYMENT.handlers) {
    const file = path.join(lambdaRoot, `${handler}.zip`);
    const details = await fileDetails(file);
    zips.push({ logicalId, handler, file, ...details,
      key: `deployment/${details.sha256}/${handler}.zip` });
  }
  const packet = {
    contractVersion: "storesignal-g14-deployment-v1",
    profile: options.profile,
    accountId: options.accountId,
    region: options.region,
    stack: options.stack,
    environment: options.environment,
    bucket: `storesignal-prod-pipeline-${options.accountId}-${options.region}`,
    bootstrap: { file: path.relative(projectRoot, bootstrapPath), sha256: sha256(bootstrapBody),
      resources: resourceInventory(bootstrap) },
    full: { file: path.relative(projectRoot, templatePath), sha256: templateSha256,
      bytes: Buffer.byteLength(templateBody),
      key: `deployment/${templateSha256}/cloudformation-template.json`,
      resources: resourceInventory(template) },
    zips: zips.map(({ file, ...entry }) => entry),
    mutations: [
      "CREATE_AND_EXECUTE_BOOTSTRAP_CHANGE_SET",
      ...zips.map(({ key }) => `PUT_ENCRYPTED_VERSIONED_OBJECT:${key}`),
      `PUT_ENCRYPTED_VERSIONED_OBJECT:deployment/${templateSha256}/cloudformation-template.json`,
      "CREATE_REVIEW_AND_EXECUTE_FULL_UPDATE_CHANGE_SET"
    ],
    expectedDisabled: {
      eventSourceMappings: 6, recoveryRules: 1, sourceQueueMessages: 0, dlqMessages: 0
    },
    expectedCodeUpdate: CODE_UPDATE,
    expectedEngineUpdate: {
      prismaEngine: "libquery_engine-rhel-openssl-3.0.x.so.node",
      functions: DEPLOYMENT.handlers.map(([logicalId]) => logicalId),
      dependentReevaluations: CODE_UPDATE.dependentReevaluations
    },
    expectedArtifactAccessUpdate: {
      functions: DEPLOYMENT.handlers.map(([logicalId]) => logicalId),
      policies: ARTIFACT_ACCESS_UPDATE.policies,
      dependentReevaluations: ARTIFACT_ACCESS_UPDATE.dependentReevaluations
    },
    expectedProviderIdentityUpdate: {
      functions: DEPLOYMENT.handlers.map(([logicalId]) => logicalId),
      dependentReevaluations: CODE_UPDATE.dependentReevaluations
    },
    expectedLeadWorkResumeUpdate: {
      functions: DEPLOYMENT.handlers.map(([logicalId]) => logicalId),
      dependentReevaluations: CODE_UPDATE.dependentReevaluations
    }
  };
  return Object.freeze({ ...packet, approvalToken: sha256(canonical(packet)) });
}

export function templateObjectUrl(options, packet, versionId) {
  if (!versionId) fail("Versioned CloudFormation template object is required");
  const key = packet.full.key.split("/").map(encodeURIComponent).join("/");
  return `https://${packet.bucket}.s3.${options.region}.amazonaws.com/${key}` +
    `?versionId=${encodeURIComponent(versionId)}`;
}

function aws(options, args, { json = true, allowFailure = false } = {}) {
  const command = [
    ...args, "--profile", options.profile, "--region", options.region,
    "--no-cli-pager", ...(json ? ["--output", "json"] : [])
  ];
  const result = spawnSync("aws", command, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowFailure) return { failed: true, stderr: result.stderr || "" };
    fail(`AWS command failed safely: aws ${args.slice(0, 2).join(" ")}`);
  }
  if (!json) return result.stdout.trim();
  try { return result.stdout.trim() ? JSON.parse(result.stdout) : {}; }
  catch { fail(`AWS command returned invalid JSON: aws ${args.slice(0, 2).join(" ")}`); }
}

async function requireApproval(packet, options) {
  const state = await readFile(statePath, "utf8");
  const token = state.match(/^aws_mutation_approval:\s*([a-f0-9]{64})\s*$/mu)?.[1];
  if (token !== packet.approvalToken) fail("Exact AWS mutation approval is absent or stale");
  if (options.phase === "activate" && !/^current_window:\s*G15\s*$/mu.test(state)) {
    fail("G15 is not the active window");
  }
  if (options.phase === "code" && !/^current_window:\s*G-R12\s*$/mu.test(state)) {
    fail("G-R12 is not the active window");
  }
  if (options.phase === "engine" && !/^current_window:\s*G-R13\s*$/mu.test(state)) {
    fail("G-R13 is not the active window");
  }
  if (options.phase === "artifact-access" && !/^current_window:\s*G-R14\s*$/mu.test(state)) {
    fail("G-R14 is not the active window");
  }
  if (options.phase === "provider-identity" && !/^current_window:\s*G-R15\s*$/mu.test(state)) {
    fail("G-R15 is not the active window");
  }
  if (options.phase === "lead-work-resume" && !/^current_window:\s*G-R17\s*$/mu.test(state)) {
    fail("G-R17 is not the active window");
  }
  if (options.phase === "lead-memory" && !/^current_window:\s*G-R18\s*$/mu.test(state)) {
    fail("G-R18 is not the active window");
  }
  if (options.phase === "lead-bounded-extraction" && !/^current_window:\s*G-R19\s*$/mu.test(state)) {
    fail("G-R19 is not the active window");
  }
  if (options.phase === "bounded-bulk" && !/^current_window:\s*G-R21\s*$/mu.test(state)) {
    fail("G-R21 is not the active window");
  }
  if (options.phase === "traffic-repair" && !/^current_window:\s*G-R21\s*$/mu.test(state)) {
    fail("G-R21 is not the active window");
  }
  if (options.phase === "final-repair" && !/^current_window:\s*G-R21\s*$/mu.test(state)) {
    fail("G-R21 is not the active window");
  }
  if (options.phase === "final-publication-repair" && !/^current_window:\s*G-R24\s*$/mu.test(state)) {
    fail("G-R24 is not the active window");
  }
  if (options.phase === "traffic-publication-repair" && !/^current_window:\s*G-R24\s*$/mu.test(state)) {
    fail("G-R24 is not the active window");
  }
  if (options.phase === "crux-month-repair" && !/^current_window:\s*G-R25\s*$/mu.test(state)) {
    fail("G-R25 is not the active window");
  }
  if (options.phase === "provider-identity-fan-in" && !/^current_window:\s*G-R27\s*$/mu.test(state)) {
    fail("G-R27 is not the active window");
  }
  if (options.phase === "run-isolation-repair" && !/^current_window:\s*G-R28\s*$/mu.test(state)) {
    fail("G-R28 is not the active window");
  }
  if (options.phase === "traffic-final-lease-exclusion" && !/^current_window:\s*G-R29\s*$/mu.test(state)) {
    fail("G-R29 is not the active window");
  }
  return true;
}

export function parameterArguments(options, packet, manifest = null) {
  const values = [
    ["Environment", options.environment], ["ArtifactBucketName", packet.bucket]
  ];
  if (manifest) for (const item of manifest.objects) {
    const selectedRepair = ["traffic-publication-repair", "crux-month-repair"].includes(options.phase) &&
      !["TrafficWorker", "FinalAggregator"].includes(item.logicalId);
    if ((options.phase === "final-publication-repair" && item.logicalId !== "FinalAggregator") || selectedRepair) {
      values.push([`${item.logicalId}CodeKey`, null], [`${item.logicalId}CodeVersion`, null]);
    } else {
      values.push([`${item.logicalId}CodeKey`, item.key], [`${item.logicalId}CodeVersion`, item.versionId]);
    }
  }
  return values.map(([key, value]) => value == null
    ? `ParameterKey=${key},UsePreviousValue=true`
    : `ParameterKey=${key},ParameterValue=${value}`);
}

function normalizedChanges(description) {
  return (description.Changes || []).map(({ ResourceChange: change }) => ({
    action: change.Action,
    logicalId: change.LogicalResourceId,
    type: change.ResourceType,
    replacement: change.Replacement || null
  })).sort((left, right) => left.logicalId.localeCompare(right.logicalId));
}

function assertBootstrapChanges(changes, packet) {
  const expected = packet.bootstrap.resources.map(({ logicalId, type }) => ({ action: "Add", logicalId, type }));
  const actual = changes.map(({ action, logicalId, type }) => ({ action, logicalId, type }));
  if (canonical(actual) !== canonical(expected)) fail("Bootstrap change-set inventory differs from approval packet");
}

function assertFullChanges(changes, packet) {
  const retained = new Set(packet.bootstrap.resources.map(({ logicalId }) => logicalId));
  const expectedAdds = packet.full.resources.filter(({ logicalId }) => !retained.has(logicalId));
  const actualAdds = changes.filter(({ action }) => action === "Add")
    .map(({ logicalId, type }) => ({ logicalId, type }));
  const unsafe = changes.filter(({ action, logicalId, replacement }) =>
    action === "Remove" || replacement === "True" ||
    (action === "Modify" && !retained.has(logicalId)));
  if (unsafe.length || canonical(actualAdds) !== canonical(expectedAdds)) {
    fail("Full change-set inventory differs from approval packet");
  }
}

function assertActivationChanges(changes, description) {
  const expected = [
    ["DiscoveryMapping", "AWS::Lambda::EventSourceMapping", "False"],
    ["DomainAggregationMapping", "AWS::Lambda::EventSourceMapping", "False"],
    ["FinalAggregationMapping", "AWS::Lambda::EventSourceMapping", "False"],
    ["LeadAggregationMapping", "AWS::Lambda::EventSourceMapping", "False"],
    ["LeadMapping", "AWS::Lambda::EventSourceMapping", "False"],
    ["RecoveryInvokePermission", "AWS::Lambda::Permission", "Conditional"],
    ["RecoverySchedule", "AWS::Events::Rule", "False"],
    ["TrafficMapping", "AWS::Lambda::EventSourceMapping", "False"]
  ].map(([logicalId, type, replacement]) => ({ action: "Modify", logicalId, type, replacement }))
    .sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  if (canonical(changes) !== canonical(expected)) {
    fail("Activation change-set inventory differs from the approved eight resources");
  }
  for (const { ResourceChange: change } of description.Changes || []) {
    const details = change.Details || [];
    if (change.LogicalResourceId === "RecoveryInvokePermission") {
      if (details.length !== 1 || details[0].Evaluation !== "Dynamic" ||
          details[0].ChangeSource !== "ResourceAttribute" ||
          details[0].CausingEntity !== "RecoverySchedule.Arn" ||
          details[0].Target?.Name !== "SourceArn" ||
          details[0].Target?.RequiresRecreation !== "Always") {
        fail("Recovery permission dependency change is not the expected schedule-only consequence");
      }
    } else {
      const expectedName = change.LogicalResourceId === "RecoverySchedule" ? "State" : "Enabled";
      if (details.length !== 1 || details[0].Evaluation !== "Static" ||
          details[0].ChangeSource !== "DirectModification" ||
          details[0].Target?.Name !== expectedName ||
          details[0].Target?.RequiresRecreation !== "Never") {
        fail(`Activation detail drift: ${change.LogicalResourceId}`);
      }
    }
  }
}

export function assertCodeChanges(changes, description) {
  const expected = [...DEPLOYMENT.handlers.map(([logicalId]) => ({
    action: "Modify", logicalId, type: "AWS::Lambda::Function", replacement: "False"
  })), ...CODE_UPDATE.dependentReevaluations.map(({ logicalId, type, replacement }) => ({
    action: "Modify", logicalId, type, replacement
  }))].sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  if (canonical(changes) !== canonical(expected)) {
    fail("Code change-set inventory differs from the approved functions and dependencies");
  }
  for (const { ResourceChange: change } of description.Changes || []) {
    if (change.LogicalResourceId === "RecoveryInvokePermission") {
      const details = change.Details || [];
      if (details.length !== 1 || details[0].Evaluation !== "Dynamic" ||
          details[0].ChangeSource !== "ResourceAttribute" ||
          details[0].CausingEntity !== "RecoverySchedule.Arn" ||
          details[0].Target?.Name !== "SourceArn" ||
          details[0].Target?.RequiresRecreation !== "Always") {
        fail("Recovery permission dependency drift");
      }
      continue;
    }
    if (change.LogicalResourceId === "RecoverySchedule") {
      const details = change.Details || [];
      if (details.length !== 1 || details[0].Evaluation !== "Dynamic" ||
          details[0].ChangeSource !== "ResourceAttribute" ||
          details[0].CausingEntity !== "Recovery.Arn" ||
          details[0].Target?.Name !== "Targets" ||
          details[0].Target?.RequiresRecreation !== "Never") {
        fail("Recovery schedule dependency drift");
      }
      continue;
    }
    const details = change.Details || [];
    const parameterNames = new Set([
      `${change.LogicalResourceId}CodeKey`, `${change.LogicalResourceId}CodeVersion`
    ]);
    const parameterCodeDetails = details.filter((detail) =>
      detail.Target?.Name === "Code" && detail.ChangeSource === "ParameterReference");
    const dynamicCodeDetails = details.filter((detail) =>
      detail.Target?.Name === "Code" && detail.ChangeSource === "DirectModification");
    const concurrencyDetails = details.filter((detail) =>
      detail.Target?.Name === "ReservedConcurrentExecutions");
    if (parameterCodeDetails.length !== 2 || dynamicCodeDetails.length !== 1 ||
        concurrencyDetails.length !== 1 || details.length !== 4 ||
        new Set(parameterCodeDetails.map(({ CausingEntity }) => CausingEntity)).size !== 2 ||
        parameterCodeDetails.some((detail) => detail.Evaluation !== "Static" ||
          detail.ChangeSource !== "ParameterReference" || !parameterNames.has(detail.CausingEntity) ||
          detail.Target?.RequiresRecreation !== "Never") ||
        dynamicCodeDetails.some((detail) => detail.Evaluation !== "Dynamic" ||
          detail.CausingEntity != null || detail.Target?.RequiresRecreation !== "Never") ||
        concurrencyDetails.some((detail) => detail.Evaluation !== "Static" ||
          detail.ChangeSource !== "DirectModification" || detail.CausingEntity != null ||
          detail.Target?.RequiresRecreation !== "Never")) {
      fail(`Code detail drift: ${change.LogicalResourceId}`);
    }
  }
}

export function assertEngineChanges(changes, description) {
  const expected = [...DEPLOYMENT.handlers.map(([logicalId]) => ({
    action: "Modify", logicalId, type: "AWS::Lambda::Function", replacement: "False"
  })), ...CODE_UPDATE.dependentReevaluations.map(({ logicalId, type, replacement }) => ({
    action: "Modify", logicalId, type, replacement
  }))].sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  if (canonical(changes) !== canonical(expected)) {
    fail("Engine change-set inventory differs from the approved functions and dependencies");
  }
  for (const { ResourceChange: change } of description.Changes || []) {
    if (change.LogicalResourceId === "RecoveryInvokePermission") {
      const details = change.Details || [];
      if (details.length !== 1 || details[0].Evaluation !== "Dynamic" ||
          details[0].ChangeSource !== "ResourceAttribute" ||
          details[0].CausingEntity !== "RecoverySchedule.Arn" ||
          details[0].Target?.Name !== "SourceArn" ||
          details[0].Target?.RequiresRecreation !== "Always") {
        fail("Recovery permission dependency drift");
      }
      continue;
    }
    if (change.LogicalResourceId === "RecoverySchedule") {
      const details = change.Details || [];
      if (details.length !== 1 || details[0].Evaluation !== "Dynamic" ||
          details[0].ChangeSource !== "ResourceAttribute" ||
          details[0].CausingEntity !== "Recovery.Arn" ||
          details[0].Target?.Name !== "Targets" ||
          details[0].Target?.RequiresRecreation !== "Never") {
        fail("Recovery schedule dependency drift");
      }
      continue;
    }
    const details = change.Details || [];
    const parameterNames = new Set([
      `${change.LogicalResourceId}CodeKey`, `${change.LogicalResourceId}CodeVersion`
    ]);
    const parameterCodeDetails = details.filter((detail) =>
      detail.Target?.Name === "Code" && detail.ChangeSource === "ParameterReference");
    const dynamicCodeDetails = details.filter((detail) =>
      detail.Target?.Name === "Code" && detail.ChangeSource === "DirectModification");
    if (parameterCodeDetails.length !== 2 || dynamicCodeDetails.length !== 1 || details.length !== 3 ||
        new Set(parameterCodeDetails.map(({ CausingEntity }) => CausingEntity)).size !== 2 ||
        parameterCodeDetails.some((detail) => detail.Evaluation !== "Static" ||
          !parameterNames.has(detail.CausingEntity) || detail.Target?.RequiresRecreation !== "Never") ||
        dynamicCodeDetails.some((detail) => detail.Evaluation !== "Dynamic" ||
          detail.CausingEntity != null || detail.Target?.RequiresRecreation !== "Never")) {
      fail(`Engine code detail drift: ${change.LogicalResourceId}`);
    }
  }
}

export function assertProviderIdentityChanges(changes, description) {
  try {
    assertEngineChanges(changes, description);
  } catch (error) {
    fail(String(error?.message || "Provider-identity code detail drift").replaceAll("Engine", "Provider-identity"));
  }
}

export function assertLeadWorkResumeChanges(changes, description) {
  try {
    assertEngineChanges(changes, description);
  } catch (error) {
    fail(String(error?.message || "Lead-work-resume code detail drift").replaceAll("Engine", "Lead-work-resume"));
  }
}

export function assertBoundedBulkChanges(changes, description) {
  try {
    assertEngineChanges(changes, description);
  } catch (error) {
    fail(String(error?.message || "Bounded-bulk code detail drift").replaceAll("Engine", "Bounded-bulk"));
  }
}

export function assertTrafficRepairChanges(changes, description) {
  const expected = [{ action: "Modify", logicalId: "TrafficWorker",
    type: "AWS::Lambda::Function", replacement: "False" }];
  if (canonical(changes) !== canonical(expected)) {
    fail("Traffic-repair change-set inventory differs from the approved TrafficWorker-only update");
  }
  const change = description.Changes?.[0]?.ResourceChange;
  const details = change?.Details || [];
  const parameterNames = new Set(["TrafficWorkerCodeKey", "TrafficWorkerCodeVersion"]);
  const parameterCode = details.filter((detail) => detail.Target?.Name === "Code" &&
    detail.ChangeSource === "ParameterReference");
  const dynamicCode = details.filter((detail) => detail.Target?.Name === "Code" &&
    detail.ChangeSource === "DirectModification");
  if (change?.LogicalResourceId !== "TrafficWorker" || parameterCode.length !== 2 ||
      dynamicCode.length !== 1 || details.length !== 3 ||
      new Set(parameterCode.map(({ CausingEntity }) => CausingEntity)).size !== 2 ||
      parameterCode.some((detail) => detail.Evaluation !== "Static" ||
        !parameterNames.has(detail.CausingEntity) || detail.Target?.RequiresRecreation !== "Never") ||
      dynamicCode.some((detail) => detail.Evaluation !== "Dynamic" ||
        detail.CausingEntity != null || detail.Target?.RequiresRecreation !== "Never")) {
    fail("Traffic-repair code detail drift");
  }
}

export function assertFinalRepairChanges(changes, description) {
  const expected = [{ action: "Modify", logicalId: "FinalAggregator",
    type: "AWS::Lambda::Function", replacement: "False" }];
  if (canonical(changes) !== canonical(expected)) {
    fail("Final-repair change-set inventory differs from the approved FinalAggregator-only update");
  }
  const change = description.Changes?.[0]?.ResourceChange;
  const details = change?.Details || [];
  const parameterNames = new Set(["FinalAggregatorCodeKey", "FinalAggregatorCodeVersion"]);
  const parameterCode = details.filter((detail) => detail.Target?.Name === "Code" &&
    detail.ChangeSource === "ParameterReference");
  const dynamicCode = details.filter((detail) => detail.Target?.Name === "Code" &&
    detail.ChangeSource === "DirectModification");
  if (change?.LogicalResourceId !== "FinalAggregator" || parameterCode.length !== 2 ||
      dynamicCode.length !== 1 || details.length !== 3 ||
      new Set(parameterCode.map(({ CausingEntity }) => CausingEntity)).size !== 2 ||
      parameterCode.some((detail) => detail.Evaluation !== "Static" ||
        !parameterNames.has(detail.CausingEntity) || detail.Target?.RequiresRecreation !== "Never") ||
      dynamicCode.some((detail) => detail.Evaluation !== "Dynamic" ||
        detail.CausingEntity != null || detail.Target?.RequiresRecreation !== "Never")) {
    fail("Final-repair code detail drift");
  }
}

export function assertTrafficPublicationRepairChanges(changes, description) {
  const expected = ["FinalAggregator", "TrafficWorker"].map((logicalId) => ({ action: "Modify", logicalId,
    type: "AWS::Lambda::Function", replacement: "False" }));
  if (canonical(changes) !== canonical(expected)) {
    fail("Traffic-publication-repair inventory differs from the approved two-function update");
  }
  const byId = new Map((description.Changes || []).map((entry) =>
    [entry.ResourceChange?.LogicalResourceId, entry]));
  assertTrafficRepairChanges([expected[1]], { Changes: [byId.get("TrafficWorker")] });
  assertFinalRepairChanges([expected[0]], { Changes: [byId.get("FinalAggregator")] });
}

export function assertProviderIdentityFanInChanges(changes, description) {
  try { assertEngineChanges(changes, description); }
  catch (error) {
    fail(String(error?.message || "Provider-identity-fan-in change drift")
      .replaceAll("Engine", "Provider-identity-fan-in"));
  }
}

export function assertRunIsolationRepairChanges(changes, description) {
  try { assertEngineChanges(changes, description); }
  catch (error) {
    fail(String(error?.message || "Run-isolation-repair change drift")
      .replaceAll("Engine", "Run-isolation-repair"));
  }
}

export function assertTrafficFinalLeaseExclusionChanges(changes, description) {
  try { assertEngineChanges(changes, description); }
  catch (error) {
    fail(String(error?.message || "Traffic-final-lease-exclusion change drift")
      .replaceAll("Engine", "Traffic-final-lease-exclusion"));
  }
}

export function assertLeadMemoryChanges(changes, description) {
  const expected = [{ action: "Modify", logicalId: "LeadWorker",
    type: "AWS::Lambda::Function", replacement: "False" }];
  if (canonical(changes) !== canonical(expected)) {
    fail("Lead-memory change-set inventory differs from the approved LeadWorker-only update");
  }
  const change = description.Changes?.[0]?.ResourceChange;
  const details = change?.Details || [];
  if (change?.LogicalResourceId !== "LeadWorker" || details.length !== 1 ||
      details[0].Evaluation !== "Static" || details[0].ChangeSource !== "DirectModification" ||
      details[0].CausingEntity != null || details[0].Target?.Name !== "MemorySize" ||
      details[0].Target?.RequiresRecreation !== "Never") {
    fail("Lead-memory change detail drift");
  }
}

export function assertLeadBoundedExtractionChanges(changes, description) {
  const expected = ["DiscoveryWorker", "LeadWorker"].map((logicalId) => ({
    action: "Modify", logicalId, type: "AWS::Lambda::Function", replacement: "False"
  })).sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  if (canonical(changes) !== canonical(expected)) {
    fail("Lead-bounded-extraction inventory differs from approved functions and dependencies");
  }
  for (const { ResourceChange: change } of description.Changes || []) {
    const details = change.Details || [];
    const parameterNames = new Set([
      `${change.LogicalResourceId}CodeKey`, `${change.LogicalResourceId}CodeVersion`
    ]);
    const parameterCode = details.filter((detail) => detail.Target?.Name === "Code" &&
      detail.ChangeSource === "ParameterReference");
    const dynamicCode = details.filter((detail) => detail.Target?.Name === "Code" &&
      detail.ChangeSource === "DirectModification");
    const memory = details.filter((detail) => detail.Target?.Name === "MemorySize");
    const expectsMemory = change.LogicalResourceId === "LeadWorker";
    if (parameterCode.length !== 2 || dynamicCode.length !== 1 ||
        memory.length !== (expectsMemory ? 1 : 0) || details.length !== 3 + (expectsMemory ? 1 : 0) ||
        new Set(parameterCode.map(({ CausingEntity }) => CausingEntity)).size !== 2 ||
        parameterCode.some((detail) => detail.Evaluation !== "Static" ||
          !parameterNames.has(detail.CausingEntity) || detail.Target?.RequiresRecreation !== "Never") ||
        dynamicCode.some((detail) => detail.Evaluation !== "Dynamic" ||
          detail.CausingEntity != null || detail.Target?.RequiresRecreation !== "Never") ||
        memory.some((detail) => detail.Evaluation !== "Static" ||
          detail.ChangeSource !== "DirectModification" || detail.CausingEntity != null ||
          detail.Target?.RequiresRecreation !== "Never")) {
      fail(`Lead-bounded-extraction detail drift: ${change.LogicalResourceId}`);
    }
  }
}

export function assertArtifactAccessChanges(changes, description) {
  const expected = [...DEPLOYMENT.handlers.map(([logicalId]) => ({
    action: "Modify", logicalId, type: "AWS::Lambda::Function", replacement: "False"
  })), ...ARTIFACT_ACCESS_UPDATE.policies.map(({ logicalId, type, replacement }) => ({
    action: "Modify", logicalId, type, replacement
  })), ...ARTIFACT_ACCESS_UPDATE.dependentReevaluations.map(({ logicalId, type, replacement }) => ({
    action: "Modify", logicalId, type, replacement
  }))].sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  if (canonical(changes) !== canonical(expected)) {
    fail("Artifact-access change-set inventory differs from the approved functions, policies, and dependencies");
  }
  const policyTargets = new Map([
    ["ControlPlanePolicy", "PolicyDocument"],
    ["DiscoveryWorkerRole", "Policies"],
    ["LeadWorkerRole", "Policies"],
    ["TrafficWorkerRole", "Policies"]
  ]);
  for (const { ResourceChange: change } of description.Changes || []) {
    const details = change.Details || [];
    if (change.LogicalResourceId === "RecoveryInvokePermission") {
      if (details.length !== 1 || details[0].Evaluation !== "Dynamic" ||
          details[0].ChangeSource !== "ResourceAttribute" ||
          details[0].CausingEntity !== "RecoverySchedule.Arn" ||
          details[0].Target?.Name !== "SourceArn" ||
          details[0].Target?.RequiresRecreation !== "Always") {
        fail("Artifact-access Recovery permission dependency drift");
      }
      continue;
    }
    if (change.LogicalResourceId === "RecoverySchedule") {
      if (details.length !== 1 || details[0].Evaluation !== "Dynamic" ||
          details[0].ChangeSource !== "ResourceAttribute" ||
          details[0].CausingEntity !== "Recovery.Arn" ||
          details[0].Target?.Name !== "Targets" ||
          details[0].Target?.RequiresRecreation !== "Never") {
        fail("Artifact-access Recovery schedule dependency drift");
      }
      continue;
    }
    const policyTarget = policyTargets.get(change.LogicalResourceId);
    if (policyTarget) {
      if (details.length !== 1 || details[0].Evaluation !== "Static" ||
          details[0].ChangeSource !== "DirectModification" || details[0].CausingEntity != null ||
          details[0].Target?.Name !== policyTarget ||
          details[0].Target?.RequiresRecreation !== "Never") {
        fail(`Artifact-access policy detail drift: ${change.LogicalResourceId}`);
      }
      continue;
    }
    const parameterNames = new Set([
      `${change.LogicalResourceId}CodeKey`, `${change.LogicalResourceId}CodeVersion`
    ]);
    const parameterCodeDetails = details.filter((detail) =>
      detail.Target?.Name === "Code" && detail.ChangeSource === "ParameterReference");
    const dynamicCodeDetails = details.filter((detail) =>
      detail.Target?.Name === "Code" && detail.ChangeSource === "DirectModification");
    const roleDetails = details.filter((detail) => detail.Target?.Name === "Role");
    const expectsRoleDependency = ["DiscoveryWorker", "LeadWorker", "TrafficWorker"]
      .includes(change.LogicalResourceId);
    if (parameterCodeDetails.length !== 2 || dynamicCodeDetails.length !== 1 ||
        roleDetails.length !== (expectsRoleDependency ? 1 : 0) ||
        details.length !== 3 + (expectsRoleDependency ? 1 : 0) ||
        new Set(parameterCodeDetails.map(({ CausingEntity }) => CausingEntity)).size !== 2 ||
        parameterCodeDetails.some((detail) => detail.Evaluation !== "Static" ||
          !parameterNames.has(detail.CausingEntity) || detail.Target?.RequiresRecreation !== "Never") ||
        dynamicCodeDetails.some((detail) => detail.Evaluation !== "Dynamic" ||
          detail.CausingEntity != null || detail.Target?.RequiresRecreation !== "Never") ||
        roleDetails.some((detail) => detail.Evaluation !== "Dynamic" ||
          detail.ChangeSource !== "ResourceAttribute" ||
          detail.CausingEntity !== `${change.LogicalResourceId}Role.Arn` ||
          detail.Target?.RequiresRecreation !== "Never")) {
      fail(`Artifact-access code detail drift: ${change.LogicalResourceId}`);
    }
  }
}

function changeSetName(kind, packet) {
  const prefix = kind === "activate" ? "g15" : kind === "code" ? "gr12" :
    kind === "engine" ? "gr13" : kind === "artifact-access" ? "gr14" :
      kind === "provider-identity" ? "gr15" : kind === "lead-work-resume" ? "gr17" :
        kind === "lead-memory" ? "gr18" : kind === "lead-bounded-extraction" ? "gr19" :
          ["bounded-bulk", "traffic-repair", "final-repair"].includes(kind) ? "gr21" :
            ["final-publication-repair", "traffic-publication-repair"].includes(kind) ? "gr24" :
              kind === "crux-month-repair" ? "gr25" :
                kind === "provider-identity-fan-in" ? "gr26" :
                  kind === "run-isolation-repair" ? "gr28" :
                    kind === "traffic-final-lease-exclusion" ? "gr29" : "g14";
  return `${prefix}-${kind}-${packet.approvalToken.slice(0, 12)}`;
}

function assertStackBucket(options, packet) {
  const stack = aws(options, ["cloudformation", "describe-stacks", "--stack-name", options.stack]);
  const outputs = Object.fromEntries((stack.Stacks?.[0]?.Outputs || [])
    .map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
  if (outputs.ArtifactBucketName !== packet.bucket) fail("Deployed bootstrap bucket does not match approval packet");
  return stack.Stacks[0];
}

async function executeBootstrap(options, packet) {
  const existing = aws(options, ["cloudformation", "describe-stacks", "--stack-name", options.stack],
    { allowFailure: true });
  if (!existing.failed) fail("Bootstrap refuses to adopt an existing stack");
  if (!/(?:does not exist|ValidationError)/iu.test(existing.stderr)) {
    fail("Bootstrap could not prove that the target stack is absent");
  }
  const name = changeSetName("bootstrap", packet);
  aws(options, ["cloudformation", "create-change-set", "--stack-name", options.stack,
    "--change-set-name", name, "--change-set-type", "CREATE", "--template-body", `file://${bootstrapPath}`,
    "--parameters", ...parameterArguments(options, packet), "--description", "Approved G14 private bucket bootstrap"]);
  aws(options, ["cloudformation", "wait", "change-set-create-complete", "--stack-name", options.stack,
    "--change-set-name", name], { json: false });
  const described = aws(options, ["cloudformation", "describe-change-set", "--stack-name", options.stack,
    "--change-set-name", name]);
  const changes = normalizedChanges(described);
  assertBootstrapChanges(changes, packet);
  aws(options, ["cloudformation", "execute-change-set", "--stack-name", options.stack,
    "--change-set-name", name]);
  aws(options, ["cloudformation", "wait", "stack-create-complete", "--stack-name", options.stack], { json: false });
  assertStackBucket(options, packet);
  return { outcome: "BOOTSTRAP_COMPLETE", changeSet: name, changes };
}

async function matchingObjectVersion(options, packet, item) {
  const head = aws(options, ["s3api", "head-object", "--bucket", packet.bucket,
    "--key", item.key], { allowFailure: true });
  if (head.failed) {
    if (/(?:404|Not Found|NoSuchKey)/iu.test(head.stderr)) return null;
    fail(`Deployment object could not be reconciled: ${item.label}`);
  }
  if (head.Metadata?.sha256 === item.sha256 && head.ContentLength === item.bytes &&
      head.ServerSideEncryption === "AES256" && head.VersionId) {
    return { versionId: head.VersionId, etag: head.ETag,
      checksumSha256: head.ChecksumSHA256 || null };
  }
  fail(`Deployment key conflict: ${item.label}`);
}

async function storeDeploymentObject(options, packet, item) {
  const existing = await matchingObjectVersion(options, packet, item);
  let stored = existing;
  if (!stored) {
    const checksum = createHash("sha256").update(await readFile(item.file)).digest("base64");
    const response = aws(options, ["s3api", "put-object", "--bucket", packet.bucket,
      "--key", item.key, "--body", item.file, "--server-side-encryption", "AES256",
      "--checksum-algorithm", "SHA256", "--checksum-sha256", checksum,
      "--metadata", `sha256=${item.sha256}`,
      ...(item.contentType ? ["--content-type", item.contentType] : [])]);
    if (!response.VersionId) fail(`Versioned PutObject did not return a version: ${item.label}`);
    stored = { versionId: response.VersionId, etag: response.ETag,
      checksumSha256: response.ChecksumSHA256 || checksum };
  }
  return stored;
}

async function executePackage(options, packet) {
  assertStackBucket(options, packet);
  const objects = [];
  for (const item of packet.zips) {
    const file = path.join(lambdaRoot, `${item.handler}.zip`);
    const stored = await storeDeploymentObject(options, packet, {
      ...item, file, label: item.handler, contentType: "application/zip"
    });
    objects.push({ logicalId: item.logicalId, handler: item.handler, key: item.key,
      sha256: item.sha256, bytes: item.bytes, ...stored });
  }
  const templateStored = await storeDeploymentObject(options, packet, {
    file: templatePath, key: packet.full.key, sha256: packet.full.sha256,
    bytes: packet.full.bytes, label: "cloudformation-template", contentType: "application/json"
  });
  const templateObject = { key: packet.full.key, sha256: packet.full.sha256,
    bytes: packet.full.bytes, ...templateStored };
  aws(options, ["cloudformation", "validate-template", "--template-url",
    templateObjectUrl(options, packet, templateObject.versionId)]);
  const manifest = { contractVersion: "storesignal-g14-package-v1", accountId: options.accountId,
    region: options.region, stack: options.stack, bucket: packet.bucket, approvalToken: packet.approvalToken,
    template: templateObject, objects };
  await mkdir(deploymentRoot, { recursive: true });
  await writeFile(artifactManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { outcome: "PACKAGES_READY", manifest: path.relative(projectRoot, artifactManifestPath),
    template: templateObject, objects };
}

async function loadArtifactManifest(options, packet) {
  const manifest = JSON.parse(await readFile(artifactManifestPath, "utf8"));
  if (manifest.contractVersion !== "storesignal-g14-package-v1" ||
      manifest.accountId !== options.accountId || manifest.region !== options.region ||
      manifest.stack !== options.stack || manifest.bucket !== packet.bucket ||
      manifest.approvalToken !== packet.approvalToken || manifest.objects?.length !== packet.zips.length) {
    fail("Artifact manifest does not match approval packet");
  }
  if (manifest.template?.key !== packet.full.key || manifest.template?.sha256 !== packet.full.sha256 ||
      manifest.template?.bytes !== packet.full.bytes || !manifest.template?.versionId) {
    fail("CloudFormation template manifest drift");
  }
  for (const item of packet.zips) {
    const stored = manifest.objects.find(({ logicalId }) => logicalId === item.logicalId);
    if (!stored || stored.handler !== item.handler || stored.key !== item.key ||
        stored.sha256 !== item.sha256 || stored.bytes !== item.bytes || !stored.versionId) {
      fail(`Artifact manifest drift: ${item.handler}`);
    }
  }
  return manifest;
}

async function executeFull(options, packet) {
  assertStackBucket(options, packet);
  const manifest = await loadArtifactManifest(options, packet);
  const activation = options.phase === "activate";
  const code = options.phase === "code";
  const engine = options.phase === "engine";
  const artifactAccess = options.phase === "artifact-access";
  const providerIdentity = options.phase === "provider-identity";
  const leadWorkResume = options.phase === "lead-work-resume";
  const leadMemory = options.phase === "lead-memory";
  const leadBoundedExtraction = options.phase === "lead-bounded-extraction";
  const boundedBulk = options.phase === "bounded-bulk";
  const trafficRepair = options.phase === "traffic-repair";
  const finalRepair = options.phase === "final-repair";
  const finalPublicationRepair = options.phase === "final-publication-repair";
  const trafficPublicationRepair = options.phase === "traffic-publication-repair";
  const cruxMonthRepair = options.phase === "crux-month-repair";
  const providerIdentityFanIn = options.phase === "provider-identity-fan-in";
  const runIsolationRepair = options.phase === "run-isolation-repair";
  const trafficFinalLeaseExclusion = options.phase === "traffic-final-lease-exclusion";
  const name = changeSetName(activation ? "activate" : code ? "code" : engine ? "engine" :
    artifactAccess ? "artifact-access" : providerIdentity ? "provider-identity" :
      leadWorkResume ? "lead-work-resume" : leadMemory ? "lead-memory" :
        leadBoundedExtraction ? "lead-bounded-extraction" : boundedBulk ? "bounded-bulk" :
          trafficRepair ? "traffic-repair" : finalRepair ? "final-repair" :
            finalPublicationRepair ? "final-publication-repair" :
              trafficPublicationRepair ? "traffic-publication-repair" :
                cruxMonthRepair ? "crux-month-repair" :
                  providerIdentityFanIn ? "provider-identity-fan-in" :
                    runIsolationRepair ? "run-isolation-repair" :
                      trafficFinalLeaseExclusion ? "traffic-final-lease-exclusion" : "full", packet);
  if (!options.applyReviewedChangeSet) {
    aws(options, ["cloudformation", "create-change-set", "--stack-name", options.stack,
      "--change-set-name", name, "--change-set-type", "UPDATE", "--template-url",
      templateObjectUrl(options, packet, manifest.template.versionId),
      "--parameters", ...parameterArguments(options, packet, manifest), "--capabilities", "CAPABILITY_IAM",
      "--description", activation ? "Approved G15 production pipeline activation" :
        code ? "Approved G-R12 Lambda code correction" :
          engine ? "Approved G-R13 Amazon Linux Prisma engine correction" :
            artifactAccess ? "Approved G-R14 scoped optional-artifact access correction" :
              providerIdentity ? "Approved G-R15 provider identity fallback correction" :
                leadWorkResume ? "Approved G-R17 same-task lead-work recovery correction" :
                  leadMemory ? "Approved G-R18 lead-worker memory correction" :
                    leadBoundedExtraction ? "Approved G-R19 bounded invalid-mailto extraction correction" :
                      boundedBulk ? "Approved G-R21 guarded G-R20 bounded-bulk deployment" :
                        trafficRepair ? "Approved G-R21 TrafficWorker diagnostic repair" :
                          finalRepair ? "Approved G-R21 FinalAggregator diagnostic repair" :
                            finalPublicationRepair ? "Approved G-R24 final publication recovery repair" :
                              trafficPublicationRepair ? "Approved G-R24 provider and traffic publication repair" :
                                cruxMonthRepair ? "Approved G-R25 CrUX month publication repair" :
                                  providerIdentityFanIn ? "Approved G-R27 complete provider identity fan-in package closure" :
                                    runIsolationRepair ? "Approved G-R28 run-isolated provider work correction" :
                                      trafficFinalLeaseExclusion ? "Approved G-R29 atomic traffic/final lease exclusion" :
                "Approved G14 disabled production pipeline"]);
    aws(options, ["cloudformation", "wait", "change-set-create-complete", "--stack-name", options.stack,
      "--change-set-name", name], { json: false });
  }
  const described = aws(options, ["cloudformation", "describe-change-set", "--stack-name", options.stack,
    "--change-set-name", name]);
  const changes = normalizedChanges(described);
  if (activation) assertActivationChanges(changes, described);
  else if (code) assertCodeChanges(changes, described);
  else if (engine) assertEngineChanges(changes, described);
  else if (artifactAccess) assertArtifactAccessChanges(changes, described);
  else if (providerIdentity) assertProviderIdentityChanges(changes, described);
  else if (leadWorkResume) assertLeadWorkResumeChanges(changes, described);
  else if (leadMemory) assertLeadMemoryChanges(changes, described);
  else if (leadBoundedExtraction) assertLeadBoundedExtractionChanges(changes, described);
  else if (boundedBulk) assertBoundedBulkChanges(changes, described);
  else if (trafficRepair) assertTrafficRepairChanges(changes, described);
  else if (finalRepair) assertFinalRepairChanges(changes, described);
  else if (finalPublicationRepair) assertFinalRepairChanges(changes, described);
  else if (providerIdentityFanIn) assertProviderIdentityFanInChanges(changes, described);
  else if (runIsolationRepair) assertRunIsolationRepairChanges(changes, described);
  else if (trafficFinalLeaseExclusion) assertTrafficFinalLeaseExclusionChanges(changes, described);
  else if (trafficPublicationRepair || cruxMonthRepair)
    assertTrafficPublicationRepairChanges(changes, described);
  else assertFullChanges(changes, packet);
  await mkdir(deploymentRoot, { recursive: true });
  await writeFile(changeSetRecordPath, `${JSON.stringify({ approvalToken: packet.approvalToken,
    changeSet: name, changeSetId: described.ChangeSetId, changes }, null, 2)}\n`, { mode: 0o600 });
  if (!options.applyReviewedChangeSet) return { outcome: activation ? "ACTIVATION_CHANGE_SET_REVIEWED" :
    code ? "CODE_CHANGE_SET_REVIEWED" : engine ? "ENGINE_CHANGE_SET_REVIEWED" :
      artifactAccess ? "ARTIFACT_ACCESS_CHANGE_SET_REVIEWED" :
        providerIdentity ? "PROVIDER_IDENTITY_CHANGE_SET_REVIEWED" :
          leadWorkResume ? "LEAD_WORK_RESUME_CHANGE_SET_REVIEWED" :
            leadMemory ? "LEAD_MEMORY_CHANGE_SET_REVIEWED" :
              leadBoundedExtraction ? "LEAD_BOUNDED_EXTRACTION_CHANGE_SET_REVIEWED" :
                boundedBulk ? "BOUNDED_BULK_CHANGE_SET_REVIEWED" :
                  trafficRepair ? "TRAFFIC_REPAIR_CHANGE_SET_REVIEWED" :
                    finalRepair ? "FINAL_REPAIR_CHANGE_SET_REVIEWED" :
                      finalPublicationRepair ? "FINAL_PUBLICATION_REPAIR_CHANGE_SET_REVIEWED" :
                        trafficPublicationRepair ? "TRAFFIC_PUBLICATION_REPAIR_CHANGE_SET_REVIEWED" :
                          cruxMonthRepair ? "CRUX_MONTH_REPAIR_CHANGE_SET_REVIEWED" :
                            providerIdentityFanIn ? "PROVIDER_IDENTITY_FAN_IN_CHANGE_SET_REVIEWED" :
                              runIsolationRepair ? "RUN_ISOLATION_REPAIR_CHANGE_SET_REVIEWED" :
                                trafficFinalLeaseExclusion ? "TRAFFIC_FINAL_LEASE_EXCLUSION_CHANGE_SET_REVIEWED" :
      "FULL_CHANGE_SET_REVIEWED", changeSet: name, changes };
  const recorded = JSON.parse(await readFile(changeSetRecordPath, "utf8"));
  if (recorded.approvalToken !== packet.approvalToken || recorded.changeSetId !== described.ChangeSetId ||
      canonical(recorded.changes) !== canonical(changes)) fail("Reviewed change-set record is absent or stale");
  aws(options, ["cloudformation", "execute-change-set", "--stack-name", options.stack,
    "--change-set-name", name]);
  aws(options, ["cloudformation", "wait", "stack-update-complete", "--stack-name", options.stack], { json: false });
  return { outcome: activation ? "ACTIVE_STACK_COMPLETE" : code ? "CODE_STACK_COMPLETE" :
    engine ? "ENGINE_STACK_COMPLETE" : artifactAccess ? "ARTIFACT_ACCESS_STACK_COMPLETE" :
      providerIdentity ? "PROVIDER_IDENTITY_STACK_COMPLETE" :
        leadWorkResume ? "LEAD_WORK_RESUME_STACK_COMPLETE" :
      leadMemory ? "LEAD_MEMORY_STACK_COMPLETE" :
        leadBoundedExtraction ? "LEAD_BOUNDED_EXTRACTION_STACK_COMPLETE" :
          boundedBulk ? "BOUNDED_BULK_STACK_COMPLETE" :
            trafficRepair ? "TRAFFIC_REPAIR_STACK_COMPLETE" :
              finalRepair ? "FINAL_REPAIR_STACK_COMPLETE" :
                finalPublicationRepair ? "FINAL_PUBLICATION_REPAIR_STACK_COMPLETE" :
                  cruxMonthRepair ? "CRUX_MONTH_REPAIR_STACK_COMPLETE" :
                    providerIdentityFanIn ? "PROVIDER_IDENTITY_FAN_IN_STACK_COMPLETE" :
                      runIsolationRepair ? "RUN_ISOLATION_REPAIR_STACK_COMPLETE" :
                        trafficFinalLeaseExclusion ? "TRAFFIC_FINAL_LEASE_EXCLUSION_STACK_COMPLETE" :
      "FULL_STACK_COMPLETE", changeSet: name, changes };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const packet = await buildDeploymentPacket(options);
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify({ mode: "DRY_RUN_NO_AWS", phase: options.phase, ...packet,
      estimatedDisabledUsdPerMonth: 3.11 }, null, 2)}\n`);
    return;
  }
  await requireApproval(packet, options);
  let result;
  if (options.phase === "bootstrap") result = await executeBootstrap(options, packet);
  else if (options.phase === "package") result = await executePackage(options, packet);
  else result = await executeFull(options, packet);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || "G14 deployment command failed"}\n`);
    process.exitCode = 1;
  });
}
