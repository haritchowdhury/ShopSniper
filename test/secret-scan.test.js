import assert from "node:assert/strict";
import test from "node:test";
import { scanText } from "../scripts/check-secrets.js";

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
