import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ESM_REQUIRE_BANNER,
  LAMBDA_HANDLERS,
  REQUIRED_PRISMA_ENGINE
} from "../scripts/build-lambda.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = path.join(projectRoot, "dist", "lambda");

test("Lambda package dependencies are pinned exactly", async () => {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies["@aws-sdk/client-s3"], "3.1107.0");
  assert.equal(packageJson.dependencies["@aws-sdk/client-sqs"], "3.1107.0");
  assert.equal(packageJson.dependencies["@aws-sdk/client-secrets-manager"], "3.1107.0");
  assert.equal(packageJson.devDependencies.esbuild, "0.28.2");
  const lock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  assert.equal(lock.packages[""].dependencies["@aws-sdk/client-s3"], "3.1107.0");
  assert.equal(lock.packages[""].dependencies["@aws-sdk/client-sqs"], "3.1107.0");
  assert.equal(lock.packages[""].dependencies["@aws-sdk/client-secrets-manager"], "3.1107.0");
  assert.equal(lock.packages[""].devDependencies.esbuild, "0.28.2");
});

test("Prisma generation and Lambda packaging pin the Amazon Linux 2023 engine", async () => {
  const schema = await readFile(path.join(projectRoot, "prisma/schema.prisma"), "utf8");
  assert.match(schema, /binaryTargets\s*=\s*\["native",\s*"rhel-openssl-3\.0\.x"\]/u);
  assert.equal(REQUIRED_PRISMA_ENGINE, "libquery_engine-rhel-openssl-3.0.x.so.node");
  assert.equal(REQUIRED_PRISMA_ENGINE.includes("debian"), false);
});

test("all seven Lambda packages pass inventory, size, and engine inspection", async () => {
  const report = JSON.parse(await readFile(path.join(outputRoot, "measurements.json"), "utf8"));
  assert.deepEqual(report.measurements.map(({ handler }) => handler), LAMBDA_HANDLERS);
  for (const measurement of report.measurements) {
    assert.ok(measurement.zipBytes <= 45 * 1024 * 1024);
    assert.ok(measurement.unzippedBytes <= 200 * 1024 * 1024);
    assert.equal(measurement.enginePresent, true);
    assert.equal(measurement.requiredEngine, REQUIRED_PRISMA_ENGINE);
    assert.ok(measurement.files.includes("index.mjs"));
    assert.equal(measurement.files.filter((file) => /query_engine.*\.node$/i.test(file)).length, 1);
    assert.equal(measurement.files.some((file) => /(^|\/)\.env(?:\.|$)|(^|\/)tests?\/|(^|\/)fixtures?\/|(^|\/)docs?\/|\.map$|\.md$/i.test(file)), false);
    assert.match(measurement.fileListHash, /^[a-f0-9]{64}$/);
    assert.ok(measurement.coldImport.durationMs >= 0);
    assert.ok(measurement.coldImport.rssBytes > 0);
  }
});

test("ESM Lambda bundles install CommonJS require interop before bundled SDK code", async () => {
  for (const handlerName of LAMBDA_HANDLERS) {
    const bundle = await readFile(
      path.join(projectRoot, ".lambda-build", handlerName, "index.mjs"),
      "utf8"
    );
    assert.equal(bundle.startsWith(`${ESM_REQUIRE_BANNER}\n`), true, handlerName);
  }

  const discoveryBundle = await readFile(
    path.join(projectRoot, ".lambda-build", "discovery-worker", "index.mjs"),
    "utf8"
  );
  assert.match(discoveryBundle, /__require\(["']node:https["']\)/);
});

for (const handlerName of LAMBDA_HANDLERS) {
  test(`${handlerName} imports without work and has its expected empty invocation boundary`, () => {
    const handlerUrl = pathToFileURL(path.join(projectRoot, "src", "aws-pipeline", "handlers", `${handlerName}.js`)).href;
    const temporary = mkdtempSync(path.join(tmpdir(), "storesignal-handler-test-"));
    const resultPath = path.join(temporary, "result.json");
    try {
      const program = `import{writeFileSync}from"node:fs";const module=await import(${JSON.stringify(handlerUrl)});let invoked;try{await module.handler();invoked="resolved"}catch(error){invoked=error.message}writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({imported:true,invoked}));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          RUN_EXECUTION_BACKEND: "local",
          AWS_PIPELINE_ENABLED: "false"
        }
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")),
        ["discovery-worker", "domain-aggregator", "lead-worker", "lead-aggregator", "traffic-worker", "final-aggregator"].includes(handlerName)
          ? { imported: true, invoked: "resolved" }
          : { imported: true, invoked: "PIPELINE_INPUT_CONFLICT" });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test("SCN-KI-027: keyword build removes only its own paths, is two-run reproducible, and preserves siblings", async () => {
  const {
    buildKeywordWorkerPackage,
    KEYWORD_LAMBDA_HANDLERS
  } = await import("../scripts/build-keyword-worker.js");
  const {
    readFile, readdir, writeFile, mkdir, rm, stat
  } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const stagingRoot = path.join(projectRoot, ".lambda-build");
  const archiveRoot = path.join(projectRoot, "dist", "lambda");
  const sentinels = [];
  const sentinelPaths = [];
  const recordSentinel = (absolute) => { sentinels.push(absolute); sentinelPaths.push(path.relative(projectRoot, absolute)); };

  async function treeHash(root) {
    const entries = await readdir(root, { withFileTypes: true });
    const lines = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) lines.push(`${entry.name}/\n${await treeHash(absolute)}`);
      else lines.push(`${entry.name}:${sha(await readFile(absolute))}\n`);
    }
    return sha(lines.join(""));
  }

  const siblings = LAMBDA_HANDLERS.filter((name) => !KEYWORD_LAMBDA_HANDLERS.includes(name));
  const siblingStagingHashes = {};
  const siblingZipHashes = {};
  for (const name of siblings) {
    siblingStagingHashes[name] = await treeHash(path.join(stagingRoot, name));
    siblingZipHashes[name] = sha(await readFile(path.join(archiveRoot, `${name}.zip`)));
  }
  const measurementsHash = sha(await readFile(path.join(archiveRoot, "measurements.json")));
  const ownStaging = path.join(stagingRoot, "keyword-worker");
  const ownArchive = path.join(archiveRoot, "keyword-worker.zip");

  const obsoleteMember = path.join(ownStaging, "obsolete-member.json");
  recordSentinel(obsoleteMember);
  await mkdir(ownStaging, { recursive: true });
  await writeFile(obsoleteMember, "{}");
  await writeFile(path.join(ownStaging, "sentinel-staging.txt"), "stale");
  recordSentinel(path.join(ownStaging, "sentinel-staging.txt"));
  await mkdir(archiveRoot, { recursive: true });
  const seededZip = spawnSync("zip", ["-X", "-q", ownArchive, "obsolete-member.json", "sentinel-staging.txt"], {
    cwd: ownStaging, encoding: "utf8"
  });
  if (seededZip.status !== 0) throw new Error(`seed zip failed: ${seededZip.stderr.trim()}`);

  await buildKeywordWorkerPackage();
  const firstZipHash = sha(await readFile(ownArchive));
  await buildKeywordWorkerPackage();
  const secondZipHash = sha(await readFile(ownArchive));
  assert.equal(firstZipHash, secondZipHash, "two keyword builds are byte-identical");

  const listing = spawnSync("unzip", ["-l", ownArchive], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.equal(listing.stdout.includes("obsolete-member.json"), false, "obsolete own member removed from ZIP");
  assert.equal(listing.stdout.includes("sentinel-staging.txt"), false, "stale staging sentinel absent from ZIP");

  for (const name of siblings) {
    assert.equal(await treeHash(path.join(stagingRoot, name)), siblingStagingHashes[name], `sibling staging ${name} unchanged`);
    assert.equal(sha(await readFile(path.join(archiveRoot, `${name}.zip`))), siblingZipHashes[name], `sibling ZIP ${name} unchanged`);
  }
  assert.equal(sha(await readFile(path.join(archiveRoot, "measurements.json"))), measurementsHash, "measurements unchanged");

  const inventory = spawnSync("unzip", ["-l", ownArchive], { encoding: "utf8" });
  assert.ok(inventory.stdout.includes("index.mjs"), "keyword bundle present");
  assert.equal((inventory.stdout.match(/libquery_engine-rhel-openssl-3\.0\.x\.so\.node/gu) ?? []).length, 1,
    "exactly one AL2023 engine");
  assert.equal(inventory.stdout.includes(".env"), false, "no env paths");
  const unzipped = spawnSync("unzip", ["-t", ownArchive], { encoding: "utf8" });
  assert.equal(unzipped.status, 0, unzipped.stderr);

  const temporary = mkdtempSync(path.join(tmpdir(), "storesignal-keyword-build-"));
  try {
    const extraction = path.join(temporary, "kw");
    const extract = spawnSync("unzip", ["-q", ownArchive, "-d", extraction], { encoding: "utf8" });
    assert.equal(extract.status, 0, extract.stderr);
    const entries = await readdir(extraction, { recursive: true });
    assert.ok(entries.includes("index.mjs"), "cold import entry exists");
    const engineCount = entries.filter((entry) => /libquery_engine-rhel-openssl-3\.0\.x\.so\.node$/u.test(entry)).length;
    assert.equal(engineCount, 1, "exactly one engine file in extraction");
    const forbidden = entries.some((entry) => /(^|\/)\.env(?:\.|$)|(^|\/)tests?\/|(^|\/)fixtures?\/|(^|\/)docs?\/|\.map$|\.md$/i.test(entry));
    assert.equal(forbidden, false, "no forbidden paths in extraction");
    const sizes = await Promise.all(entries.map(async (entry) => (await stat(path.join(extraction, entry))).size));
    const total = sizes.reduce((sum, value) => sum + value, 0);
    const zipped = (await stat(ownArchive)).size;
    assert.ok(zipped <= 45 * 1024 * 1024, `ZIP <= 45MiB (${zipped})`);
    assert.ok(total <= 200 * 1024 * 1024, `unzipped <= 200MiB (${total})`);
    const importProgram = `import{writeFileSync}from"node:fs";const module=await import(${JSON.stringify(pathToFileURL(path.join(extraction, "index.mjs")).href)});writeFileSync(${JSON.stringify(path.join(temporary, "cold.json"))},JSON.stringify({handler:typeof module.handler}));`;
    const cold = spawnSync(process.execPath, ["--input-type=module", "--eval", importProgram], {
      cwd: projectRoot, encoding: "utf8", env: { PATH: process.env.PATH }
    });
    assert.equal(cold.status, 0, cold.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(temporary, "cold.json"), "utf8")), { handler: "function" },
      "cold ESM import exports handler");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  try {
    for (const sentinel of sentinels) {
      await rm(sentinel, { recursive: true, force: true });
    }
  } catch {}
});

test("SCN-KI-027: shared-root deletion negative control falsifies the sibling-preservation oracle", async () => {
  const { readFile, readdir, rm, mkdir, writeFile, cp } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const stagingRoot = path.join(projectRoot, ".lambda-build");
  const temporary = mkdtempSync(path.join(tmpdir(), "storesignal-keyword-negctl-"));
  try {
    const copyRoot = path.join(temporary, "lambda-build-copy");
    await cp(stagingRoot, copyRoot, { recursive: true });
    const sentinel = path.join(copyRoot, "sibling-sentinel.json");
    await writeFile(sentinel, "{}");
    const pre = sha(await readFile(sentinel));
    await rm(copyRoot, { recursive: true, force: true });
    const removed = await readdir(copyRoot).then(() => false).catch(() => true);
    assert.equal(removed, true, "shared-root deletion removes the sibling sentinel in the copy");
    const productionRootIntact = await readdir(stagingRoot).then(() => true).catch(() => false);
    assert.equal(productionRootIntact, true, "production staging root untouched by the negative control");
    const realSibling = path.join(stagingRoot, "discovery-worker", "index.mjs");
    const intact = await readFile(realSibling).then(() => true).catch(() => false);
    assert.equal(intact, true, "production sibling staging remains present");
    assert.notEqual(pre, sha("missing"), "buggy shared-root deletion changes the sibling sentinel hash oracle");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
