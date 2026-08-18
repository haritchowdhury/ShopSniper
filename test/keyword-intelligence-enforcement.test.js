import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/keyword-intelligence", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(`${fixtureDir}/ki-r3-enforcement-manifest-v1.json`, "utf8"));

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
  const result = spawnSync("git", ["diff", "-U0", "--", path], { cwd: projectRoot, encoding: "utf8" });
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
          for (const hunk of adapterHunks) {
            assert.ok(withinAny(hunk, [[46, 56]]), `adapter diff outside settlementFence: ${JSON.stringify(hunk)}`);
          }
          const dispatchHunks = gitDiffHunks("src/aws-pipeline/adapters/queue-dispatcher.js");
          for (const hunk of dispatchHunks) {
            assert.ok(withinAny(hunk, [[28, 50]]), `dispatcher diff outside sendOne: ${JSON.stringify(hunk)}`);
          }
          const serviceHunks = gitDiffHunks("src/aws-pipeline/keyword-intelligence/service.js");
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
          const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
          assert.equal(status.status, 0, status.stderr);
          const changed = status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3)).filter(Boolean);
          assert.deepEqual([...changed].sort(), [...AUTHORIZED_WRITE_PATHS].sort(),
            `nested changed-file set must be exactly the nine authorized paths, got ${JSON.stringify(changed)}`);
          break;
        }
        case "R3-C07-prohibited-import-set-empty": {
          const prohibited = /sqlite|python|subprocess|python-shell|node:worker/u;
          const diff = spawnSync("git", ["diff", "--no-color"], { cwd: projectRoot, encoding: "utf8" });
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
            "test/fixtures/keyword-intelligence/ki-r3-enforcement-manifest-v1.json"];
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
