import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LAMBDA_HANDLERS, REQUIRED_PRISMA_ENGINE } from "../scripts/build-lambda.js";

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

for (const handlerName of LAMBDA_HANDLERS) {
  test(`${handlerName} imports without work and fails closed on invocation`, () => {
    const handlerUrl = pathToFileURL(path.join(projectRoot, "src", "aws-pipeline", "handlers", `${handlerName}.js`)).href;
    const temporary = mkdtempSync(path.join(tmpdir(), "storesignal-handler-test-"));
    const resultPath = path.join(temporary, "result.json");
    try {
      const program = `import{writeFileSync}from"node:fs";const module=await import(${JSON.stringify(handlerUrl)});let invoked;try{await module.handler();invoked="resolved"}catch(error){invoked=error.message}writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({imported:true,invoked}));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
        cwd: projectRoot,
        encoding: "utf8",
        env: { PATH: process.env.PATH }
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), {
        imported: true,
        invoked: "PIPELINE_HANDLER_NOT_IMPLEMENTED"
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
