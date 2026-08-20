// KI-R5-S018 enforcement test (new file; S1 §5 S018; DEC-KI-037; SCN-KI-040).
//
// Owns the conformance registry R5_CONFORMANCE_CASES and executes the six CONF
// cases exactly once during KI-R5-I001 (gate E1) when KI_R5_EXECUTED_CERTIFICATES
// supplies exactly the four non-conformance certificates captured at V1 (api),
// V2 (frontend_api), V3 (database) and V4 (browser). With no certificate input
// the module registers zero tests; the enforcement run is never executed with a
// partial certificate set, never at leaf time, and never twice. CONF-02 emits
// the final merged 34-ID KI_R5_EXECUTION_CERTIFICATE (registry "merged") on the
// single successful merge.
//
// The pure helpers below are exported so the window agent can run the S018
// leaf-time LOCAL_NOW syntax/static checks (manifest parse, five-registry
// enumeration with exact digests, and NC-12 falsifications on synthetic
// in-memory copies) without executing any CONF case.

import assert, { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// ---------------------------------------------------------------------------
// Paths (resolved from this file inside email_scraper/test/)
// ---------------------------------------------------------------------------

const MANIFEST_PATH = fileURLToPath(new URL("./fixtures/keyword-intelligence/ki-r5-enforcement-manifest-v1.json", import.meta.url));
const W4_MANIFEST_PATH = fileURLToPath(new URL("./fixtures/keyword-intelligence/ki-w4-enforcement-manifest-v1.json", import.meta.url));
const BACKEND_API_TEST_PATH = fileURLToPath(new URL("./keyword-intelligence-api.test.js", import.meta.url));
const HANDOFF_TEST_PATH = fileURLToPath(new URL("./keyword-intelligence-handoff.integration.test.js", import.meta.url));
const FRONTEND_API_TEST_PATH = fileURLToPath(new URL("../../frontend/test/keyword-intelligence-api.test.ts", import.meta.url));
const COMPONENTS_TEST_PATH = fileURLToPath(new URL("../../frontend/test/keyword-intelligence-components.test.ts", import.meta.url));
const BROWSER_HARNESS_PATH = fileURLToPath(new URL("../../frontend/test/browser/keyword-intelligence-dashboard.mjs", import.meta.url));
const CHANGELOG_PATH = fileURLToPath(new URL("../../KEYWORD_INTELLIGENCE_SPECIFICATION_CHANGELOG.md", import.meta.url));
const WORKSPACE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BACKEND_REPO = fileURLToPath(new URL("../../email_scraper/", import.meta.url));
const FRONTEND_REPO = fileURLToPath(new URL("../../frontend/", import.meta.url));

// ---------------------------------------------------------------------------
// Frozen A4 / DEC-KI-037 literals
// ---------------------------------------------------------------------------

export const R5_CONFORMANCE_CASES = ["R5-CONF-01", "R5-CONF-02", "R5-CONF-03", "R5-CONF-04", "R5-CONF-05", "R5-CONF-06"];

const GROUP_ORDER = ["wire", "selection", "finalization", "export", "conformance"];
const GROUP_IDS = {
  wire: ["R5-WIRE-01", "R5-WIRE-02", "R5-WIRE-03", "R5-WIRE-04", "R5-WIRE-05", "R5-WIRE-06"],
  selection: ["R5-SEL-01", "R5-SEL-02", "R5-SEL-03", "R5-SEL-04", "R5-SEL-05", "R5-SEL-06", "R5-SEL-07", "R5-SEL-08"],
  finalization: ["R5-FIN-01", "R5-FIN-02", "R5-FIN-03", "R5-FIN-04", "R5-FIN-05", "R5-FIN-06", "R5-FIN-07", "R5-FIN-08"],
  export: ["R5-EXP-01", "R5-EXP-02", "R5-EXP-03", "R5-EXP-04", "R5-EXP-05", "R5-EXP-06"],
  conformance: R5_CONFORMANCE_CASES,
};
const GROUP_DIGESTS = {
  wire: "64e53c38d37b28ebb8da1799fc5e1f2d75c3aa45b5ca78a79529fe1d0ec2c1c7",
  selection: "a7fe88a15c03119d46e51bb3ccf9807440697c4d5381be7a0a0027b79f85bdf3",
  finalization: "14330e67aa5a4bbb72869f68806dc88757de40fe65e1dc1767a67008647cd8e5",
  export: "6d4ca77b8da2019bbfa4f3f1046c62d27d4c9fceb1b2d4c12105f13d8e87b340",
  conformance: "5960be1734aed1a66b382de36e98723dcee41f4919299835963d01f818577c9a",
};
const GLOBAL_DIGEST = "507186e7489a3f9eec18eb5de78692dbc55a8d1d2d106544aa4295a98ac9be60";

const NON_CONFORMANCE_GROUPS = ["wire", "selection", "finalization", "export"];
const GLOBAL_34 = Object.values(GROUP_IDS).flat();

// S1 §4.2 registry -> required case-ID ownership mapping.
const REGISTRY_REQUIRED = {
  api: ["R5-SEL-01", "R5-SEL-02", "R5-SEL-03", "R5-SEL-04", "R5-SEL-05", "R5-SEL-06", "R5-SEL-07", "R5-SEL-08", "R5-EXP-05", "R5-EXP-06"],
  database: ["R5-FIN-07", "R5-FIN-08"],
  frontend_api: ["R5-WIRE-01", "R5-WIRE-02", "R5-WIRE-03", "R5-WIRE-05", "R5-WIRE-06", "R5-EXP-01", "R5-EXP-02", "R5-EXP-03", "R5-EXP-04"],
  browser: ["R5-WIRE-04", "R5-FIN-01", "R5-FIN-02", "R5-FIN-03", "R5-FIN-04", "R5-FIN-05", "R5-FIN-06"],
  conformance: R5_CONFORMANCE_CASES,
};
const NON_CONFORMANCE_REGISTRIES = ["api", "database", "frontend_api", "browser"];

// DEC-KI-037 exact accepted-assertion supersession sets.
const W4_MUTABLE = ["W4-A04", "W4-A06", "W4-A07", "W4-S04", "W4-S06", "W4-D04"];
const W5_MUTABLE = ["W5-A05", "W5-A06", "W5-A09", "W5-A10", "W5-C05", "W5-C08", "W5-C12", "W5-B02", "W5-B03", "W5-B04", "W5-B05", "W5-R03"];
const BROWSER_RERUN = ["W5-B01", "W5-B02", "W5-B03", "W5-B04", "W5-B05", "W5-B06", "W5-B07", "W5-B08", "W5-R01", "W5-R02", "W5-R03", "W5-R04", "W5-R05", "W5-R06", "W5-R07"];
const MUTABLE_OWNERSHIP = {
  "W4-A04": BACKEND_API_TEST_PATH,
  "W4-A06": BACKEND_API_TEST_PATH,
  "W4-A07": BACKEND_API_TEST_PATH,
  "W4-S04": BACKEND_API_TEST_PATH,
  "W4-S06": BACKEND_API_TEST_PATH,
  "W4-D04": HANDOFF_TEST_PATH,
  "W5-A05": FRONTEND_API_TEST_PATH,
  "W5-A06": FRONTEND_API_TEST_PATH,
  "W5-A09": FRONTEND_API_TEST_PATH,
  "W5-A10": FRONTEND_API_TEST_PATH,
  "W5-C05": COMPONENTS_TEST_PATH,
  "W5-C08": COMPONENTS_TEST_PATH,
  "W5-C12": COMPONENTS_TEST_PATH,
  "W5-B02": BROWSER_HARNESS_PATH,
  "W5-B03": BROWSER_HARNESS_PATH,
  "W5-B04": BROWSER_HARNESS_PATH,
  "W5-B05": BROWSER_HARNESS_PATH,
  "W5-R03": BROWSER_HARNESS_PATH,
};
const W5_API_REGISTERED = ["W5-A01", "W5-A02", "W5-A03", "W5-A04", "W5-A05", "W5-A06", "W5-A07", "W5-A08", "W5-A09", "W5-A10"];
const W5_COMPONENT_REGISTERED = ["W5-C01", "W5-C02", "W5-C03", "W5-C04", "W5-C05", "W5-C06", "W5-C07", "W5-C08", "W5-C09", "W5-C10", "W5-C11", "W5-C12"];
const W4_DB_REGISTERED = ["W4-D01", "W4-D02", "W4-D03", "W4-D04", "W4-D05", "W4-D06"];

// S1 §2 delegable implementation file set (18 paths; A4 digest).
const DELEGABLE_FILE_SET = [
  "email_scraper/src/keyword-intelligence/api.js",
  "email_scraper/src/server.js",
  "email_scraper/src/keyword-intelligence/export.js",
  "email_scraper/src/keyword-intelligence/repository.js",
  "email_scraper/test/keyword-intelligence-api.test.js",
  "email_scraper/test/keyword-intelligence-handoff.integration.test.js",
  "email_scraper/test/fixtures/keyword-intelligence/ki-r5-enforcement-manifest-v1.json",
  "email_scraper/test/keyword-intelligence-r5-enforcement.test.js",
  "frontend/lib/keyword-intelligence-types.ts",
  "frontend/lib/keyword-intelligence-validation.ts",
  "frontend/lib/client-api.ts",
  "frontend/lib/keyword-intelligence-view-model.ts",
  "frontend/components/keyword-intelligence/selection-review.tsx",
  "frontend/components/keyword-intelligence/research-dashboard.tsx",
  "frontend/test/keyword-intelligence-api.test.ts",
  "frontend/test/keyword-intelligence-components.test.ts",
  "frontend/test/keyword-intelligence-inventory.test.ts",
  "frontend/test/browser/keyword-intelligence-dashboard.mjs",
];
const DELEGABLE_FILE_SET_DIGEST = "efc82a884d09561ed27be3513ca6898f0ab311dbe56cf46e9c2c241492560077";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function utf8Compare(a, b) {
  return Buffer.from(a, "utf8").compare(Buffer.from(b, "utf8"));
}

export function digestOf(members) {
  const sorted = [...members].sort(utf8Compare);
  return createHash("sha256").update(sorted.map((id) => `${id}\n`).join(""), "utf8").digest("hex");
}

function readUtf8(path) {
  return readFileSync(path, "utf8");
}

export function extractCaseArray(source, identifier) {
  const marker = `const ${identifier} = [`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${identifier} literal present`);
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  assert.ok(open !== -1 && close !== -1, `${identifier} array bounded`);
  const body = source.slice(open, close + 1);
  return [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// CONF-01 helper: manifest parse (duplicates rejected before set creation)
// ---------------------------------------------------------------------------

export function parseEnforcementManifest(raw) {
  assert.ok(typeof raw === "object" && raw !== null, "manifest is an object");
  assert.deepEqual(
    Object.keys(raw).sort(),
    ["contractVersion", "groups"].sort(),
    "manifest root keys are exactly contractVersion + groups"
  );
  assert.equal(raw.contractVersion, "ki-r5-enforcement-manifest-v1", "manifest contract version literal");
  assert.deepEqual(Object.keys(raw.groups), GROUP_ORDER, "exactly the five groups in A4 order");

  const allIds = [];
  for (const group of GROUP_ORDER) {
    const ids = raw.groups[group];
    assert.ok(Array.isArray(ids), `${group} is an array`);
    for (const id of ids) {
      if (allIds.includes(id)) {
        throw new AssertionError({ message: "R5_MANIFEST_DUPLICATE_ID" });
      }
      allIds.push(id);
    }
  }

  for (const group of GROUP_ORDER) {
    const ids = raw.groups[group];
    assert.deepEqual(ids, GROUP_IDS[group], `group ${group} exact ordered IDs`);
    assert.equal(digestOf(ids), GROUP_DIGESTS[group], `group ${group} per-member-LF digest`);
  }
  assert.equal(allIds.length, 34, "34 manifest IDs total");
  assert.equal(digestOf(allIds), GLOBAL_DIGEST, "34-ID global digest");
  return { groups: raw.groups, allIds };
}

// ---------------------------------------------------------------------------
// CONF-02 helpers: static registry enumeration and certificate validation
// ---------------------------------------------------------------------------

export function enumerateRegisteredRegistries() {
  return {
    api: extractCaseArray(readUtf8(BACKEND_API_TEST_PATH), "R5_API_CASES"),
    database: extractCaseArray(readUtf8(HANDOFF_TEST_PATH), "R5_DB_CASES"),
    frontend_api: extractCaseArray(readUtf8(FRONTEND_API_TEST_PATH), "R5_FRONTEND_CASES"),
    browser: extractCaseArray(readUtf8(BROWSER_HARNESS_PATH), "R5_BROWSER_CASES"),
    conformance: R5_CONFORMANCE_CASES,
  };
}

export function assertRegisteredSetsMatchRequired(registries) {
  const registryNames = Object.keys(registries);
  assert.deepEqual(
    [...registryNames].sort(utf8Compare),
    [...Object.keys(REGISTRY_REQUIRED)].sort(utf8Compare),
    "the five registered registries are exactly api, database, frontend_api, browser, conformance"
  );
  for (const registry of registryNames) {
    const required = [...REGISTRY_REQUIRED[registry]].sort(utf8Compare);
    const registered = [...registries[registry]].sort(utf8Compare);
    assert.deepEqual(registered, required, `${registry} registered equals required`);
    assert.equal(digestOf(registries[registry]), digestOf(REGISTRY_REQUIRED[registry]), `${registry} exact registered digest`);
    const seen = new Set();
    for (const id of registries[registry]) {
      assert.equal(seen.has(id), false, `${registry} has no duplicate ID ${id}`);
      seen.add(id);
      assert.equal(required.includes(id), true, `${registry} has no unexpected ID ${id}`);
    }
  }
  return registries;
}

function addCertificate(byRegistry, cert) {
  if (typeof cert !== "object" || cert === null || typeof cert.registry !== "string") {
    throw new AssertionError({ message: "R5_MALFORMED_CERTIFICATE" });
  }
  const registry = cert.registry;
  if (!NON_CONFORMANCE_REGISTRIES.includes(registry)) {
    throw new AssertionError({ message: `R5_UNEXPECTED_CERTIFICATE_REGISTRY:${registry}` });
  }
  if (byRegistry.has(registry)) {
    throw new AssertionError({ message: `R5_DUPLICATE_CERTIFICATE_REGISTRY:${registry}` });
  }
  byRegistry.set(registry, cert);
}

function parseExecutedCertificates(envValue) {
  const byRegistry = new Map();
  const lineRe = /^[# \t]*KI_R5_EXECUTION_CERTIFICATE=(.+)$/gm;
  let match;
  while ((match = lineRe.exec(envValue)) !== null) {
    addCertificate(byRegistry, JSON.parse(match[1]));
  }
  if (byRegistry.size === 0) {
    const array = JSON.parse(envValue);
    assert.ok(Array.isArray(array), "certificate input is certificate lines or a JSON array");
    for (const cert of array) addCertificate(byRegistry, cert);
  }
  if (byRegistry.size !== 4) {
    throw new AssertionError({ message: "R5_EXACT_FOUR_CERTIFICATES_REQUIRED" });
  }
  return byRegistry;
}

export function validateExecutedCertificate(cert, expectedRegistry) {
  assert.equal(cert.registry, expectedRegistry, `${expectedRegistry} certificate registry identity`);
  const required = [...cert.required].sort(utf8Compare);
  const registered = [...cert.registered].sort(utf8Compare);
  const executed = [...cert.executed].sort(utf8Compare);
  const skipped = [...(cert.skipped ?? [])].sort(utf8Compare);
  const witnesses = [...(cert.activationWitnesses ?? [])].sort(utf8Compare);
  const failures = [...(cert.oracleFailures ?? [])].sort(utf8Compare);
  assert.deepEqual(required, registered, `${expectedRegistry} required equals registered`);
  assert.deepEqual(required, executed, `${expectedRegistry} required equals executed`);
  assert.deepEqual(skipped, [], `${expectedRegistry} zero skipped`);
  assert.deepEqual(failures, [], `${expectedRegistry} zero oracle failures`);
  assert.equal(witnesses.length, required.length, `${expectedRegistry} every ID carries an activation witness`);
  assert.ok(typeof cert.digests === "object" && cert.digests !== null, `${expectedRegistry} digests object present`);
  assert.equal(cert.digests.required, digestOf(required), `${expectedRegistry} required digest exact`);
  assert.equal(cert.digests.registered, digestOf(registered), `${expectedRegistry} registered digest exact`);
  assert.equal(cert.digests.executed, digestOf(executed), `${expectedRegistry} executed digest exact`);
  return { registry: expectedRegistry, required, registered, executed, activationWitnesses: witnesses };
}

export function buildMergedCertificate(validated) {
  const nonConformance = [];
  for (const registry of NON_CONFORMANCE_REGISTRIES) {
    nonConformance.push(...validated[registry].executed);
  }
  const expectedNonConformance = [];
  for (const group of NON_CONFORMANCE_GROUPS) {
    expectedNonConformance.push(...GROUP_IDS[group]);
  }
  assert.deepEqual(
    [...nonConformance].sort(utf8Compare),
    [...expectedNonConformance].sort(utf8Compare),
    "the 28 executed non-conformance IDs equal the manifest wire/selection/finalization/export groups"
  );

  const merged = [...nonConformance, ...R5_CONFORMANCE_CASES].sort(utf8Compare);
  const manifestAll = [...GLOBAL_34].sort(utf8Compare);
  assert.deepEqual(merged, manifestAll, "the merged 34 IDs equal the manifest 34 IDs");
  assert.equal(merged.length, 34, "34 merged IDs");
  assert.equal(digestOf(merged), GLOBAL_DIGEST, "34-ID global digest exact");

  const certificate = {
    registry: "merged",
    required: manifestAll,
    registered: merged,
    executed: merged,
    skipped: [],
    activationWitnesses: merged,
    oracleFailures: [],
    digests: {
      required: digestOf(merged),
      registered: digestOf(merged),
      executed: digestOf(merged),
    },
  };
  return certificate;
}

// ---------------------------------------------------------------------------
// CONF-03 helpers: accepted-test supersession, stable registrations, A7
// ---------------------------------------------------------------------------

export function lintSupersessionDiscipline() {
  const mutable = new Set([...W4_MUTABLE, ...W5_MUTABLE]);
  const files = [
    { name: "email_scraper/test/keyword-intelligence-api.test.js", source: readUtf8(BACKEND_API_TEST_PATH) },
    { name: "email_scraper/test/keyword-intelligence-handoff.integration.test.js", source: readUtf8(HANDOFF_TEST_PATH) },
    { name: "frontend/test/keyword-intelligence-api.test.ts", source: readUtf8(FRONTEND_API_TEST_PATH) },
    { name: "frontend/test/keyword-intelligence-components.test.ts", source: readUtf8(COMPONENTS_TEST_PATH) },
    { name: "frontend/test/browser/keyword-intelligence-dashboard.mjs", source: readUtf8(BROWSER_HARNESS_PATH) },
  ];
  const oracleRe = /\b(W[45]-[A-Z]{1,2}[0-9]{2})\b/g;
  const r5Re = /\b(R5-[A-Z]+-[0-9]{2})\b/g;

  for (const file of files) {
    const lines = file.source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const oracleMatches = [...line.matchAll(oracleRe)];
      const r5Matches = [...line.matchAll(r5Re)];
      if (oracleMatches.length > 0 && r5Matches.length > 0) {
        for (const oracleMatch of oracleMatches) {
          const oracle = oracleMatch[1];
          assert.equal(
            mutable.has(oracle),
            true,
            `${file.name}:${index + 1}: supersession reference to ${oracle} must target one of the 18 DEC-KI-037 mutable oracles`
          );
        }
      }
    }
  }

  for (const oracle of [...W4_MUTABLE, ...W5_MUTABLE]) {
    const owningFile = MUTABLE_OWNERSHIP[oracle];
    assert.ok(owningFile, `${oracle} has a recorded owning file`);
    assert.ok(readUtf8(owningFile).includes(oracle), `${oracle} remains registered in its owning file`);
    assert.ok(
      readUtf8(owningFile).includes("R5-"),
      `${oracle} owning file cites R5 cases`
    );
  }
  return true;
}

export function lintStableRegistrations() {
  const w4Manifest = JSON.parse(readUtf8(W4_MANIFEST_PATH));
  const w4Groups = ["api_component", "server_routes", "query_review", "handoff_database", "conformance"];
  assert.deepEqual(Object.keys(w4Manifest.groups), w4Groups, "W4 manifest groups unchanged");
  const w4All = Object.values(w4Manifest.groups).flat();
  assert.equal(w4All.length, 34, "W4 manifest holds 34 IDs");
  const w4NonDb = w4All.filter((id) => !W4_DB_REGISTERED.includes(id));
  assert.equal(w4NonDb.length, 28, "W4 non-database registry holds 28 IDs");
  const apiSource = readUtf8(BACKEND_API_TEST_PATH);
  for (const id of w4NonDb) {
    assert.ok(apiSource.includes(`"${id}"`), `W4 non-database registration ${id} unchanged`);
  }
  assert.deepEqual(
    extractCaseArray(readUtf8(HANDOFF_TEST_PATH), "DB_IDS"),
    W4_DB_REGISTERED,
    "W4 database registration unchanged"
  );
  assert.deepEqual(
    extractCaseArray(readUtf8(FRONTEND_API_TEST_PATH), "REGISTERED_CASE_IDS"),
    W5_API_REGISTERED,
    "W5 api registration unchanged"
  );
  assert.deepEqual(
    extractCaseArray(readUtf8(COMPONENTS_TEST_PATH), "REGISTERED_CASE_IDS"),
    W5_COMPONENT_REGISTERED,
    "W5 component registration unchanged"
  );
  assert.deepEqual(
    extractCaseArray(readUtf8(BROWSER_HARNESS_PATH), "REQUIRED_BR_IDS"),
    BROWSER_RERUN,
    "browser rerun set unchanged and exactly 15 IDs"
  );
  return true;
}

export function lintA7InvalidationRecord() {
  const changelog = readUtf8(CHANGELOG_PATH);
  const blocks = changelog.split("```yaml").slice(1).map((block) => block.split("```")[0]);
  const invalidation = blocks.find((block) => block.includes("change_id: CHG-KI-025"));
  assert.ok(invalidation, "A7 contains the CHG-KI-025 invalidation record");
  assert.ok(invalidation.includes("DEC-KI-037"), "CHG-KI-025 records the DEC-KI-037 enforcement decision");
  assert.ok(invalidation.includes("KI-W6"), "CHG-KI-025 invalidates KI-W6");
  assert.ok(invalidation.includes("decomposition"), "CHG-KI-025 invalidates the KI-W6 decomposition");
  assert.ok(invalidation.includes("superseded"), "CHG-KI-025 records the W4/W5 assertion supersession");
  return true;
}

// ---------------------------------------------------------------------------
// CONF-04 helper: final-worktree scope lint
// ---------------------------------------------------------------------------

const ALLOWED_REVIEW_EVIDENCE_CHANGES = [
  {path:"frontend/review-evidence/keyword-intelligence/KI-W5/W5-R05-responsive.png",untracked:false},
  {path:"frontend/review-evidence/keyword-intelligence/KI-W5/artifact-index.json",untracked:false},
  {path:"frontend/review-evidence/keyword-intelligence/KI-W5/browser-checks.json",untracked:false},
  {path:"frontend/review-evidence/keyword-intelligence/KI-W5/browser-server.log",untracked:false},
  {path:"frontend/review-evidence/keyword-intelligence/KI-W5/R5-FIN-03-unsaved.png",untracked:true},
];

export function validateFinalWorktreeChanges(changes) {
  const expectedSet = new Set(DELEGABLE_FILE_SET);
  const createPaths = [
    "email_scraper/test/fixtures/keyword-intelligence/ki-r5-enforcement-manifest-v1.json",
    "email_scraper/test/keyword-intelligence-r5-enforcement.test.js",
  ];
  const forbiddenTokens = [
    "prisma/", "migrations", "package.json", "package-lock.json", "node_modules/",
    "src/aws-pipeline/", "infrastructure/", "src/worker", "src/aggregator", "src/providers",
    "/app/", "middleware", "/auth/", "proxy", "ki-w6", "KI-W6",
  ];
  const allowlist = new Map(ALLOWED_REVIEW_EVIDENCE_CHANGES.map((entry) => [entry.path, entry.untracked]));

  for (const change of changes) {
    if (allowlist.has(change.path)) {
      if (allowlist.get(change.path) !== change.untracked) {
        throw new AssertionError({ message: "R5_REVIEW_EVIDENCE_STATUS_MISMATCH" });
      }
      continue;
    }
    if (change.path.startsWith("frontend/review-evidence/keyword-intelligence/KI-W5/")) {
      throw new AssertionError({ message: "R5_UNEXPECTED_REVIEW_EVIDENCE_PATH" });
    }
    assert.ok(expectedSet.has(change.path), `changed path ${change.path} is within the 18-path delegable file set`);
    for (const token of forbiddenTokens) {
      assert.equal(change.path.includes(token), false, `no forbidden path token ${token} in ${change.path}`);
    }
    if (createPaths.includes(change.path)) {
      continue;
    }
    assert.equal(change.untracked, false, `${change.path} present as a modification, not an untracked create`);
  }
  return true;
}

export function lintFinalWorktreeScope(additionalChanges = []) {
  function changedPaths(repoPath, prefix) {
    const result = spawnSync("git", ["status", "--porcelain"], { cwd: repoPath, encoding: "utf8" });
    assert.equal(result.status, 0, `git status succeeds in ${repoPath}`);
    const changes = [];
    for (const line of result.stdout.split("\n")) {
      if (line.length === 0) continue;
      const status = line.slice(0, 2);
      const path = line.slice(3);
      if (path.length === 0) continue;
      changes.push({ path: `${prefix}/${path}`, untracked: status === "??" });
    }
    return changes;
  }

  const all = [
    ...changedPaths(BACKEND_REPO, "email_scraper"),
    ...changedPaths(FRONTEND_REPO, "frontend"),
  ];

  assert.equal(
    validateFinalWorktreeChanges([...all, ...additionalChanges]),
    true,
    "final worktree changed sets are exact subsets of the 18 delegable paths plus the five literal review-evidence paths/statuses"
  );

  for (const rel of DELEGABLE_FILE_SET) {
    assert.ok(existsSync(`${WORKSPACE_ROOT}${rel}`), `expected file present: ${rel}`);
  }
  assert.equal(digestOf(DELEGABLE_FILE_SET), DELEGABLE_FILE_SET_DIGEST, "18-path set digest equals the A4 literal");
  return true;
}

// ---------------------------------------------------------------------------
// CONF-05 helper: substitute-fidelity boundaries (DEC-KI-037)
// ---------------------------------------------------------------------------

export function lintSubstituteFidelity() {
  const apiTest = readUtf8(BACKEND_API_TEST_PATH);
  const handoff = readUtf8(HANDOFF_TEST_PATH);
  const frontendApi = readUtf8(FRONTEND_API_TEST_PATH);
  const browser = readUtf8(BROWSER_HARNESS_PATH);

  assert.equal(apiTest.includes("PrismaClient"), false, "BAPI uses in-memory fakes and never a Prisma client (parsing/materialization/call order only)");
  assert.equal(apiTest.includes("@prisma/client"), false, "BAPI has no Prisma import");
  assert.ok(handoff.includes("createIsolatedTestSchema"), "FDB isolates a disposable schema");
  assert.ok(handoff.includes("createPrismaClient"), "FDB uses real Prisma clients for FIN-07/08");
  assert.ok(handoff.includes("R5-FIN-07") && handoff.includes("R5-FIN-08"), "FDB registers R5-FIN-07/08 against real Prisma");
  assert.ok(frontendApi.includes("../../email_scraper/src/api-serializer.js"), "FAPI imports the actual W4 serializer");
  assert.ok(frontendApi.includes("R5-WIRE-02"), "FAPI runs the actual serializer-to-parser conformance case");
  assert.ok(frontendApi.includes("R5-WIRE-05") && frontendApi.includes("R5-WIRE-06"), "FAPI captures exact client mutation request init");
  assert.ok(browser.includes("R5-WIRE-04"), "browser harness owns the real Next pre-auth route witness");
  assert.ok(browser.includes("R5_REAL_NEXT_ROUTE_WITNESS_MISSING"), "browser harness forbids substituting intercepted presentation evidence for route evidence");
  return true;
}

// ---------------------------------------------------------------------------
// CONF-06 helpers: NC-12 enforcement controls on synthetic in-memory copies
// ---------------------------------------------------------------------------

function cleanEvidence() {
  return {
    required: [...GLOBAL_34],
    registered: [...GLOBAL_34],
    skipped: [],
    activationWitnesses: [...GLOBAL_34],
    forbiddenOperationCount: 0,
    interceptedPresentedAsRouteEvidence: false,
  };
}

export function lintRequiredMatchesRegistered(evidence) {
  const required = [...evidence.required].sort(utf8Compare);
  const registered = [...evidence.registered].sort(utf8Compare);
  if (required.length !== registered.length || required.some((id, index) => id !== registered[index])) {
    throw new AssertionError({ message: "R5_REQUIRED_SET_MISMATCH" });
  }
  return true;
}

export function lintNoSkippedOrFiltered(evidence) {
  const requiredSet = new Set(evidence.required);
  if (evidence.skipped.some((id) => requiredSet.has(id))) {
    throw new AssertionError({ message: "R5_REQUIRED_CASE_SKIPPED" });
  }
  return true;
}

export function lintCaseIdIntegrity(evidence) {
  const seen = new Set();
  for (const id of evidence.registered) {
    if (seen.has(id)) {
      throw new AssertionError({ message: "R5_CASE_ID_INVALID" });
    }
    seen.add(id);
  }
  const requiredSet = new Set(evidence.required);
  for (const id of evidence.registered) {
    if (!requiredSet.has(id)) {
      throw new AssertionError({ message: "R5_CASE_ID_INVALID" });
    }
  }
  return true;
}

export function lintActivationWitnesses(evidence) {
  const requiredSet = new Set(evidence.required);
  for (const id of requiredSet) {
    if (!evidence.activationWitnesses.includes(id)) {
      throw new AssertionError({ message: "R5_ACTIVATION_WITNESS_MISSING" });
    }
  }
  return true;
}

export function lintForbiddenOperations(evidence) {
  if (typeof evidence.forbiddenOperationCount !== "number") {
    throw new AssertionError({ message: "R5_ORACLE_WEAKENED" });
  }
  return true;
}

export function lintSubstituteFidelityDivergence(evidence) {
  if (evidence.interceptedPresentedAsRouteEvidence === true) {
    throw new AssertionError({ message: "R5_SUBSTITUTE_FIDELITY_DIVERGED" });
  }
  return true;
}

function runNc12Variant(label, mutate, lint, message) {
  assert.equal(lint(cleanEvidence()), true, `${label}: untouched evidence passes`);
  const mutated = mutate(cleanEvidence());
  assert.throws(
    () => lint(mutated),
    (error) => error instanceof AssertionError && error.message === message,
    `${label}: ${message} on the mutation`
  );
  assert.equal(lint(cleanEvidence()), true, `${label}: restored production passes`);
}

// ---------------------------------------------------------------------------
// Six CONF cases, registered only when exactly the four non-conformance
// certificates are supplied (single E1 enforcement run during KI-R5-I001).
// ---------------------------------------------------------------------------

if (typeof process.env.KI_R5_EXECUTED_CERTIFICATES === "string" && process.env.KI_R5_EXECUTED_CERTIFICATES.trim().length > 0) {
  const certificates = parseExecutedCertificates(process.env.KI_R5_EXECUTED_CERTIFICATES);
  const manifest = JSON.parse(readUtf8(MANIFEST_PATH));

  test("KI-R5 R5-CONF-01 enforcement manifest parse", () => {
    const parsed = parseEnforcementManifest(manifest);
    assert.equal(parsed.allIds.length, 34, "manifest carries exactly 34 IDs");

    const duplicated = JSON.parse(JSON.stringify(manifest));
    duplicated.groups.wire.push("R5-WIRE-01");
    assert.throws(
      () => parseEnforcementManifest(duplicated),
      (error) => error instanceof AssertionError && error.message === "R5_MANIFEST_DUPLICATE_ID",
      "a duplicate ID is rejected before set creation"
    );
    assert.equal(
      parseEnforcementManifest(JSON.parse(JSON.stringify(manifest))).allIds.length,
      34,
      "a fresh manifest passes after the duplicate rejection"
    );
  });

  test("KI-R5 R5-CONF-02 registry enumeration and 34-ID merge", () => {
    const registries = enumerateRegisteredRegistries();
    assertRegisteredSetsMatchRequired(registries);

    const validated = {};
    for (const registry of NON_CONFORMANCE_REGISTRIES) {
      validated[registry] = validateExecutedCertificate(certificates.get(registry), registry);
    }
    const merged = buildMergedCertificate(validated);
    process.stdout.write(`KI_R5_EXECUTION_CERTIFICATE=${JSON.stringify(merged)}\n`);
  });

  test("KI-R5 R5-CONF-03 accepted-test supersession lint", () => {
    assert.deepEqual([...W4_MUTABLE].sort(utf8Compare), ["W4-A04", "W4-A06", "W4-A07", "W4-S04", "W4-S06", "W4-D04"].sort(utf8Compare), "the six W4 mutable oracles are exactly the DEC-KI-037 set");
    assert.deepEqual(
      [...W5_MUTABLE].sort(utf8Compare),
      ["W5-A05", "W5-A06", "W5-A09", "W5-A10", "W5-C05", "W5-C08", "W5-C12", "W5-B02", "W5-B03", "W5-B04", "W5-B05", "W5-R03"].sort(utf8Compare),
      "the twelve W5 mutable oracles are exactly the DEC-KI-037 set"
    );
    assert.equal(BROWSER_RERUN.length, 15, "the browser rerun set holds exactly 15 IDs");
    assert.equal(new Set(BROWSER_RERUN).size, 15, "the browser rerun set has no duplicate ID");
    assert.equal(lintSupersessionDiscipline(), true, "supersession citations target only the 18 mutable oracles");
    assert.equal(lintStableRegistrations(), true, "all stable W4/W5 registrations remain unchanged");
    assert.equal(lintA7InvalidationRecord(), true, "A7 records the W4/W5 assertion and KI-W6 decomposition invalidation");
  });

  test("KI-R5 R5-CONF-04 final-worktree scope lint", () => {
    assert.equal(lintFinalWorktreeScope(), true, "final worktree changed sets are exact subsets of the 18 delegable paths");
  });

  test("KI-R5 R5-CONF-05 substitute-fidelity boundaries", () => {
    assert.equal(lintSubstituteFidelity(), true, "each substitute claim is bounded per DEC-KI-037");
  });

  test("KI-R5 R5-CONF-06 enforcement controls (R5-NC-12)", () => {
    runNc12Variant(
      "remove one required registration",
      (evidence) => { evidence.registered = evidence.registered.slice(0, -1); return evidence; },
      lintRequiredMatchesRegistered,
      "R5_REQUIRED_SET_MISMATCH"
    );
    runNc12Variant(
      "mark one required ID skipped/filtered",
      (evidence) => { evidence.skipped = [evidence.required[0]]; return evidence; },
      lintNoSkippedOrFiltered,
      "R5_REQUIRED_CASE_SKIPPED"
    );
    runNc12Variant(
      "duplicate one ID",
      (evidence) => { evidence.registered = [...evidence.registered, evidence.registered[0]]; return evidence; },
      lintCaseIdIntegrity,
      "R5_CASE_ID_INVALID"
    );
    runNc12Variant(
      "add one unexpected ID",
      (evidence) => { evidence.registered = [...evidence.registered, "R5-EXP-99"]; return evidence; },
      lintCaseIdIntegrity,
      "R5_CASE_ID_INVALID"
    );
    runNc12Variant(
      "clear one activation witness",
      (evidence) => { evidence.activationWitnesses = evidence.activationWitnesses.slice(0, -1); return evidence; },
      lintActivationWitnesses,
      "R5_ACTIVATION_WITNESS_MISSING"
    );
    runNc12Variant(
      "replace one forbidden-operation count with no assertion",
      (evidence) => { delete evidence.forbiddenOperationCount; return evidence; },
      lintForbiddenOperations,
      "R5_ORACLE_WEAKENED"
    );
    runNc12Variant(
      "label intercepted presentation evidence as route evidence",
      (evidence) => { evidence.interceptedPresentedAsRouteEvidence = true; return evidence; },
      lintSubstituteFidelityDivergence,
      "R5_SUBSTITUTE_FIDELITY_DIVERGED"
    );
  });
}
