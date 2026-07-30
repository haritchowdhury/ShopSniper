import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseCsv, readQueries, stringifyCsv } from "../src/csv.js";

test("CSV parser handles commas, escaped quotes, and newlines", () => {
  const rows = parseCsv('Search Query,note\r\n"coffee, tea","said ""hello"""\r\n"line\nbreak",ok\r\n');
  assert.deepEqual(rows, [
    ["Search Query", "note"],
    ["coffee, tea", 'said "hello"'],
    ["line\nbreak", "ok"]
  ]);
});

test("CSV writer round-trips special values", () => {
  const source = [{ a: "plain", b: 'comma, quote " and\nnewline' }];
  const serialized = stringifyCsv(source, ["a", "b"]);
  assert.deepEqual(parseCsv(serialized), [
    ["a", "b"],
    ["plain", 'comma, quote " and\nnewline']
  ]);
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
