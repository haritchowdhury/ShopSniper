import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/keyword-intelligence", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(`${fixtureDir}/ki-r3-enforcement-manifest-v1.json`, "utf8"));
const R4_MANIFEST = JSON.parse(readFileSync(`${fixtureDir}/ki-r4-enforcement-manifest-v1.json`, "utf8"));
const R3_BASE = "37a0e0203d265f539b566f1536642cd2f4eb2d99";
const R3_HEAD = "077213cc7c33fa8209a1e5d8ff365b73766500dc";

const EXPECTED_GROUP_COUNTS = {
  adapter: 16,
  dispatcher: 12,
  task_component: 18,
  recovery_component: 18,
  task_database: 5,
  aggregation: 24,
  conformance: 8
};
const TOTAL_CASES = Object.values(EXPECTED_GROUP_COUNTS).reduce((sum, value) => sum + value, 0);

const AUTHORIZED_WRITE_PATHS = [
  "src/aws-pipeline/keyword-intelligence/dataforseo-labs-adapter.js",
  "src/aws-pipeline/keyword-intelligence/service.js",
  "src/aws-pipeline/adapters/queue-dispatcher.js",
  "test/keyword-intelligence-adapter.test.js",
  "test/aws-pipeline-runtime-adapters.test.js",
  "test/keyword-intelligence-worker.test.js",
  "test/keyword-intelligence-worker-flow.test.js",
  "test/keyword-intelligence-enforcement.test.js",
  "test/fixtures/keyword-intelligence/ki-r3-enforcement-manifest-v1.json"
];

const ADAPTER_PRIVATE_HELPERS = [
  "invariant",
  "settlementFence",
  "markAmbiguousOnce",
  "moneyString",
  "requestSchemaFor",
  "reservationFor",
  "normalizeKeywordList",
  "normalizeOverviewMetrics",
  "normalizeSuccess",
  "bodyCost",
  "taskCost",
  "parseRoot",
  "parseTaskEnvelope",
  "parseEndpointTask",
  "scheduleKnownRetry"
];
const ADAPTER_W3_PRIVATE_ADDITIONS = ["settlementFence", "markAmbiguousOnce"];

const SERVICE_PRIVATE_HELPERS = [
  "invariant",
  "nowOf",
  "LEASE_LOST_CODE",
  "leaseLostError",
  "createKeywordLeaseMonitor",
  "withLeaseBoundary",
  "prepareTerminalLease",
  "stopReleasedLease",
  "httpOf",
  "queueUrlOf",
  "configOf",
  "parseRequest",
  "ownerOf",
  "newToken",
  "requestSchemaFor",
  "expansionRequestForTask",
  "overviewRequestForTask",
  "sendKeywordMessage",
  "sendCheck",
  "processTask",
  "recoverClaimedTask",
  "runProviderAttempt",
  "buildTaskArtifact",
  "sendSameTaskMessage",
  "sendCheckForStage",
  "stageTasks",
  "readArtifact",
  "readManifest",
  "aggregateExpansion",
  "aggregateAnchor",
  "aggregateMarket",
  "failStage",
  "shortlistComparator"
];
const SERVICE_W3_PRIVATE_ADDITIONS = [
  "LEASE_LOST_CODE",
  "leaseLostError",
  "createKeywordLeaseMonitor",
  "withLeaseBoundary",
  "prepareTerminalLease",
  "stopReleasedLease"
];

function privateDeclarations(filePath) {
  const source = readFileSync(`${projectRoot}/${filePath}`, "utf8");
  const declared = new Set();
  for (const match of source.matchAll(/^(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gmu)) {
    declared.add(match[1]);
  }
  for (const match of source.matchAll(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s+)?\(/gmu)) {
    declared.add(match[1]);
  }
  if (source.includes("const LEASE_LOST_CODE = ")) declared.add("LEASE_LOST_CODE");
  return [...declared];
}

function gitDiffHunks(path) {
  const result = spawnSync("git", ["diff", "-U0", R3_BASE, R3_HEAD, "--", path], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const hunks = [];
  const blocks = result.stdout.split(/^@@ /gmu).slice(1);
  for (const block of blocks) {
    const header = block.split("\n")[0];
    const match = /^-(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u.exec(header);
    if (!match) continue;
    const start = Number(match[1]);
    const length = match[2] ? Number(match[2]) : 1;
    const body = block.split("\n").slice(1);
    const added = body.filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1));
    const removed = body.filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1));
    hunks.push({ start, end: start + Math.max(length, 1) - 1, added, removed });
  }
  return hunks;
}

function withinAny(hunk, spans) {
  return spans.some(([from, to]) => hunk.start <= to && hunk.end >= from);
}

test("SCN-KI-032: conformance enforcement manifest executes every structural gate", async (t) => {
  const executed = [];
  for (const caseId of MANIFEST.groups.conformance) {
    await t.test(caseId, async () => {
      executed.push(caseId);
      switch (caseId) {
        case "R3-C01-manifest-root-exact": {
          assert.deepEqual(Object.keys(MANIFEST).sort(), ["contractVersion", "groups"]);
          assert.equal(MANIFEST.contractVersion, "ki-r3-enforcement-manifest-v1");
          break;
        }
        case "R3-C02-group-set-exact": {
          assert.deepEqual(Object.keys(MANIFEST.groups).sort(),
            ["adapter", "aggregation", "conformance", "dispatcher", "recovery_component", "task_component", "task_database"]);
          break;
        }
        case "R3-C03-global-id-unique": {
          const all = Object.values(MANIFEST.groups).flat();
          assert.equal(all.length, TOTAL_CASES, `exactly ${TOTAL_CASES} global case IDs`);
          assert.equal(new Set(all).size, all.length, "all case IDs globally unique");
          for (const [group, ids] of Object.entries(MANIFEST.groups)) {
            assert.equal(ids.length, EXPECTED_GROUP_COUNTS[group], `group ${group} count`);
            const prefix = group === "task_component" ? "R3-T" : group === "recovery_component" ? "R3-R"
              : group === "task_database" ? "R3-D" : group === "aggregation" ? "R3-G"
                : group === "conformance" ? "R3-C" : group === "adapter" ? "R3-A" : "R3-Q";
            assert.ok(ids.every((id) => id.startsWith(prefix)), `group ${group} uses ${prefix} IDs`);
          }
          break;
        }
        case "R3-C04-private-helper-set-exact": {
          const adapterHelpers = privateDeclarations("src/aws-pipeline/keyword-intelligence/dataforseo-labs-adapter.js");
          assert.deepEqual([...adapterHelpers].sort(), [...ADAPTER_PRIVATE_HELPERS].sort(),
            "adapter private helper inventory is exact");
          for (const helper of ADAPTER_W3_PRIVATE_ADDITIONS) {
            assert.ok(adapterHelpers.includes(helper), `adapter helper ${helper} present`);
          }
          const serviceHelpers = privateDeclarations("src/aws-pipeline/keyword-intelligence/service.js");
          assert.deepEqual([...serviceHelpers].sort(), [...SERVICE_PRIVATE_HELPERS].sort(),
            "service private helper inventory is exact");
          for (const helper of SERVICE_W3_PRIVATE_ADDITIONS) {
            assert.ok(serviceHelpers.includes(helper), `service helper ${helper} present`);
          }
          break;
        }
        case "R3-C05-production-symbol-diff-exact": {
          const adapterHunks = gitDiffHunks("src/aws-pipeline/keyword-intelligence/dataforseo-labs-adapter.js");
          assert.ok(adapterHunks.length > 0, "adapter fixed-revision diff must be nonempty");
          for (const hunk of adapterHunks) {
            assert.ok(withinAny(hunk, [[46, 56]]), `adapter diff outside settlementFence: ${JSON.stringify(hunk)}`);
          }
          const dispatchHunks = gitDiffHunks("src/aws-pipeline/adapters/queue-dispatcher.js");
          assert.ok(dispatchHunks.length > 0, "dispatcher fixed-revision diff must be nonempty");
          for (const hunk of dispatchHunks) {
            assert.ok(withinAny(hunk, [[28, 50]]), `dispatcher diff outside sendOne: ${JSON.stringify(hunk)}`);
          }
          const serviceHunks = gitDiffHunks("src/aws-pipeline/keyword-intelligence/service.js");
          assert.ok(serviceHunks.length > 0, "service fixed-revision diff must be nonempty");
          const spans = [[305, 408], [410, 488], [490, 509]];
          for (const hunk of serviceHunks) {
            const isImport = hunk.removed.length === 0 && hunk.added.length > 0 &&
              hunk.added.every((line) => /^import\s/u.test(line) || /^  [A-Za-z0-9_]+,?\s*$/u.test(line) ||
                /^[A-Za-z0-9_]+,\s*$/u.test(line));
            assert.ok(isImport || withinAny(hunk, spans),
              `service diff outside the four authorized symbols: ${JSON.stringify(hunk)}`);
            if (!isImport) {
              const AUTHORIZED_SYMBOLS = new Set(["processTask", "recoverClaimedTask", "runProviderAttempt"]);
              const newHelpers = hunk.added.filter((line) => {
                const functionMatch = /^(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u.exec(line);
                if (functionMatch) return !AUTHORIZED_SYMBOLS.has(functionMatch[1]);
                const constMatch = /^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s+)?\(/u.exec(line);
                return Boolean(constMatch);
              });
              assert.deepEqual(newHelpers, [], "service diff adds no named function/const/class helper");
            }
          }
          break;
        }
        case "R3-C06-write-file-set-exact": {
          const diff = spawnSync("git", ["diff", "--name-only", R3_BASE, R3_HEAD], { cwd: projectRoot, encoding: "utf8" });
          assert.equal(diff.status, 0, diff.stderr);
          const changed = diff.stdout.split("\n").filter(Boolean);
          assert.deepEqual([...changed].sort(), [...AUTHORIZED_WRITE_PATHS].sort(),
            `fixed-revision changed-file set must be exactly the nine authorized paths, got ${JSON.stringify(changed)}`);
          break;
        }
        case "R3-C07-prohibited-import-set-empty": {
          const prohibited = /sqlite|python|subprocess|python-shell|node:worker/u;
          const diff = spawnSync("git", ["diff", "--no-color", R3_BASE, R3_HEAD], { cwd: projectRoot, encoding: "utf8" });
          assert.equal(diff.status, 0, diff.stderr);
          const addedImports = diff.stdout.split("\n")
            .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
            .map((line) => line.slice(1))
            .filter((line) => /^import\s/u.test(line));
          assert.ok(addedImports.length > 0, "the KI-R3 diff adds import statements to inspect");
          for (const statement of addedImports) {
            assert.equal(prohibited.test(statement), false, `prohibited added import: ${statement}`);
          }
          const newFiles = ["test/keyword-intelligence-enforcement.test.js",
            "test/fixtures/keyword-intelligence/ki-r3-enforcement-manifest-v1.json",
            "test/fixtures/keyword-intelligence/ki-r4-enforcement-manifest-v1.json"];
          for (const path of newFiles) {
            const source = readFileSync(`${projectRoot}/${path}`, "utf8");
            for (const match of source.matchAll(/^import\s+[^;]+;/gmu)) {
              assert.equal(prohibited.test(match[0]), false, `${path} contains prohibited import: ${match[0]}`);
            }
          }
          break;
        }
        case "R3-C08-no-skip-todo-only": {
          const all = Object.values(MANIFEST.groups).flat();
          assert.equal(all.length, TOTAL_CASES);
          const slugOf = (id) => id.replace(/^R3-[A-Z]\d{2}-/u, "");
          assert.equal(all.some((id) => ["skip", "todo", "skipped", "wip", "pending"].includes(slugOf(id)) ||
            id.includes(".todo")), false, "no manifest ID is a skip/todo marker placeholder");
          assert.ok(all.every((id) => /^R3-[A-Z]\d{2}-[a-z0-9-]+$/u.test(id)),
            "every case ID matches the literal R3-<group>-<NN>-<slug> form");
          assert.equal(MANIFEST.groups.adapter.length, 16);
          assert.equal(MANIFEST.groups.dispatcher.length, 12);
          assert.equal(MANIFEST.groups.task_component.length, 18);
          assert.equal(MANIFEST.groups.recovery_component.length, 18);
          assert.equal(MANIFEST.groups.task_database.length, 5);
          assert.equal(MANIFEST.groups.aggregation.length, 24);
          assert.equal(MANIFEST.groups.conformance.length, 8);
          break;
        }
        default:
          assert.fail(`unhandled conformance case ${caseId}`);
      }
    });
  }
  const sortedExecuted = [...executed].sort();
  const sortedExpected = [...MANIFEST.groups.conformance].sort();
  assert.deepEqual(sortedExecuted, sortedExpected, "every conformance manifest ID executed exactly once");
  assert.equal(executed.length, MANIFEST.groups.conformance.length);
});

test("SCN-KI-035: commit-stable R4 manifest and fixed-revision conformance", async (t) => {
  const R4_GROUP_COUNTS = {
    adapter_control: 1,
    dispatcher: 2,
    worker_component: 5,
    aggregation_control: 1,
    conformance: 6
  };
  const fd1 = (ids) => createHash("sha256").update(Buffer.from([...ids].sort().join("\n"), "utf8")).digest("hex");
  const fd2 = (ids) => {
    const sorted = [...new Set(ids)].sort((a, b) => Buffer.from(a, "utf8").compare(Buffer.from(b, "utf8")));
    return createHash("sha256").update(Buffer.from(sorted.map((id) => `${id}\n`).join(""), "utf8")).digest("hex");
  };

  assert.deepEqual(Object.keys(R4_MANIFEST).sort(), ["contractVersion", "groups"]);
  assert.equal(R4_MANIFEST.contractVersion, "ki-r4-enforcement-manifest-v1");
  assert.deepEqual(Object.keys(R4_MANIFEST.groups).sort(),
    ["adapter_control", "aggregation_control", "conformance", "dispatcher", "worker_component"]);
  for (const [group, count] of Object.entries(R4_GROUP_COUNTS)) {
    assert.equal(R4_MANIFEST.groups[group].length, count, `R4 group ${group} count`);
  }
  const r4All = Object.values(R4_MANIFEST.groups).flat();
  assert.equal(r4All.length, 15, "R4 manifest holds exactly 15 total case IDs");
  assert.equal(new Set(r4All).size, 15, "R4 case IDs globally unique");
  assert.equal(fd2(r4All), "6adc8ab132496c58608734549fbbc596577e1bd71c1e730349575eb96badc941",
    "R4 global F-D2 digest exact");

  const executed = [];
  for (const caseId of R4_MANIFEST.groups.conformance) {
    await t.test(caseId, async () => {
      executed.push(caseId);
      switch (caseId) {
        case "R4-C01-fixed-revision-diff-nonempty": {
          for (const path of ["src/aws-pipeline/keyword-intelligence/dataforseo-labs-adapter.js",
            "src/aws-pipeline/adapters/queue-dispatcher.js",
            "src/aws-pipeline/keyword-intelligence/service.js"]) {
            assert.ok(gitDiffHunks(path).length > 0, `fixed-revision diff for ${path} must be nonempty`);
          }
          break;
        }
        case "R4-C02-fixed-revision-file-set-exact": {
          const diff = spawnSync("git", ["diff", "--name-only", R3_BASE, R3_HEAD], { cwd: projectRoot, encoding: "utf8" });
          assert.equal(diff.status, 0, diff.stderr);
          const changed = diff.stdout.split("\n").filter(Boolean);
          assert.deepEqual([...changed].sort(), [...AUTHORIZED_WRITE_PATHS].sort(),
            `fixed-revision changed-file set must be exactly the nine authorized paths, got ${JSON.stringify(changed)}`);
          break;
        }
        case "R4-C03-fixed-revision-import-set-clean": {
          const prohibited = /sqlite|python|subprocess|python-shell|node:worker/u;
          const diff = spawnSync("git", ["diff", "-U0", R3_BASE, R3_HEAD], { cwd: projectRoot, encoding: "utf8" });
          assert.equal(diff.status, 0, diff.stderr);
          const addedImports = diff.stdout.split("\n")
            .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
            .map((line) => line.slice(1))
            .filter((line) => /^import\s/u.test(line));
          assert.ok(addedImports.length > 0, "the fixed-revision diff adds import statements to inspect");
          for (const statement of addedImports) {
            assert.equal(prohibited.test(statement), false, `prohibited added import: ${statement}`);
          }
          break;
        }
        case "R4-C04-r3-group-digests-exact": {
          const expected = {
            adapter: "b4ede4c2a1a32fddc1a1ac67e023a81f93c6863632cdff2be421f20d51080e4f",
            dispatcher: "962ad70760c71a6fcf08b73d5edf0cdccad27dea9c3414c552c1d8e3e2b99226",
            task_component: "d6773f3749e9f68c3b270df9ad63aba6297328b5578d1e5f3346ee2683518110",
            recovery_component: "b6d8b7a1435b6a62da061980afd370290f16b899774bba32578e3df9cc5f2737",
            task_database: "9e8a3973d5430be70e26f68bb235b831b96f17162d30277a40b06942cc94e934",
            aggregation: "c017cd869b11a93e86070112ed626a3cd299e00a518ed3a568dd8f1331c27b14",
            conformance: "43bbc0bd4dd296447b989ee2125fc0f991c2451f29e3f4ef87c05f8685a607f8"
          };
          for (const [group, literal] of Object.entries(expected)) {
            assert.equal(fd1(MANIFEST.groups[group]), literal, `R3 group ${group} F-D1 digest exact`);
          }
          break;
        }
        case "R4-C05-r3-global-digest-exact": {
          assert.equal(fd1(Object.values(MANIFEST.groups).flat()),
            "70bd758e68cb32aff7dc418356d68e3ca07dadf282f76e7484858a7ec0c9470b",
            "R3 global F-D1 digest exact");
          break;
        }
        case "R4-C06-live-worktree-independent": {
          const runnerFiles = ["test/keyword-intelligence-adapter.test.js",
            "test/aws-pipeline-runtime-adapters.test.js",
            "test/keyword-intelligence-worker.test.js",
            "test/keyword-intelligence-worker-flow.test.js",
            "test/keyword-intelligence-enforcement.test.js"];
          const gitSpawnArgs = /spawnSync\(\s*"git",\s*\[([^\]]*)\]/gu;
          for (const path of runnerFiles) {
            const source = readFileSync(`${projectRoot}/${path}`, "utf8");
            for (const match of source.matchAll(gitSpawnArgs)) {
              const args = match[1];
              assert.ok(!/["']status["']/u.test(args), `${path} must not spawn live git status`);
              if (/["']diff["']/u.test(args)) {
                assert.ok(args.includes("R3_BASE") && args.includes("R3_HEAD"),
                  `${path} contains a revision-less git diff spawn: ${args}`);
              }
            }
          }
          break;
        }
        default:
          assert.fail(`unhandled R4 conformance case ${caseId}`);
      }
    });
  }
  const sortedExecuted = [...executed].sort();
  const sortedExpected = [...R4_MANIFEST.groups.conformance].sort();
  assert.deepEqual(sortedExecuted, sortedExpected, "every R4 conformance manifest ID executed exactly once");
  assert.equal(executed.length, R4_MANIFEST.groups.conformance.length);
});
