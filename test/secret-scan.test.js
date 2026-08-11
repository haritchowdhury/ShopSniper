import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  isExcludedRepositoryPath,
  listRepositoryFiles,
  REPOSITORY_ROOT,
  scanRepository,
  scanText
} from "../scripts/check-secrets.js";

test("secret scan reports pattern metadata without returning matched values", () => {
  const secret = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
  const findings = scanText(`apiKey: "${secret}"`, "fixture.js");
  assert.ok(findings.length >= 1);
  assert.deepEqual(Object.keys(findings[0]).sort(), ["file", "line", "pattern"]);
  assert.doesNotMatch(JSON.stringify(findings), /abcdefghijklmnopqrstuvwxyz/u);
});

test("secret scan permits documented placeholders", () => {
  assert.deepEqual(
    scanText('password="PASSWORD"\napiKey="test-only-key"', ".env.example"),
    []
  );
});

test("repository scope covers root, backend, frontend, and similar workflow names", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const relativeFiles = [
    `.secret-scan-root-${suffix}.js`,
    `email_scraper/test/.secret-scan-backend-${suffix}.js`,
    `frontend/test/.secret-scan-frontend-${suffix}.ts`,
    `email_scraper/test/fixtures/workflow-similar-${suffix}/My workflow 3.json`
  ];
  const similarDirectory = path.join(
    REPOSITORY_ROOT,
    `email_scraper/test/fixtures/workflow-similar-${suffix}`
  );
  const secret = ["sk", "controlledabcdefghijklmnopqrstuvwxyz123456"].join("-");
  try {
    await fs.mkdir(similarDirectory, { recursive: true });
    await Promise.all(relativeFiles.map(async (file) => {
      const absolute = path.join(REPOSITORY_ROOT, file);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, `apiKey: "${secret}"\n`, "utf8");
    }));

    const findings = scanRepository();
    for (const file of relativeFiles) {
      assert.equal(
        findings.some((finding) => finding.file === file),
        true,
        file
      );
    }
    assert.doesNotMatch(JSON.stringify(findings), /controlledabcdefghijklmnopqrstuvwxyz/u);
  } finally {
    await Promise.all(relativeFiles.slice(0, 3).map((file) =>
      fs.rm(path.join(REPOSITORY_ROOT, file), { force: true })));
    await fs.rm(similarDirectory, { recursive: true, force: true });
  }
});

test("scope excludes only exact local secrets/workflows and build dependencies", () => {
  const files = listRepositoryFiles();
  for (const excluded of [
    ".env",
    "email_scraper/.env",
    "frontend/.env.local",
    "email_scraper/My workflow 3.json",
    "email_scraper/My workflow 4.json"
  ]) {
    assert.equal(files.includes(excluded), false, excluded);
    assert.equal(isExcludedRepositoryPath(excluded), true, excluded);
  }
  for (const included of [
    "email_scraper/docs/history/FINAL_PIPELINE_QUALITY_GAPS_REMEDIATION_PLAN.md",
    "contracts/lead-score-state-v2.fixtures.json",
    "email_scraper/.env.example",
    "email_scraper/scripts/check-secrets.js",
    "email_scraper/test/fixtures/providers/google/README.md",
    "frontend/lib/api-validation.ts"
  ]) {
    assert.equal(files.includes(included), true, included);
    assert.equal(isExcludedRepositoryPath(included), false, included);
  }
  assert.equal(
    isExcludedRepositoryPath("email_scraper/test/fixtures/My workflow 3.json"),
    false
  );
});
