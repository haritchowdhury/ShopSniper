import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseCsv, readQueries, stringifyCsv } from "../src/csv.js";
import { OUTPUT_HEADERS } from "../src/output.js";
import { writeOutput } from "../src/output.js";

test("CSV parser handles commas, escaped quotes, and newlines", () => {
  const rows = parseCsv('Search Query,note\r\n"coffee, tea","said ""hello"""\r\n"line\nbreak",ok\r\n');
  assert.deepEqual(rows, [
    ["Search Query", "note"],
    ["coffee, tea", 'said "hello"'],
    ["line\nbreak", "ok"]
  ]);
});

test("G3 CSV fields are appended without shifting legacy columns", () => {
  assert.deepEqual(OUTPUT_HEADERS.slice(0, 25), [
    "shop_type", "generated_query", "query_score", "query_generation_reason",
    "search_query", "google_rank", "google_result_url", "myshopify_domain",
    "final_url", "canonical_url", "resolved_domain", "store_name", "email",
    "email_source_url", "phone", "phone_source_url", "contact_url",
    "social_profiles", "additional_information", "shopify_confidence",
    "relevance_score", "lead_score", "status", "rejection_reason", "error"
  ]);
  assert.equal(OUTPUT_HEADERS[25], "business_qualifier");
  assert.equal(OUTPUT_HEADERS.at(-2), "matched_categories");
  assert.equal(OUTPUT_HEADERS.at(-1), "original_shop_type");
});

test("CSV writer round-trips special values", () => {
  const source = [{ a: "café 👓", b: 'comma, quote " and\nnewline 眼鏡' }];
  const serialized = stringifyCsv(source, ["a", "b"]);
  assert.deepEqual(parseCsv(serialized), [
    ["a", "b"],
    ["café 👓", 'comma, quote " and\nnewline 眼鏡']
  ]);
});

test("CSV writer neutralizes spreadsheet formulas without changing numeric values", () => {
  const dangerous = ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tformula", "\rformula", "  =trimmed"];
  const serialized = stringifyCsv(
    dangerous.map((value, index) => ({ value, numeric: index })),
    ["value", "numeric"]
  );
  const parsed = parseCsv(serialized).slice(1);
  assert.deepEqual(parsed.map(([value]) => value), dangerous.map((value) => `'${value}`));
  assert.deepEqual(parsed.map(([, numeric]) => numeric), dangerous.map((_, index) => String(index)));
});

test("CSV parser rejects unclosed quoted fields", () => {
  assert.throws(() => parseCsv('header\n"unfinished'), /unclosed quoted field/);
});

test("query reader requires the exact header and reports blank rows", async () => {
  const fixture = (name) =>
    fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
  assert.deepEqual(await readQueries(fixture("queries.csv"), 10), {
    queries: ["organic spices", "coffee, tea"],
    blanksSkipped: 1
  });
  await assert.rejects(
    readQueries(fixture("missing-header.csv"), 10),
    /exact header "Search Query"/
  );
});

test("backend CSV export rejects contradictory v2 score states", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "score-state-csv-"));
  const output = path.join(directory, "leads.csv");
  try {
    await assert.rejects(writeOutput(output, [{
      status: "rejected",
      pipeline_version: 2,
      scoring_version: 2,
      lead_score: 72,
      score_breakdown: {
        version: 2,
        components: {
          identity: 14,
          shopifyValidation: 20,
          categoryFit: 24,
          contactEvidence: 14
        },
        total: 72,
        semantics: "deterministic_evidence_rank_not_probability"
      }
    }]), /Lead score state/u);
    await assert.rejects(fs.access(output));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
