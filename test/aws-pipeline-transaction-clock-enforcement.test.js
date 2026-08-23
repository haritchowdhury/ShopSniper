import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PrismaRunRepository } from "../src/prisma-run-repository.js";

const sourceUrl = (relative) => new URL(relative, import.meta.url);
const COORDINATOR_FILE = "../src/aws-pipeline/repositories/pipeline-coordinator-repository.js";
const RUN_REPOSITORY_FILE = "../src/prisma-run-repository.js";
const DOMAIN_AGGREGATOR_FILE = "../src/aws-pipeline/services/domain-aggregator.js";
const LEAD_AGGREGATOR_FILE = "../src/aws-pipeline/services/lead-aggregator.js";
const FINAL_AGGREGATOR_FILE = "../src/aws-pipeline/services/final-aggregator.js";

const REQUIRED = ["W6-DB-08", "W6-DB-09", "W6-DB-10", "W6-DB-11"];
const CONTROLS = ["W6-NC-18", "W6-NC-19", "W6-NC-20"];
const COORDINATOR_METHODS = [
  "registerStage", "recordDispatch", "claimTask", "renewTask", "recordTerminal",
  "claimAggregator", "renewAggregator", "getCompleteStage", "completeAggregator",
  "listRecoverable", "cancelRunGeneration"
];
const RUN_REPOSITORY_METHODS = [
  "publishAwsDiscoveryStage", "readAwsReuseInputs", "readAwsReusableProfiles",
  "publishAwsDomainCheckpoint", "publishAwsLeadCheckpoint", "claimAwsLeadWork",
  "claimAwsRunLease", "releaseAwsRunLease", "loadAwsTrafficStage",
  "claimAwsTrafficWorkBatch", "recordAwsDataForSeoOutcome", "readAwsFinalReuseRows",
  "readAwsAmbiguousDataForSeoTargets", "readAwsTerminalCruxBigQueryWork",
  "publishAwsFinalResults", "readReusableTrafficCache", "readReusableLatestCruxBigQueryCache",
  "planDataForSeoRequest", "claimDataForSeoRequest", "getDataForSeoRunCostUsd",
  "markStaleDataForSeoRequestsAmbiguous"
];
const CLOCK_METHODS = [
  "readAwsReuseInputs", "readAwsReusableProfiles", "readAwsFinalReuseRows",
  "readAwsAmbiguousDataForSeoTargets", "readAwsTerminalCruxBigQueryWork"
];
const SERVICE_CALLERS = [
  { file: DOMAIN_AGGREGATOR_FILE, method: "readAwsReuseInputs", count: 1 },
  { file: LEAD_AGGREGATOR_FILE, method: "readAwsReusableProfiles", count: 1 },
  { file: FINAL_AGGREGATOR_FILE, method: "readAwsAmbiguousDataForSeoTargets", count: 1 },
  { file: FINAL_AGGREGATOR_FILE, method: "readAwsTerminalCruxBigQueryWork", count: 1 },
  { file: FINAL_AGGREGATOR_FILE, method: "readAwsFinalReuseRows", count: 1 }
];
const COORDINATOR_TRANSACTION_LITERAL =
  "const PIPELINE_TRANSACTION_OPTIONS = Object.freeze({ maxWait: 5_000, timeout: 30_000 });";
const RUN_TRANSACTION_LITERAL =
  "const AWS_PIPELINE_TRANSACTION_OPTIONS = Object.freeze({ maxWait: 5_000, timeout: 30_000 });";
const INLINE_PROFILE = "{ maxWait: 5_000, timeout: 30_000 }";
const FROZEN_PROFILE = "Object.freeze({ maxWait: 5_000, timeout: 30_000 })";
const REQUIRED_DIGEST =
  "e8bd1b4a3b3deb8f853eac0e8bcea5609278177945389f292b1b12a7309bf030";
const CONTROLS_DIGEST =
  "89e40c02b11dd426c8445de018a9d85fa2c110b6da9728cee8dff4e3cc31db1b";

const registered = [];
const executed = [];
const witnesses = {
  coordinatorTransactions: 0,
  runRepositoryTransactions: 0,
  assertionClockSites: 0,
  serviceCallers: 0
};
const failures = [];
const falsifiedControls = [];

const readSource = (relative) => readFile(sourceUrl(relative), "utf8");
const [coordinatorSource, runRepositorySource, domainAggregatorSource,
  leadAggregatorSource, finalAggregatorSource] = await Promise.all([
    readSource(COORDINATOR_FILE),
    readSource(RUN_REPOSITORY_FILE),
    readSource(DOMAIN_AGGREGATOR_FILE),
    readSource(LEAD_AGGREGATOR_FILE),
    readSource(FINAL_AGGREGATOR_FILE)
  ]);
const REAL = {
  coordinatorSource,
  runRepositorySource,
  serviceSources: {
    [DOMAIN_AGGREGATOR_FILE]: domainAggregatorSource,
    [LEAD_AGGREGATOR_FILE]: leadAggregatorSource,
    [FINAL_AGGREGATOR_FILE]: finalAggregatorSource
  }
};

function classSpan(source, className) {
  const marker = `class ${className}`;
  const classStart = source.indexOf(marker);
  if (classStart === -1) throw new Error(`class ${className} is absent`);
  const open = source.indexOf("{", classStart);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return { start: classStart, end: index + 1 };
    }
  }
  throw new Error(`class ${className} is unbalanced`);
}

function classMethods(source, className) {
  const span = classSpan(source, className);
  const body = source.slice(span.start, span.end);
  const matches = [...body.matchAll(/^ {2}(?:async )?([A-Za-z_$][A-Za-z0-9_$]*)\(/gmu)];
  const methods = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = span.start + match.index;
    const end = index + 1 < matches.length
      ? span.start + matches[index + 1].index
      : span.end;
    methods.set(match[1], { text: source.slice(start, end), start, end });
  }
  if (methods.size === 0) throw new Error(`class ${className} yielded no methods`);
  return methods;
}

function moduleFunctionSpan(source, name) {
  const marker = `\nasync function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`module function ${name} is absent`);
  const tail = source.slice(start + 1);
  const boundary = /\n\S/u.exec(tail);
  const end = start + 1 + (boundary ? boundary.index : tail.length);
  return { text: source.slice(start + 1, end), start: start + 1, end };
}

function callTextFrom(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  throw new Error("call is unbalanced");
}

function occurrences(text, literal) {
  return text.split(literal).length - 1;
}

function assertCallSites(source, expectedCount, fileRole) {
  const pattern = /(?<!function )assertCompleteAggregatorInTransaction\(/gu;
  const sites = [];
  for (const match of source.matchAll(pattern)) {
    sites.push(callTextFrom(source, match.index + match[0].length - 1));
  }
  assert.equal(sites.length, expectedCount, `${fileRole} call-site count`);
  return sites;
}

function oracleW6Db08(context = REAL) {
  const coordinatorMethods = classMethods(context.coordinatorSource, "PipelineCoordinatorRepository");
  const membership = [...coordinatorMethods.entries()]
    .filter(([, method]) => method.text.includes("$transaction"))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(membership, [...COORDINATOR_METHODS].sort(),
    "coordinator $transaction membership must be exactly the eleven methods");
  for (const name of COORDINATOR_METHODS) {
    assert.ok(coordinatorMethods.get(name)?.text.includes("PIPELINE_TRANSACTION_OPTIONS"),
      `coordinator method ${name} must carry PIPELINE_TRANSACTION_OPTIONS`);
  }
  assert.equal(occurrences(context.coordinatorSource, COORDINATOR_TRANSACTION_LITERAL), 1,
    "coordinator frozen transaction literal defined exactly once");
  const coordinatorInline = occurrences(context.coordinatorSource, INLINE_PROFILE)
    - occurrences(context.coordinatorSource, FROZEN_PROFILE);
  assert.equal(coordinatorInline, 0, "coordinator carries zero inline transaction profiles");

  const runMethods = classMethods(context.runRepositorySource, "PrismaRunRepository");
  for (const name of RUN_REPOSITORY_METHODS) {
    const method = runMethods.get(name);
    if (!method) throw new Error(`run repository method ${name} is absent`);
    assert.ok(method.text.includes("$transaction"), `${name} must transact`);
    assert.ok(method.text.includes("AWS_PIPELINE_TRANSACTION_OPTIONS"),
      `${name} must carry AWS_PIPELINE_TRANSACTION_OPTIONS`);
  }
  const runTokens = occurrences(context.runRepositorySource, "AWS_PIPELINE_TRANSACTION_OPTIONS");
  const runDefinitions = occurrences(context.runRepositorySource, RUN_TRANSACTION_LITERAL);
  assert.equal(runDefinitions, 1, "run repository frozen transaction literal defined exactly once");
  assert.equal(runTokens - runDefinitions, RUN_REPOSITORY_METHODS.length,
    "run repository uses the frozen options exactly twenty-one times");
  const runInline = occurrences(context.runRepositorySource, INLINE_PROFILE)
    - occurrences(context.runRepositorySource, FROZEN_PROFILE);
  assert.equal(runInline, 1, "exactly one surviving inline transaction profile");
  assert.ok(runMethods.get("saveQueryValidation")?.text.includes(INLINE_PROFILE),
    "the surviving inline profile lives inside saveQueryValidation");
  const renewLease = runMethods.get("renewAwsRunLease");
  if (!renewLease) throw new Error("run repository method renewAwsRunLease is absent");
  assert.equal(renewLease.text.includes("$transaction"), false,
    "renewAwsRunLease must not open a transaction");
  assert.ok(renewLease.text.includes("updateMany"), "renewAwsRunLease retains updateMany");

  witnesses.coordinatorTransactions = membership.length;
  witnesses.runRepositoryTransactions = runTokens - runDefinitions;
}

function oracleW6Db09(context = REAL) {
  const coordinatorSites = assertCallSites(context.coordinatorSource, 1, "coordinator");
  const runSites = assertCallSites(context.runRepositorySource, 8, "run repository");
  const sites = [...coordinatorSites, ...runSites];
  assert.equal(sites.length, 9, "nine assertion clock sites across both repositories");
  for (const site of sites) {
    assert.equal(site.includes("new Date()"), false,
      "no assertion clock site may pass new Date()");
    assert.match(site, /,\s*now\s*\)$/u, "every assertion clock site forwards now");
  }

  const runMethods = classMethods(context.runRepositorySource, "PrismaRunRepository");
  for (const name of CLOCK_METHODS) {
    const method = runMethods.get(name);
    if (!method) throw new Error(`clock method ${name} is absent`);
    assert.ok(method.text.startsWith(`  async ${name}(input, now) {`),
      `${name} must declare (input, now) with no clock default`);
    const clockGuard = method.text.indexOf("requireAwsPipelineNow(now)");
    const transaction = method.text.indexOf("$transaction");
    assert.ok(clockGuard !== -1, `${name} must call requireAwsPipelineNow(now)`);
    assert.ok(transaction !== -1, `${name} must transact`);
    assert.ok(clockGuard < transaction, `${name} must validate the clock before transacting`);
    assert.match(method.text, /\},\s*now\s*\)/u, `${name} must forward now`);
  }
  assert.equal(occurrences(context.runRepositorySource, "function requireAwsPipelineNow("), 1,
    "requireAwsPipelineNow defined exactly once");

  for (const caller of SERVICE_CALLERS) {
    const source = context.serviceSources[caller.file];
    if (!source) throw new Error(`service source ${caller.file} is absent`);
    const pattern = new RegExp(`${caller.method}\\(`, "gu");
    const matches = [...source.matchAll(pattern)];
    assert.equal(matches.length, caller.count,
      `${caller.file} calls ${caller.method} exactly ${caller.count} time(s)`);
    for (const match of matches) {
      const call = callTextFrom(source, match.index + match[0].length - 1);
      assert.match(call, /\},\s*new Date\(\)\)$/u,
        `${caller.file} ${caller.method} call must pass a fresh new Date() clock`);
    }
  }

  witnesses.assertionClockSites = sites.length;
  witnesses.serviceCallers = SERVICE_CALLERS.reduce((sum, caller) => sum + caller.count, 0);
}

function oracleW6Db10(context = REAL) {
  for (const name of ["lockedTask", "lockedStage", "lockedRun"]) {
    const span = moduleFunctionSpan(context.coordinatorSource, name);
    assert.ok(span.text.includes("SELECT *"), `${name} selects the full row`);
    assert.ok(span.text.includes("FOR UPDATE"), `${name} takes a row lock`);
    assert.ok(span.text.includes("rows[0]"), `${name} reads rows[0]`);
    assert.equal(span.text.includes("findUnique"), false,
      `${name} must not reload through findUnique`);
  }
  const recordDispatch = classMethods(context.coordinatorSource, "PipelineCoordinatorRepository")
    .get("recordDispatch");
  if (!recordDispatch) throw new Error("coordinator method recordDispatch is absent");
  assert.ok(recordDispatch.text.includes("SELECT *"), "recordDispatch locks via SELECT *");
  assert.equal(recordDispatch.text.includes("findMany"), false,
    "recordDispatch must not findMany");
  assert.equal(occurrences(recordDispatch.text, "updateMany"), 1,
    "recordDispatch performs exactly one updateMany");
}

const VALID_NOW = new Date("2026-08-23T00:00:00.000Z");
const CLOCK_INPUTS = new Map([
  ["readAwsReuseInputs", {}],
  ["readAwsReusableProfiles", {}],
  ["readAwsFinalReuseRows", { evaluatedAt: VALID_NOW, selections: [] }],
  ["readAwsAmbiguousDataForSeoTargets", { candidates: [] }],
  ["readAwsTerminalCruxBigQueryWork", { candidates: [] }]
]);
const INVALID_CLOCKS = [undefined, new Date("invalid"), 42];
const inputConflict = (error) => error instanceof Error && error.code === "PIPELINE_INPUT_CONFLICT";

async function oracleW6Db11() {
  const guardPrisma = { $transaction: async () => { throw new Error("transaction must not start"); } };
  const guarded = new PrismaRunRepository(guardPrisma, {});
  for (const [name, input] of CLOCK_INPUTS) {
    await assert.rejects(guarded[name](input), inputConflict, `${name} rejects a missing clock`);
    for (const invalid of INVALID_CLOCKS) {
      await assert.rejects(guarded[name](input, invalid), inputConflict,
        `${name} rejects clock ${String(invalid)}`);
    }
  }
  let transactionAttempts = 0;
  const countingPrisma = {
    $transaction: async () => {
      transactionAttempts += 1;
      throw new Error("transaction must not start");
    }
  };
  const counting = new PrismaRunRepository(countingPrisma, {});
  for (const [name, input] of CLOCK_INPUTS) {
    await assert.rejects(counting[name](input), inputConflict, `${name} rejects a missing clock`);
    for (const invalid of INVALID_CLOCKS) {
      await assert.rejects(counting[name](input, invalid), inputConflict,
        `${name} rejects clock ${String(invalid)}`);
    }
  }
  assert.equal(transactionAttempts, 0, "rejected clocks never start a transaction");

  const sentinel = new Error("KI_W6_SENTINEL_TRANSPORT_REACHED");
  const sentinelPrisma = { $transaction: async () => { throw sentinel; } };
  const sentinelRepository = new PrismaRunRepository(sentinelPrisma, {});
  for (const [name, input] of CLOCK_INPUTS) {
    await assert.rejects(sentinelRepository[name](input, VALID_NOW),
      (error) => error === sentinel,
      `${name} passes clock validation and reaches $transaction`);
  }
}

function replaceOnceInMethod(source, className, methodName, literal, replacement) {
  const methods = classMethods(source, className);
  const method = methods.get(methodName);
  if (!method) throw new Error(`method ${methodName} is absent`);
  assert.equal(occurrences(method.text, literal), 1,
    `${methodName} must contain the mutation target exactly once`);
  const offset = method.text.indexOf(literal);
  return source.slice(0, method.start) + method.text.slice(0, offset) + replacement
    + method.text.slice(offset + literal.length) + source.slice(method.end);
}

function mutateListRecoverable(source) {
  return replaceOnceInMethod(source, "PipelineCoordinatorRepository", "listRecoverable",
    "}, PIPELINE_TRANSACTION_OPTIONS);", "});");
}

function mutateFirstClockForwarding(source) {
  const match = /(?<!function )assertCompleteAggregatorInTransaction\(/u.exec(source);
  if (!match) throw new Error("assertion clock site is absent");
  const openIndex = match.index + match[0].length - 1;
  const call = callTextFrom(source, openIndex);
  const mutatedCall = call.replace(/\},\s*now\s*\)$/u, "}, new Date())");
  if (mutatedCall === call) throw new Error("forwarded now terminator is absent");
  return source.slice(0, openIndex) + mutatedCall + source.slice(openIndex + call.length);
}

function mutateLockedStage(source) {
  const span = moduleFunctionSpan(source, "lockedStage");
  const anchor = "  return rows[0];";
  const offset = span.text.indexOf(anchor);
  if (offset === -1) throw new Error("lockedStage return anchor is absent");
  const insertion = "  await transaction.pipelineStage.findUnique({ where: { id: stageId } });\n";
  const absolute = span.start + offset;
  return source.slice(0, absolute) + insertion + source.slice(absolute);
}

async function runRequired(id, oracle) {
  registered.push(id);
  try {
    await oracle();
    executed.push(id);
  } catch (error) {
    failures.push({ id, message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

test("W6-DB-08: transaction memberships and frozen constants", () => runRequired("W6-DB-08", oracleW6Db08));

test("W6-DB-09: nine assertion clock sites and required-now plumbing", () => runRequired("W6-DB-09", oracleW6Db09));

test("W6-DB-10: lock and read ceilings inside transactions", () => runRequired("W6-DB-10", oracleW6Db10));

test("W6-DB-11: required-now rejection before any transaction", () => runRequired("W6-DB-11", oracleW6Db11));

test("W6-NC-18: removing listRecoverable options falsifies W6-DB-08", () => {
  const mutated = mutateListRecoverable(coordinatorSource);
  assert.notEqual(mutated, coordinatorSource);
  assert.throws(() => oracleW6Db08({
    ...REAL,
    coordinatorSource: mutated
  }), "W6-DB-08 oracle must reject a dropped transaction options argument");
  falsifiedControls.push("W6-NC-18");
  oracleW6Db08(REAL);
});

test("W6-NC-19: replacing one forwarded now falsifies W6-DB-09", () => {
  const mutated = mutateFirstClockForwarding(runRepositorySource);
  assert.notEqual(mutated, runRepositorySource);
  assert.throws(() => oracleW6Db09({
    ...REAL,
    runRepositorySource: mutated
  }), "W6-DB-09 oracle must reject new Date() at a clock site");
  falsifiedControls.push("W6-NC-19");
  oracleW6Db09(REAL);
});

test("W6-NC-20: restoring a lockedStage reload falsifies W6-DB-10", () => {
  const mutated = mutateLockedStage(coordinatorSource);
  assert.notEqual(mutated, coordinatorSource);
  assert.throws(() => oracleW6Db10({
    ...REAL,
    coordinatorSource: mutated
  }), "W6-DB-10 oracle must reject a findUnique reload inside lockedStage");
  falsifiedControls.push("W6-NC-20");
  oracleW6Db10(REAL);
});

test("KI_W6_TXN_CLOCK_ENFORCEMENT certificate", () => {
  const digest = (ids) => createHash("sha256")
    .update(Buffer.from([...new Set(ids)].sort().map((id) => `${id}\n`).join(""), "utf8"))
    .digest("hex");
  assert.deepEqual(registered, REQUIRED, "registered equals required");
  assert.deepEqual(executed, REQUIRED, "executed equals required with zero skips");
  assert.deepEqual(failures, [], "no oracle failures");
  assert.deepEqual(falsifiedControls, CONTROLS, "all negative controls falsified");
  const certificate = {
    file: "aws-pipeline-transaction-clock-enforcement.test.js",
    required: REQUIRED,
    registered: [...registered],
    executed: [...executed],
    skipped: [],
    activationWitnesses: {
      coordinatorTransactions: witnesses.coordinatorTransactions,
      runRepositoryTransactions: witnesses.runRepositoryTransactions,
      assertionClockSites: witnesses.assertionClockSites,
      serviceCallers: witnesses.serviceCallers
    },
    oracleFailures: failures.map(({ id }) => id),
    negativeControls: {
      expected: CONTROLS.length,
      falsified: falsifiedControls.length,
      ids: [...falsifiedControls]
    },
    digests: {
      required: digest(REQUIRED),
      registered: digest(registered),
      executed: digest(executed),
      controls: digest(CONTROLS)
    }
  };
  assert.deepEqual(certificate.activationWitnesses, {
    coordinatorTransactions: 11,
    runRepositoryTransactions: 21,
    assertionClockSites: 9,
    serviceCallers: 5
  });
  assert.deepEqual(certificate.negativeControls, {
    expected: 3,
    falsified: 3,
    ids: ["W6-NC-18", "W6-NC-19", "W6-NC-20"]
  });
  assert.equal(certificate.digests.required, REQUIRED_DIGEST);
  assert.equal(certificate.digests.registered, REQUIRED_DIGEST);
  assert.equal(certificate.digests.executed, REQUIRED_DIGEST);
  assert.equal(certificate.digests.controls, CONTROLS_DIGEST);
  console.log(`KI_W6_TXN_CLOCK_ENFORCEMENT_CERTIFICATE=${JSON.stringify(certificate)}`);
});
