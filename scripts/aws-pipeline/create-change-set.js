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
  phases: Object.freeze(["bootstrap", "package", "full"]),
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
  if (result.applyReviewedChangeSet && (!result.execute || result.phase !== "full")) {
    fail("--apply-reviewed-change-set requires --phase=full --execute");
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

async function requireApproval(packet) {
  const state = await readFile(statePath, "utf8");
  const token = state.match(/^aws_mutation_approval:\s*([a-f0-9]{64})\s*$/mu)?.[1];
  if (token !== packet.approvalToken) fail("Exact G14 AWS mutation approval is absent or stale");
  if (!/^current_window:\s*G14\s*$/mu.test(state)) fail("G14 is not the active window");
  return true;
}

function parameterArguments(options, packet, manifest = null) {
  const values = [
    ["Environment", options.environment], ["ArtifactBucketName", packet.bucket]
  ];
  if (manifest) for (const item of manifest.objects) {
    values.push([`${item.logicalId}CodeKey`, item.key], [`${item.logicalId}CodeVersion`, item.versionId]);
  }
  return values.map(([key, value]) => `ParameterKey=${key},ParameterValue=${value}`);
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

function changeSetName(kind, packet) {
  return `g14-${kind}-${packet.approvalToken.slice(0, 12)}`;
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
  const name = changeSetName("full", packet);
  if (!options.applyReviewedChangeSet) {
    aws(options, ["cloudformation", "create-change-set", "--stack-name", options.stack,
      "--change-set-name", name, "--change-set-type", "UPDATE", "--template-url",
      templateObjectUrl(options, packet, manifest.template.versionId),
      "--parameters", ...parameterArguments(options, packet, manifest), "--capabilities", "CAPABILITY_IAM",
      "--description", "Approved G14 disabled production pipeline"]);
    aws(options, ["cloudformation", "wait", "change-set-create-complete", "--stack-name", options.stack,
      "--change-set-name", name], { json: false });
  }
  const described = aws(options, ["cloudformation", "describe-change-set", "--stack-name", options.stack,
    "--change-set-name", name]);
  const changes = normalizedChanges(described);
  assertFullChanges(changes, packet);
  await mkdir(deploymentRoot, { recursive: true });
  await writeFile(changeSetRecordPath, `${JSON.stringify({ approvalToken: packet.approvalToken,
    changeSet: name, changeSetId: described.ChangeSetId, changes }, null, 2)}\n`, { mode: 0o600 });
  if (!options.applyReviewedChangeSet) return { outcome: "FULL_CHANGE_SET_REVIEWED", changeSet: name, changes };
  const recorded = JSON.parse(await readFile(changeSetRecordPath, "utf8"));
  if (recorded.approvalToken !== packet.approvalToken || recorded.changeSetId !== described.ChangeSetId ||
      canonical(recorded.changes) !== canonical(changes)) fail("Reviewed change-set record is absent or stale");
  aws(options, ["cloudformation", "execute-change-set", "--stack-name", options.stack,
    "--change-set-name", name]);
  aws(options, ["cloudformation", "wait", "stack-update-complete", "--stack-name", options.stack], { json: false });
  return { outcome: "FULL_STACK_COMPLETE", changeSet: name, changes };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const packet = await buildDeploymentPacket(options);
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify({ mode: "DRY_RUN_NO_AWS", phase: options.phase, ...packet,
      estimatedDisabledUsdPerMonth: 3.11 }, null, 2)}\n`);
    return;
  }
  await requireApproval(packet);
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
