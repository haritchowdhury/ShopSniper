import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateInventory } from "../scripts/measure-keyword-worker-package.js";

const W7_OWNER_REGISTRY = Object.freeze({"owner":"build","requiredCases":["W7-BUILD-01"],"requiredControls":["W7-NC-10"]}); // W7-REGISTRY

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REQUIRED_ENGINE = "libquery_engine-rhel-openssl-3.0.x.so.node";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys, label) {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${label} must be an object`);
  assert.deepEqual(Object.keys(value), keys, `${label} keys`);
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requireSha256(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, SHA256_PATTERN, `${label} must be lowercase SHA-256`);
}

function requireIntegerInRange(value, minimum, maximum, label) {
  assert.equal(Number.isInteger(value), true, `${label} must be an integer`);
  assert.ok(value >= minimum && value <= maximum, `${label} is outside its bound`);
}

function stableMeasurementBytes(report) {
  const stable = structuredClone(report);
  for (const measurement of stable.measurements) {
    delete measurement.coldImport.durationMs;
    delete measurement.coldImport.rssBytes;
    delete measurement.coldImport.rssDeltaBytes;
  }
  return canonicalBytes(stable);
}

function validateMeasurementReport(report) {
  exactKeys(report, ["node", "measurements"], "measurement report");
  assert.equal(typeof report.node, "string");
  assert.equal(Array.isArray(report.measurements), true);
  assert.equal(report.measurements.length, 1);
  const measurement = report.measurements[0];
  exactKeys(measurement, [
    "handler",
    "zipBytes",
    "unzippedBytes",
    "fileListHash",
    "requiredEngine",
    "enginePresent",
    "coldImport",
    "files"
  ], "keyword measurement");
  assert.equal(measurement.handler, "keyword-worker");
  requireIntegerInRange(measurement.zipBytes, 1, 47_185_920, "measurement zipBytes");
  requireIntegerInRange(measurement.unzippedBytes, 1, 209_715_200, "measurement unzippedBytes");
  requireSha256(measurement.fileListHash, "measurement fileListHash");
  assert.equal(measurement.requiredEngine, REQUIRED_ENGINE);
  assert.equal(measurement.enginePresent, true);
  exactKeys(measurement.coldImport, ["durationMs", "rssBytes", "rssDeltaBytes"], "measurement coldImport");
  assert.equal(Number.isFinite(measurement.coldImport.durationMs) && measurement.coldImport.durationMs >= 0, true);
  assert.equal(Number.isInteger(measurement.coldImport.rssBytes) && measurement.coldImport.rssBytes > 0, true);
  assert.equal(Number.isInteger(measurement.coldImport.rssDeltaBytes), true);
  const files = validateInventory(measurement.files);
  assert.deepEqual(files, measurement.files, "measurement files must use unsigned-UTF8 inventory order");
  assert.equal(files.includes("index.mjs"), true);
  assert.equal(
    sha256(Buffer.from(`${files.join("\n")}\n`, "utf8")),
    measurement.fileListHash,
    "measurement file-list hash"
  );
  return measurement;
}

function readStrictBuildEvidence() {
  const evidencePath = process.env.KI_W7_BUILD_EVIDENCE_PATH;
  assert.equal(typeof evidencePath, "string", "KI_W7_BUILD_EVIDENCE_PATH is required");
  assert.equal(path.isAbsolute(evidencePath), true, "build evidence path must be absolute");
  assert.equal(path.resolve(evidencePath), evidencePath, "build evidence path must be canonical");
  assert.equal(path.basename(evidencePath), "build-evidence.json");
  const evidenceDirectory = path.dirname(evidencePath);
  assert.match(path.basename(evidenceDirectory), /^ki-w7-i001\.[A-Za-z0-9]{6}$/u);
  assert.equal(realpathSync(evidenceDirectory), evidenceDirectory, "build evidence directory must be canonical and live");
  const metadata = lstatSync(evidencePath);
  assert.equal(metadata.isFile(), true, "build evidence must be a regular file");
  assert.equal(metadata.isSymbolicLink(), false, "build evidence must not be a symlink");
  assert.ok(metadata.size >= 1 && metadata.size <= 65_536, "build evidence byte bound");
  assert.equal(realpathSync(evidencePath), evidencePath, "build evidence file must be canonical");
  const bytes = readFileSync(evidencePath);
  assert.equal(bytes.length, metadata.size, "build evidence size changed during read");
  const text = bytes.toString("utf8");
  assert.equal(Buffer.from(text, "utf8").equals(bytes), true, "build evidence must be UTF-8");
  const evidence = JSON.parse(text);
  assert.equal(canonicalBytes(evidence).equals(bytes), true, "build evidence must be canonical JSON");
  return { bytes, evidence };
}

function validateBridgeSchema(evidence) {
  exactKeys(evidence, [
    "schema",
    "producerAssessmentId",
    "producerGateId",
    "keyword",
    "stableMeasurementSha256",
    "establishedZipHashes",
    "assertions"
  ], "build evidence");
  assert.equal(evidence.schema, "ki-w7-build-evidence-v1");
  assert.equal(evidence.producerAssessmentId, "KI-W7-I001");
  assert.equal(evidence.producerGateId, "KI-W7-CV3");

  exactKeys(evidence.keyword, [
    "path",
    "firstSha256",
    "secondSha256",
    "zipBytes",
    "unzippedBytes",
    "fileListHash",
    "requiredEngine",
    "enginePresent",
    "coldImportHandlerType"
  ], "keyword evidence");
  assert.equal(evidence.keyword.path, "dist/lambda/keyword-worker.zip");
  requireSha256(evidence.keyword.firstSha256, "keyword firstSha256");
  requireSha256(evidence.keyword.secondSha256, "keyword secondSha256");
  assert.equal(evidence.keyword.firstSha256, evidence.keyword.secondSha256);
  requireIntegerInRange(evidence.keyword.zipBytes, 1, 47_185_920, "keyword zipBytes");
  requireIntegerInRange(evidence.keyword.unzippedBytes, 1, 209_715_200, "keyword unzippedBytes");
  requireSha256(evidence.keyword.fileListHash, "keyword fileListHash");
  assert.equal(evidence.keyword.requiredEngine, REQUIRED_ENGINE);
  assert.equal(evidence.keyword.enginePresent, true);
  assert.equal(evidence.keyword.coldImportHandlerType, "function");

  exactKeys(evidence.stableMeasurementSha256, ["first", "second"], "stable measurement hashes");
  requireSha256(evidence.stableMeasurementSha256.first, "stable measurement first hash");
  requireSha256(evidence.stableMeasurementSha256.second, "stable measurement second hash");
  assert.equal(evidence.stableMeasurementSha256.first, evidence.stableMeasurementSha256.second);

  assert.equal(Array.isArray(evidence.establishedZipHashes), true);
  assert.equal(evidence.establishedZipHashes.length, ESTABLISHED_ZIP_PATHS.length);
  evidence.establishedZipHashes.forEach((item, index) => {
    exactKeys(item, ["path", "sha256"], `established ZIP ${index}`);
    assert.equal(item.path, ESTABLISHED_ZIP_PATHS[index]);
    requireSha256(item.sha256, `established ZIP ${index} hash`);
  });

  exactKeys(evidence.assertions, BUILD_ASSERTIONS, "build assertions");
  for (const assertion of BUILD_ASSERTIONS) assert.equal(evidence.assertions[assertion], true);
}

function validateCurrentBuild(evidence) {
  const keywordZip = path.join(PROJECT_ROOT, evidence.keyword.path);
  const keywordBytes = readFileSync(keywordZip);
  assert.equal(sha256(keywordBytes), evidence.keyword.secondSha256, "current keyword ZIP hash");
  assert.equal(statSync(keywordZip).size, evidence.keyword.zipBytes, "current keyword ZIP size");

  for (const item of evidence.establishedZipHashes) {
    assert.equal(sha256(readFileSync(path.join(PROJECT_ROOT, item.path))), item.sha256, `${item.path} current hash`);
  }

  const report = JSON.parse(readFileSync(
    path.join(PROJECT_ROOT, "dist/lambda/keyword-worker-measurements.json"),
    "utf8"
  ));
  const measurement = validateMeasurementReport(report);
  assert.equal(measurement.zipBytes, evidence.keyword.zipBytes);
  assert.equal(measurement.unzippedBytes, evidence.keyword.unzippedBytes);
  assert.equal(measurement.fileListHash, evidence.keyword.fileListHash);
  assert.equal(measurement.requiredEngine, evidence.keyword.requiredEngine);
  assert.equal(measurement.enginePresent, evidence.keyword.enginePresent);
  assert.equal(typeof measurement.coldImport, "object");
  const currentStableHash = sha256(stableMeasurementBytes(report));
  assert.equal(currentStableHash, evidence.stableMeasurementSha256.second, "current stable measurement hash");
}

function buildCaseCertificate(evidenceBytes) {
  return `KI_W7_BUILD_CASE_CERTIFICATE_V1=${JSON.stringify({
    schema: "ki-w7-build-case-certificate-v1",
    caseId: "W7-BUILD-01",
    evidenceSha256: sha256(evidenceBytes),
    activated: true,
    assertions: BUILD_ASSERTIONS
  })}`;
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

test("[W7 CASE W7-BUILD-01] deterministic keyword package evidence matches the current build", (t) => {
  if (process.env.KI_W7_BUILD_EVIDENCE_PATH === undefined) {
    assert.equal(Object.hasOwn(process.env, "KI_W7_BUILD_EVIDENCE_PATH"), false);
    return;
  }
  const { bytes, evidence } = readStrictBuildEvidence();
  validateBridgeSchema(evidence);
  validateCurrentBuild(evidence);
  t.diagnostic(buildCaseCertificate(bytes));
  t.diagnostic(executionRecord("W7-BUILD-01", "case"));
});

test("[W7 CONTROL W7-NC-10] forbidden environment member falsifies package inventory", (t) => {
  const positive = [
    "index.mjs",
    `node_modules/.prisma/client/${REQUIRED_ENGINE}`
  ];
  assert.deepEqual(validateInventory(positive), positive);
  const mutated = [...positive, ".env"];
  assert.throws(() => validateInventory(mutated), /Forbidden ZIP file: \.env/u);
  assert.deepEqual(validateInventory(structuredClone(positive)), positive);
  t.diagnostic(executionRecord("W7-NC-10", "control"));
});
