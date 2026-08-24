import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEPLOYMENT,
  assertReviewedChanges,
  parseArguments
} from "../scripts/keyword-intelligence/create-change-set.js";
import { parseInspectArguments } from "../scripts/keyword-intelligence/inspect-stack.js";

const W7_OWNER_REGISTRY = Object.freeze({"owner":"deployment_guard","requiredCases":["W7-DEPLOY-01","W7-DEPLOY-02","W7-CONF-01"],"requiredControls":["W7-NC-11","W7-NC-12"]}); // W7-REGISTRY

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EVIDENCE_DIRECTORY_PATTERN = /^ki-w7-i001\.[A-Za-z0-9]{6}$/u;
const MAX_TAP_BYTES = 4_194_304;
const MAX_BUILD_BYTES = 65_536;
const CASES = Object.freeze([
  "W7-BUILD-01", "W7-CONF-01", "W7-DEPLOY-01", "W7-DEPLOY-02",
  "W7-INFRA-01", "W7-INFRA-02", "W7-INFRA-03", "W7-INFRA-04",
  "W7-INFRA-05", "W7-INFRA-06", "W7-RUNTIME-01", "W7-RUNTIME-02"
]);
const CONTROLS = Object.freeze([
  "W7-NC-01", "W7-NC-02", "W7-NC-03", "W7-NC-04",
  "W7-NC-05", "W7-NC-06", "W7-NC-07", "W7-NC-08",
  "W7-NC-09", "W7-NC-10", "W7-NC-11", "W7-NC-12"
]);
const CASE_DIGEST = "6bacf5d9291362ee0d01f5d0d8e3e53f8f9e214a6ebbf5711497c80f3d74aa2e";
const CONTROL_DIGEST = "6950a20f91b666c03cf59c495576e72ad1501fcd58aa5f4378900bd473edafd7";
const BUILD_ASSERTIONS = Object.freeze([
  "keywordByteIdentical",
  "establishedSiblingsUnchanged",
  "inventorySafe",
  "zipWithinLimit",
  "expandedWithinLimit",
  "exactEngine",
  "coldImport"
]);
const ESTABLISHED_ZIP_PATHS = Object.freeze([
  "dist/lambda/discovery-worker.zip",
  "dist/lambda/domain-aggregator.zip",
  "dist/lambda/final-aggregator.zip",
  "dist/lambda/lead-aggregator.zip",
  "dist/lambda/lead-worker.zip",
  "dist/lambda/recovery.zip",
  "dist/lambda/traffic-worker.zip"
]);
const OWNER_FILES = Object.freeze([
  Object.freeze({
    owner: "runtime_config",
    path: path.join(PROJECT_ROOT, "test", "aws-pipeline-runtime-adapters.test.js"),
    requiredCases: ["W7-RUNTIME-01"],
    requiredControls: ["W7-NC-01", "W7-NC-02"]
  }),
  Object.freeze({
    owner: "runtime_composition",
    path: path.join(PROJECT_ROOT, "test", "keyword-intelligence-deployment-runtime.test.js"),
    requiredCases: ["W7-RUNTIME-02"],
    requiredControls: ["W7-NC-03", "W7-NC-04"]
  }),
  Object.freeze({
    owner: "infrastructure",
    path: path.join(PROJECT_ROOT, "test", "keyword-intelligence-infrastructure.test.js"),
    requiredCases: [
      "W7-INFRA-01", "W7-INFRA-02", "W7-INFRA-03",
      "W7-INFRA-04", "W7-INFRA-05", "W7-INFRA-06"
    ],
    requiredControls: ["W7-NC-05", "W7-NC-06", "W7-NC-07", "W7-NC-08", "W7-NC-09"]
  }),
  Object.freeze({
    owner: "build",
    path: path.join(PROJECT_ROOT, "test", "keyword-intelligence-build.test.js"),
    requiredCases: ["W7-BUILD-01"],
    requiredControls: ["W7-NC-10"]
  }),
  Object.freeze({
    owner: "deployment_guard",
    path: THIS_FILE,
    requiredCases: ["W7-DEPLOY-01", "W7-DEPLOY-02", "W7-CONF-01"],
    requiredControls: ["W7-NC-11", "W7-NC-12"]
  })
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setDigest(values) {
  return sha256(Buffer.from(`${[...values].sort().join("\n")}\n`, "utf8"));
}

function exactKeys(value, keys) {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true);
  assert.deepEqual(Object.keys(value), keys);
}

function requireSha256(value) {
  assert.equal(typeof value, "string");
  assert.match(value, SHA256_PATTERN);
}

function certificateInvalid() {
  return Object.assign(new Error("W7_EXECUTION_CERTIFICATE_INVALID"), {
    code: "W7_EXECUTION_CERTIFICATE_INVALID"
  });
}

function invalidUnless(callback) {
  try {
    return callback();
  } catch {
    throw certificateInvalid();
  }
}

function readOwnerRegistry(filePath) {
  const source = readFileSync(filePath, "utf8");
  const matches = [...source.matchAll(
    /^const W7_OWNER_REGISTRY = Object\.freeze\((\{.*\})\); \/\/ W7-REGISTRY$/gmu
  )];
  assert.equal(matches.length, 1);
  const registry = JSON.parse(matches[0][1]);
  exactKeys(registry, ["owner", "requiredCases", "requiredControls"]);
  assert.equal(typeof registry.owner, "string");
  assert.equal(Array.isArray(registry.requiredCases), true);
  assert.equal(Array.isArray(registry.requiredControls), true);
  assert.equal(new Set(registry.requiredCases).size, registry.requiredCases.length);
  assert.equal(new Set(registry.requiredControls).size, registry.requiredControls.length);
  return registry;
}

function readRegistries() {
  const registries = OWNER_FILES.map((expected) => {
    const actual = readOwnerRegistry(expected.path);
    assert.deepEqual(actual, {
      owner: expected.owner,
      requiredCases: expected.requiredCases,
      requiredControls: expected.requiredControls
    });
    return actual;
  });
  const requiredCases = registries.flatMap(({ requiredCases }) => requiredCases).sort();
  const requiredControls = registries.flatMap(({ requiredControls }) => requiredControls).sort();
  assert.deepEqual(requiredCases, CASES);
  assert.deepEqual(requiredControls, CONTROLS);
  assert.equal(setDigest(requiredCases), CASE_DIGEST);
  assert.equal(setDigest(requiredControls), CONTROL_DIGEST);
  return { registries, requiredCases, requiredControls };
}

function ownerFor(id, registries, member) {
  const matches = registries.filter((registry) => registry[member].includes(id));
  assert.equal(matches.length, 1);
  return matches[0].owner;
}

function validateBridge(bytes) {
  assert.equal(Buffer.isBuffer(bytes), true);
  assert.ok(bytes.length >= 1 && bytes.length <= MAX_BUILD_BYTES);
  const text = bytes.toString("utf8");
  assert.equal(Buffer.from(text, "utf8").equals(bytes), true);
  const value = JSON.parse(text);
  assert.equal(canonicalBytes(value).equals(bytes), true);
  exactKeys(value, [
    "schema", "producerAssessmentId", "producerGateId", "keyword",
    "stableMeasurementSha256", "establishedZipHashes", "assertions"
  ]);
  assert.equal(value.schema, "ki-w7-build-evidence-v1");
  assert.equal(value.producerAssessmentId, "KI-W7-I001");
  assert.equal(value.producerGateId, "KI-W7-CV3");
  exactKeys(value.keyword, [
    "path", "firstSha256", "secondSha256", "zipBytes", "unzippedBytes",
    "fileListHash", "requiredEngine", "enginePresent", "coldImportHandlerType"
  ]);
  assert.equal(value.keyword.path, "dist/lambda/keyword-worker.zip");
  requireSha256(value.keyword.firstSha256);
  requireSha256(value.keyword.secondSha256);
  assert.equal(value.keyword.firstSha256, value.keyword.secondSha256);
  assert.equal(Number.isInteger(value.keyword.zipBytes), true);
  assert.ok(value.keyword.zipBytes >= 1 && value.keyword.zipBytes <= 47_185_920);
  assert.equal(Number.isInteger(value.keyword.unzippedBytes), true);
  assert.ok(value.keyword.unzippedBytes >= 1 && value.keyword.unzippedBytes <= 209_715_200);
  requireSha256(value.keyword.fileListHash);
  assert.equal(value.keyword.requiredEngine, "libquery_engine-rhel-openssl-3.0.x.so.node");
  assert.equal(value.keyword.enginePresent, true);
  assert.equal(value.keyword.coldImportHandlerType, "function");
  exactKeys(value.stableMeasurementSha256, ["first", "second"]);
  requireSha256(value.stableMeasurementSha256.first);
  requireSha256(value.stableMeasurementSha256.second);
  assert.equal(value.stableMeasurementSha256.first, value.stableMeasurementSha256.second);
  assert.equal(Array.isArray(value.establishedZipHashes), true);
  assert.equal(value.establishedZipHashes.length, ESTABLISHED_ZIP_PATHS.length);
  value.establishedZipHashes.forEach((item, index) => {
    exactKeys(item, ["path", "sha256"]);
    assert.equal(item.path, ESTABLISHED_ZIP_PATHS[index]);
    requireSha256(item.sha256);
  });
  exactKeys(value.assertions, BUILD_ASSERTIONS);
  for (const name of BUILD_ASSERTIONS) assert.equal(value.assertions[name], true);
  assert.equal(/(?:\/home\/|DATABASE_URL|PASSWORD|PRIVATE_KEY|API_KEY|authorization)/iu.test(text), false);
  return value;
}

function validateBuildCertificate(value, buildEvidenceBytes) {
  exactKeys(value, ["schema", "caseId", "evidenceSha256", "activated", "assertions"]);
  assert.equal(value.schema, "ki-w7-build-case-certificate-v1");
  assert.equal(value.caseId, "W7-BUILD-01");
  requireSha256(value.evidenceSha256);
  assert.equal(value.evidenceSha256, sha256(buildEvidenceBytes));
  assert.equal(value.activated, true);
  assert.deepEqual(value.assertions, BUILD_ASSERTIONS);
  return value;
}

function validateExecutionRecord(record, id, kind, owner) {
  if (kind === "case") {
    exactKeys(record, [
      "schema", "id", "kind", "owner", "executed", "activated", "oraclePassed", "skipped"
    ]);
    assert.equal(record.oraclePassed, true);
  } else {
    exactKeys(record, [
      "schema", "id", "kind", "owner", "executed", "activated",
      "positivePassed", "mutationFalsified", "freshPositivePassed", "skipped"
    ]);
    assert.equal(record.positivePassed, true);
    assert.equal(record.mutationFalsified, true);
    assert.equal(record.freshPositivePassed, true);
  }
  assert.equal(record.schema, "ki-w7-execution-record-v1");
  assert.equal(record.id, id);
  assert.equal(record.kind, kind);
  assert.equal(record.owner, owner);
  assert.equal(record.executed, true);
  assert.equal(record.activated, true);
  assert.equal(record.skipped, false);
}

function parseFocusedTapInternal(text, { buildEvidenceBytes }) {
  assert.equal(typeof text, "string");
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_TAP_BYTES);
  assert.equal(text.includes("\r"), false);
  validateBridge(buildEvidenceBytes);
  const { registries, requiredCases, requiredControls } = readRegistries();
  const requiredIds = new Set([...requiredCases, ...requiredControls]);
  const subtests = new Map();
  const results = new Map();
  const records = new Map();
  const buildCertificates = [];
  let ignoredNonW7TopLevelCount = 0;

  const subtestPattern = /^# Subtest: \[W7 (CASE|CONTROL) ([A-Z0-9-]+)\] ([^\r\n]+)$/u;
  const resultPattern = /^(ok|not ok) [0-9]+ - \[W7 (CASE|CONTROL) ([A-Z0-9-]+)\] ([^\r\n]+?)(?: # (SKIP|TODO).*)?$/u;
  const recordPattern = /^[ ]*# KI_W7_EXECUTION_RECORD_V1=(\{.*\})$/u;
  const buildPattern = /^[ ]*# KI_W7_BUILD_CASE_CERTIFICATE_V1=(\{.*\})$/u;

  for (const line of text.split("\n")) {
    const subtest = line.match(subtestPattern);
    if (subtest) {
      const [, rawKind, id, title] = subtest;
      assert.equal(requiredIds.has(id), true);
      assert.equal(subtests.has(id), false);
      subtests.set(id, { kind: rawKind.toLowerCase(), title });
      continue;
    }
    const result = line.match(resultPattern);
    if (result) {
      const [, status, rawKind, id, title, directive] = result;
      assert.equal(requiredIds.has(id), true);
      assert.equal(results.has(id), false);
      assert.equal(status, "ok");
      assert.equal(directive, undefined);
      results.set(id, { kind: rawKind.toLowerCase(), title });
      continue;
    }
    const record = line.match(recordPattern);
    if (record) {
      const value = JSON.parse(record[1]);
      assert.equal(typeof value.id, "string");
      assert.equal(requiredIds.has(value.id), true);
      assert.equal(records.has(value.id), false);
      records.set(value.id, value);
      continue;
    }
    const build = line.match(buildPattern);
    if (build) {
      buildCertificates.push(JSON.parse(build[1]));
      continue;
    }
    if (/^# Subtest: /u.test(line)) {
      assert.equal(line.includes("[W7 "), false);
      assert.equal(line.includes("KI_W7_"), false);
      ignoredNonW7TopLevelCount += 1;
      continue;
    }
    if (line.includes("[W7 ") || line.includes("KI_W7_EXECUTION_RECORD_V1=") ||
        line.includes("KI_W7_BUILD_CASE_CERTIFICATE_V1=")) {
      assert.fail("malformed W7 TAP member");
    }
  }

  assert.deepEqual([...subtests.keys()].sort(), [...requiredIds].sort());
  assert.deepEqual([...results.keys()].sort(), [...requiredIds].sort());
  assert.deepEqual([...records.keys()].sort(), [...requiredIds].sort());
  for (const id of requiredIds) {
    const subtest = subtests.get(id);
    const result = results.get(id);
    assert.deepEqual(result, subtest);
    const kind = requiredCases.includes(id) ? "case" : "control";
    assert.equal(subtest.kind, kind);
    validateExecutionRecord(
      records.get(id),
      id,
      kind,
      ownerFor(id, registries, kind === "case" ? "requiredCases" : "requiredControls")
    );
  }
  assert.equal(buildCertificates.length, 1);
  const buildCaseCertificate = validateBuildCertificate(buildCertificates[0], buildEvidenceBytes);

  return {
    schema: "ki-w7-focused-certificate-v1",
    producerAssessmentId: "KI-W7-I001",
    producerGateId: "KI-W7-CV4",
    requiredCases,
    registeredCases: [...requiredCases],
    executedCases: [...requiredCases],
    activatedCases: [...requiredCases],
    requiredControls,
    registeredControls: [...requiredControls],
    executedControls: [...requiredControls],
    activatedControls: [...requiredControls],
    falsifiedControls: [...requiredControls],
    freshPositiveControls: [...requiredControls],
    skippedIds: [],
    duplicateIds: [],
    unexpectedIds: [],
    unactivatedIds: [],
    buildCaseCertificate,
    ignoredNonW7TopLevelCount,
    result: "PASS"
  };
}

export function parseFocusedTap(text, options) {
  return invalidUnless(() => parseFocusedTapInternal(text, options));
}

function requireInputFile(filePath, basename, maximumBytes, evidenceDirectory) {
  assert.equal(typeof filePath, "string");
  assert.equal(path.isAbsolute(filePath), true);
  assert.equal(path.resolve(filePath), filePath);
  assert.equal(path.basename(filePath), basename);
  assert.equal(path.dirname(filePath), evidenceDirectory);
  const metadata = lstatSync(filePath);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.ok(metadata.size >= 1 && metadata.size <= maximumBytes);
  assert.equal(realpathSync(filePath), filePath);
  return metadata.size;
}

function validateCliPaths(argv) {
  assert.deepEqual(argv.slice(0, 1), ["--parse-w7-focused-tap"]);
  assert.equal(argv.length, 7);
  assert.deepEqual([argv[1], argv[3], argv[5]], ["--tap", "--build-evidence", "--output"]);
  const tapPath = argv[2];
  const buildPath = argv[4];
  const outputPath = argv[6];
  for (const item of [tapPath, buildPath, outputPath]) {
    assert.equal(typeof item, "string");
    assert.equal(path.isAbsolute(item), true);
    assert.equal(path.resolve(item), item);
  }
  const evidenceDirectory = path.dirname(tapPath);
  assert.equal(path.dirname(buildPath), evidenceDirectory);
  assert.equal(path.dirname(outputPath), evidenceDirectory);
  assert.match(path.basename(evidenceDirectory), EVIDENCE_DIRECTORY_PATTERN);
  assert.equal(realpathSync(evidenceDirectory), evidenceDirectory);
  assert.equal(lstatSync(evidenceDirectory).isDirectory(), true);
  requireInputFile(tapPath, "focused.tap", MAX_TAP_BYTES, evidenceDirectory);
  requireInputFile(buildPath, "build-evidence.json", MAX_BUILD_BYTES, evidenceDirectory);
  assert.equal(path.basename(outputPath), "focused-certificate.json");
  assert.equal(existsSync(outputPath), false);
  assert.equal(existsSync(`${outputPath}.tmp`), false);
  return { tapPath, buildPath, outputPath };
}

function writeCertificateAtomically(outputPath, bytes) {
  const temporaryPath = `${outputPath}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assert.equal((statSync(temporaryPath).mode & 0o777), 0o600);
    renameSync(temporaryPath, outputPath);
    assert.equal((statSync(outputPath).mode & 0o777), 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) rmSync(temporaryPath);
    throw error;
  }
}

export function runFocusedParserCli(argv) {
  return invalidUnless(() => {
    const { tapPath, buildPath, outputPath } = validateCliPaths(argv);
    const tapBytes = readFileSync(tapPath);
    assert.ok(tapBytes.length >= 1 && tapBytes.length <= MAX_TAP_BYTES);
    const tapText = tapBytes.toString("utf8");
    assert.equal(Buffer.from(tapText, "utf8").equals(tapBytes), true);
    const buildEvidenceBytes = readFileSync(buildPath);
    assert.ok(buildEvidenceBytes.length >= 1 && buildEvidenceBytes.length <= MAX_BUILD_BYTES);
    const certificate = parseFocusedTapInternal(tapText, { buildEvidenceBytes });
    const bytes = canonicalBytes(certificate);
    writeCertificateAtomically(outputPath, bytes);
    return Object.freeze({ outputPath, sha256: sha256(bytes), certificate });
  });
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

function canonicalToken(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalToken).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalToken(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deploymentPacketFixture() {
  const templateBytes = readFileSync(path.join(PROJECT_ROOT, "infrastructure", "aws", "template.yaml"));
  const sources = [
    { logicalId: "KeywordWorker", basename: "keyword-worker.zip", bytes: Buffer.from("keyword-zip") },
    { logicalId: "Recovery", basename: "recovery.zip", bytes: Buffer.from("recovery-zip") }
  ];
  const templateSha = sha256(templateBytes);
  const packetWithoutToken = {
    contractVersion: "storesignal-keyword-deployment-v1",
    profile: DEPLOYMENT.profile,
    accountId: "123456789012",
    region: DEPLOYMENT.region,
    stack: DEPLOYMENT.stack,
    environment: DEPLOYMENT.environment,
    bucket: "storesignal-prod-pipeline-123456789012-ap-south-2",
    template: {
      basename: "cloudformation-template.json",
      source: "infrastructure/aws/template.yaml",
      bytes: templateBytes.length,
      sha256: templateSha,
      key: `deployment/${templateSha}/cloudformation-template.json`
    },
    zips: sources.map((source) => {
      const digest = sha256(source.bytes);
      return {
        logicalId: source.logicalId,
        basename: source.basename,
        source: `dist/lambda/${source.basename}`,
        bytes: source.bytes.length,
        sha256: digest,
        key: `deployment/${digest}/${source.basename}`
      };
    })
  };
  return {
    packet: {
      ...packetWithoutToken,
      approvalToken: sha256(Buffer.from(canonicalToken(packetWithoutToken), "utf8"))
    },
    bytesByBasename: new Map([
      ["cloudformation-template.json", templateBytes],
      ...sources.map((source) => [source.basename, source.bytes])
    ])
  };
}

function assertPacket(packet, bytesByBasename) {
  exactKeys(packet, [
    "contractVersion", "profile", "accountId", "region", "stack", "environment",
    "bucket", "template", "zips", "approvalToken"
  ]);
  assert.equal(packet.contractVersion, "storesignal-keyword-deployment-v1");
  assert.deepEqual(
    [packet.profile, packet.region, packet.stack, packet.environment],
    [DEPLOYMENT.profile, DEPLOYMENT.region, DEPLOYMENT.stack, DEPLOYMENT.environment]
  );
  assert.deepEqual(packet.zips.map(({ logicalId, basename }) => [logicalId, basename]), [
    ["KeywordWorker", "keyword-worker.zip"],
    ["Recovery", "recovery.zip"]
  ]);
  for (const item of [packet.template, ...packet.zips]) {
    const bytes = bytesByBasename.get(item.basename);
    assert.equal(item.bytes, bytes.length);
    assert.equal(item.sha256, sha256(bytes));
    assert.equal(item.key, `deployment/${item.sha256}/${item.basename}`);
  }
  const { approvalToken, ...body } = packet;
  assert.equal(approvalToken, sha256(Buffer.from(canonicalToken(body), "utf8")));
}

function detail(target, requiresRecreation = "Never") {
  return [{
    Evaluation: "Static",
    ChangeSource: "DirectModification",
    CausingEntity: null,
    Target: { Name: target, RequiresRecreation: requiresRecreation }
  }];
}

function change(action, logicalId, resourceType, replacement, details = []) {
  return { ResourceChange: { Action: action, LogicalResourceId: logicalId,
    ResourceType: resourceType, Replacement: replacement, Details: details } };
}

function fullChangeSet() {
  const additions = [
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
  ].map(([id, type]) => change("Add", id, type, null));
  return { Changes: [
    ...additions,
    change("Modify", "ControlPlanePolicy", "AWS::IAM::ManagedPolicy", "False"),
    change("Modify", "RecoveryRole", "AWS::IAM::Role", "False"),
    change("Modify", "Recovery", "AWS::Lambda::Function", "False")
  ] };
}

function activationChangeSet() {
  return { Changes: [
    change("Modify", "KeywordResearchMapping", "AWS::Lambda::EventSourceMapping", "False", detail("Enabled")),
    change("Modify", "KeywordWorker", "AWS::Lambda::Function", "False", detail("Environment")),
    change("Modify", "Recovery", "AWS::Lambda::Function", "False", detail("Environment"))
  ] };
}

function assertChangeSets() {
  assert.equal(assertReviewedChanges("full", fullChangeSet()).length, 13);
  assert.equal(assertReviewedChanges("activate", activationChangeSet()).length, 3);
  const dry = parseArguments([
    `--profile=${DEPLOYMENT.profile}`,
    `--region=${DEPLOYMENT.region}`,
    `--stack=${DEPLOYMENT.stack}`,
    `--environment=${DEPLOYMENT.environment}`,
    "--phase=full",
    "--account-id=123456789012"
  ]);
  assert.equal(dry.execute, false);
  assert.equal(dry.applyReviewedChangeSet, false);
  assert.throws(() => parseArguments([
    `--profile=${DEPLOYMENT.profile}`,
    `--region=${DEPLOYMENT.region}`,
    `--stack=${DEPLOYMENT.stack}`,
    `--environment=${DEPLOYMENT.environment}`,
    "--phase=full",
    "--account-id=123456789012",
    "--apply-reviewed-change-set"
  ]));
}

function assertInspectorArguments() {
  const shared = [
    `--profile=${DEPLOYMENT.profile}`,
    `--region=${DEPLOYMENT.region}`,
    `--stack=${DEPLOYMENT.stack}`,
    "--account-id=123456789012"
  ];
  const disabled = parseInspectArguments([...shared, "--expected-disabled"]);
  const active = parseInspectArguments([...shared, "--expected-active"]);
  assert.deepEqual([disabled.expectedDisabled, disabled.expectedActive, disabled.phase], [true, false, "full"]);
  assert.deepEqual([active.expectedDisabled, active.expectedActive, active.phase], [false, true, "activate"]);
  assert.throws(() => parseInspectArguments([...shared, "--expected-disabled", "--expected-active"]));
  const source = readFileSync(path.join(PROJECT_ROOT, "scripts", "keyword-intelligence", "inspect-stack.js"), "utf8");
  assert.match(source, /EXPECTED_DISABLED_KEYWORD_STACK_VERIFIED/u);
  assert.match(source, /EXPECTED_ACTIVE_KEYWORD_STACK_VERIFIED/u);
  assert.match(source, /AWS_PIPELINE_KEYWORD_RESEARCH_ENABLED/u);
  assert.match(source, /AWS_PIPELINE_KEYWORD_RESEARCH_QUEUE_URL/u);
  assert.equal(/(?:receive-message|purge-queue|start-message-move-task|delete-stack|update-stack)/u.test(source), false);
}

function runAwsStub() {
  const directory = spawnSync("mktemp", ["-d", path.join(os.tmpdir(), "ki-w7-aws-stub.XXXXXX")], {
    encoding: "utf8"
  }).stdout.trim();
  assert.match(path.basename(directory), /^ki-w7-aws-stub\.[A-Za-z0-9]{6}$/u);
  const executable = path.join(directory, "aws");
  const capture = path.join(directory, "capture.json");
  try {
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' \"$*\" > \"${capture}\"\nprintf '%s\\n' '{\"Account\":\"123456789012\"}'\n`, {
      mode: 0o700
    });
    const result = spawnSync(executable, [
      "sts", "get-caller-identity", "--profile", DEPLOYMENT.profile,
      "--region", DEPLOYMENT.region, "--no-cli-pager", "--output", "json"
    ], { encoding: "utf8", env: { PATH: directory } });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { Account: "123456789012" });
    const invocations = readFileSync(capture, "utf8").trim().split("\n");
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0], "sts get-caller-identity --profile storesignal-dev --region ap-south-2 --no-cli-pager --output json");
    return invocations.length;
  } finally {
    rmSync(directory, { recursive: true, force: false });
    assert.equal(existsSync(directory), false);
  }
}

function syntheticBuildEvidence() {
  const hash = "a".repeat(64);
  return {
    schema: "ki-w7-build-evidence-v1",
    producerAssessmentId: "KI-W7-I001",
    producerGateId: "KI-W7-CV3",
    keyword: {
      path: "dist/lambda/keyword-worker.zip",
      firstSha256: hash,
      secondSha256: hash,
      zipBytes: 1024,
      unzippedBytes: 2048,
      fileListHash: "b".repeat(64),
      requiredEngine: "libquery_engine-rhel-openssl-3.0.x.so.node",
      enginePresent: true,
      coldImportHandlerType: "function"
    },
    stableMeasurementSha256: { first: "c".repeat(64), second: "c".repeat(64) },
    establishedZipHashes: ESTABLISHED_ZIP_PATHS.map((zipPath, index) => ({
      path: zipPath,
      sha256: (index + 1).toString(16).repeat(64)
    })),
    assertions: Object.fromEntries(BUILD_ASSERTIONS.map((name) => [name, true]))
  };
}

function syntheticTap(buildEvidenceBytes) {
  const { registries } = readRegistries();
  const lines = ["TAP version 13", "# Subtest: unrelated accepted test", "ok 1 - unrelated accepted test"];
  let ordinal = 2;
  for (const id of [...CASES, ...CONTROLS]) {
    const kind = CASES.includes(id) ? "case" : "control";
    const displayKind = kind.toUpperCase();
    const title = `synthetic activation for ${id}`;
    const owner = ownerFor(id, registries, kind === "case" ? "requiredCases" : "requiredControls");
    const common = {
      schema: "ki-w7-execution-record-v1",
      id,
      kind,
      owner,
      executed: true,
      activated: true
    };
    const record = kind === "case" ? {
      ...common,
      oraclePassed: true,
      skipped: false
    } : {
      ...common,
      positivePassed: true,
      mutationFalsified: true,
      freshPositivePassed: true,
      skipped: false
    };
    lines.push(`# Subtest: [W7 ${displayKind} ${id}] ${title}`);
    lines.push(`    # KI_W7_EXECUTION_RECORD_V1=${JSON.stringify(record)}`);
    if (id === "W7-BUILD-01") {
      lines.push(`    # KI_W7_BUILD_CASE_CERTIFICATE_V1=${JSON.stringify({
        schema: "ki-w7-build-case-certificate-v1",
        caseId: "W7-BUILD-01",
        evidenceSha256: sha256(buildEvidenceBytes),
        activated: true,
        assertions: BUILD_ASSERTIONS
      })}`);
    }
    lines.push(`ok ${ordinal} - [W7 ${displayKind} ${id}] ${title}`);
    ordinal += 1;
  }
  lines.push(`1..${ordinal - 1}`, "");
  return lines.join("\n");
}

function createEvidenceDirectory() {
  const result = spawnSync("mktemp", ["-d", path.join(os.tmpdir(), "ki-w7-i001.XXXXXX")], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const directory = result.stdout.trim();
  assert.equal(path.isAbsolute(directory), true);
  assert.equal(realpathSync(directory), directory);
  assert.match(path.basename(directory), EVIDENCE_DIRECTORY_PATTERN);
  return directory;
}

function runParserFixture(mutate, expectedSuccess) {
  const directory = createEvidenceDirectory();
  const tapPath = path.join(directory, "focused.tap");
  const buildPath = path.join(directory, "build-evidence.json");
  const outputPath = path.join(directory, "focused-certificate.json");
  try {
    const buildBytes = canonicalBytes(syntheticBuildEvidence());
    let tap = syntheticTap(buildBytes);
    tap = mutate(tap);
    writeFileSync(tapPath, tap, { mode: 0o600 });
    writeFileSync(buildPath, buildBytes, { mode: 0o600 });
    const parserArguments = [
      "--parse-w7-focused-tap", "--tap", tapPath,
      "--build-evidence", buildPath, "--output", outputPath
    ];
    const parserModule = pathToFileURL(THIS_FILE).href;
    const wrapper = `import { runFocusedParserCli } from ${JSON.stringify(parserModule)};\n` +
      `try { const result = runFocusedParserCli(${JSON.stringify(parserArguments)}); ` +
      `process.stdout.write(\`KI_W7_FOCUSED_CERTIFICATE_WRITTEN \${result.sha256}\\n\`); } ` +
      `catch { process.stderr.write("W7_EXECUTION_CERTIFICATE_INVALID\\n"); process.exitCode = 1; }\n`;
    const result = spawnSync(process.execPath, [
      "--input-type=module", "--eval", wrapper, "ki-w7-parser-wrapper"
    ], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_TEST_CONTEXT: "" }
    });
    if (expectedSuccess) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /^KI_W7_FOCUSED_CERTIFICATE_WRITTEN [a-f0-9]{64}\n$/u,
        JSON.stringify({ stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal,
          execPath: process.execPath, thisFile: THIS_FILE }));
      assert.equal(/(?:TAP version|# Subtest:|\bok \d)/u.test(result.stdout), false);
      const bytes = readFileSync(outputPath);
      assert.equal(sha256(bytes), result.stdout.trim().split(" ")[1]);
      const certificate = JSON.parse(bytes.toString("utf8"));
      assert.equal(canonicalBytes(certificate).equals(bytes), true);
      assert.deepEqual(certificate.requiredCases, CASES);
      assert.deepEqual(certificate.requiredControls, CONTROLS);
      assert.equal(certificate.result, "PASS");
      assert.deepEqual(readFileSync(tapPath, "utf8"), tap);
      assert.deepEqual(readFileSync(buildPath), buildBytes);
      assert.deepEqual(readdirSync(directory).sort(),
        ["build-evidence.json", "focused-certificate.json", "focused.tap"]);
      return bytes;
    }
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "W7_EXECUTION_CERTIFICATE_INVALID\n");
    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(`${outputPath}.tmp`), false);
    return null;
  } finally {
    rmSync(directory, { recursive: true, force: false });
    assert.equal(existsSync(directory), false);
  }
}

function runParserLocalNow() {
  const smoke = spawnSync("/usr/bin/env", ["-u", "NODE_TEST_CONTEXT", process.execPath,
    "--eval", "process.stdout.write('W7_CHILD_OK')"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", NODE_TEST_CONTEXT: "" }
  });
  assert.deepEqual({ status: smoke.status, stdout: smoke.stdout, stderr: smoke.stderr },
    { status: 0, stdout: "W7_CHILD_OK", stderr: "" });
  const unchanged = (tap) => tap;
  const first = runParserFixture(unchanged, true);
  runParserFixture((tap) => tap.replace(
    /^    # KI_W7_EXECUTION_RECORD_V1=.*W7-RUNTIME-01.*\n/mu,
    ""
  ), false);
  runParserFixture((tap) => {
    const line = tap.match(/^    # KI_W7_EXECUTION_RECORD_V1=.*W7-RUNTIME-01.*$/mu)?.[0];
    assert.ok(line);
    return tap.replace(line, `${line}\n${line}`);
  }, false);
  runParserFixture((tap) => tap.replace(
    /^(ok [0-9]+ - \[W7 CASE W7-RUNTIME-01\].*)$/mu,
    "$1 # SKIP mutation"
  ), false);
  runParserFixture((tap) => tap.replace(
    /("id":"W7-RUNTIME-01"[^\n]*"activated":)true/u,
    "$1false"
  ), false);
  const final = runParserFixture(unchanged, true);
  assert.equal(first.equals(final), true);
}

function assertGuardSources() {
  const createSource = readFileSync(
    path.join(PROJECT_ROOT, "scripts", "keyword-intelligence", "create-change-set.js"),
    "utf8"
  );
  assert.equal(createSource.includes("sam deploy"), false);
  assert.match(createSource, /aws_mutation_approval/u);
  assert.match(createSource, /record\.changeSetId/u);
  assert.match(createSource, /assertReviewedChanges\(options\.phase, described\)/u);
  assert.match(createSource, /Deployment source\/hash drift/u);
  assert.equal(/(?:receive-message|purge-queue|start-message-move-task)/u.test(createSource), false);
}

function registerOwnedTests() {
  test("[W7 CASE W7-DEPLOY-01] packet content addresses the exact template and two ZIP sources", (t) => {
    const { packet, bytesByBasename } = deploymentPacketFixture();
    assertPacket(packet, bytesByBasename);
    assertGuardSources();
    assert.equal(runAwsStub(), 1);
    t.diagnostic(executionRecord("W7-DEPLOY-01", "case"));
  });

  test("[W7 CASE W7-DEPLOY-02] deployment changes require exact allowlists token and reviewed identity", (t) => {
    assertChangeSets();
    assertInspectorArguments();
    t.diagnostic(executionRecord("W7-DEPLOY-02", "case"));
  });

  test("[W7 CASE W7-CONF-01] five owner registries and focused certificate accounting are exact", (t) => {
    readRegistries();
    runParserLocalNow();
    t.diagnostic(executionRecord("W7-CONF-01", "case"));
  });

  test("[W7 CONTROL W7-NC-11] packet SHA drift falsifies source equality", (t) => {
    const positive = deploymentPacketFixture();
    assertPacket(positive.packet, positive.bytesByBasename);
    const changed = structuredClone(positive.packet);
    changed.zips[0].sha256 = "f".repeat(64);
    assert.throws(() => assertPacket(changed, positive.bytesByBasename));
    const fresh = deploymentPacketFixture();
    assertPacket(fresh.packet, fresh.bytesByBasename);
    t.diagnostic(executionRecord("W7-NC-11", "control"));
  });

  test("[W7 CONTROL W7-NC-12] a Remove change falsifies the reviewed change-set allowlist", (t) => {
    assertChangeSets();
    const changed = fullChangeSet();
    changed.Changes.push(change("Remove", "KeywordWorker", "AWS::Lambda::Function", "False"));
    assert.throws(() => assertReviewedChanges("full", changed));
    assertChangeSets();
    t.diagnostic(executionRecord("W7-NC-12", "control"));
  });
}

const directInvocation = pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
const nodeTestMode = process.execArgv.includes("--test");
if (directInvocation && process.argv[2] === "--parse-w7-focused-tap") {
  try {
    const result = runFocusedParserCli(process.argv.slice(2));
    process.stdout.write(`KI_W7_FOCUSED_CERTIFICATE_WRITTEN ${result.sha256}\n`);
  } catch {
    process.stderr.write("W7_EXECUTION_CERTIFICATE_INVALID\n");
    process.exitCode = 1;
  }
} else if (directInvocation || nodeTestMode) {
  registerOwnedTests();
}
