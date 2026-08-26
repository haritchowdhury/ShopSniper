import assert from "node:assert/strict";
import test from "node:test";
import { mapSelectionToQueries, validateResearchBackedQueries } from "../src/keyword-intelligence/query-mapper.js";

test("mapSelectionToQueries maps product classifications to site prefixes", () => {
  const items = [
    { itemId: "ksi_a00000000000", keyword: "pickleball paddles", lane: "category_discovery", product: true },
    { itemId: "ksi_b00000000000", keyword: "pickleball paddles", lane: "store_discovery", product: false },
    { itemId: "ksi_c00000000000", keyword: "golf tees", lane: "local_discovery", product: false },
    { itemId: "ksi_d00000000000", keyword: "golf tees", lane: "brand_competitor", product: false },
  ];
  const result = mapSelectionToQueries(items);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, [
    { itemId: "ksi_a00000000000", sequence: "site:myshopify.com/products pickleball paddles" },
    { itemId: "ksi_b00000000000", sequence: "site:myshopify.com pickleball paddles" },
    { itemId: "ksi_c00000000000", sequence: "site:myshopify.com golf tees" },
    { itemId: "ksi_d00000000000", sequence: "site:myshopify.com golf tees" },
  ]);
});

test("mapSelectionToQueries defaults an absent product classification to a store query and rejects duplicates", () => {
  const single = mapSelectionToQueries([{ itemId: "ksi_a00000000000", keyword: "pickleball" }]);
  assert.equal(single.ok, true);
  assert.equal(single.rows[0].sequence, "site:myshopify.com pickleball");
  const dup = mapSelectionToQueries([
    { itemId: "ksi_a00000000000", keyword: "x" },
    { itemId: "ksi_a00000000000", keyword: "x" },
  ]);
  assert.equal(dup.ok, false);
  assert.ok(dup.issues.some((issue) => issue.code === "duplicate_item_id"));
  const bad = mapSelectionToQueries([{ keyword: "no id" }]);
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((issue) => issue.code === "invalid_item_id"));
});

test("validateResearchBackedQueries accepts a valid mapped selection", () => {
  const persisted = ["ksi_a00000000000", "ksi_b00000000000"];
  const rows = [
    { itemId: "ksi_a00000000000", sequence: "site:myshopify.com/products pickleball paddles" },
    { itemId: "ksi_b00000000000", sequence: "site:myshopify.com golf tees" },
  ];
  const result = validateResearchBackedQueries({ rows, persistedItemIds: persisted, sourceKeywords: {} });
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].lane, "category_discovery");
  assert.equal(result.rows[1].lane, "store_discovery");
});

test("validateResearchBackedQueries rejects edited row set (add/delete forbidden by REQ-KI-013)", () => {
  const persisted = ["ksi_a00000000000", "ksi_b00000000000"];
  const added = validateResearchBackedQueries({
    rows: [
      { itemId: "ksi_a00000000000", sequence: "site:myshopify.com/products x" },
      { itemId: "ksi_b00000000000", sequence: "site:myshopify.com/products y" },
      { itemId: "ksi_c00000000000", sequence: "site:myshopify.com/products z" },
    ],
    persistedItemIds: persisted,
  });
  assert.equal(added.ok, false);
  assert.ok(added.issues.some((issue) => issue.code === "item_id_set_mismatch"));
  const deleted = validateResearchBackedQueries({
    rows: [{ itemId: "ksi_a00000000000", sequence: "site:myshopify.com/products x" }],
    persistedItemIds: persisted,
  });
  assert.equal(deleted.ok, false);
  assert.ok(deleted.issues.some((issue) => issue.code === "item_id_set_mismatch"));
});

test("validateResearchBackedQueries allows edit and reorder within the persisted set", () => {
  const persisted = ["ksi_a00000000000", "ksi_b00000000000"];
  const result = validateResearchBackedQueries({
    rows: [
      { itemId: "ksi_b00000000000", sequence: "site:myshopify.com/products edited keyword" },
      { itemId: "ksi_a00000000000", sequence: "site:myshopify.com/products pickleball paddles" },
    ],
    persistedItemIds: persisted,
    sourceKeywords: { "ksi_a00000000000": { keyword: "pickleball paddles", sourceSeeds: ["pickleball"] }, "ksi_b00000000000": { keyword: "edited keyword", sourceSeeds: ["edited"] } },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows.map((row) => row.itemId), ["ksi_b00000000000", "ksi_a00000000000"]);
});

test("validateResearchBackedQueries enforces current bounds, control, emptiness, and duplicate rules", () => {
  const base = { persistedItemIds: ["ksi_a00000000000"], sourceKeywords: {} };
  const cases = [
    { row: { itemId: "ksi_a00000000000", sequence: "site:myshopify.com/products " + "a ".repeat(120) }, code: "query_too_long" },
    { row: { itemId: "ksi_a00000000000", sequence: "site:myshopify.com/products x\u0001y" }, code: "unsupported_control_character" },
    { row: { itemId: "ksi_a00000000000", sequence: "site:myshopify.com/products x" }, code: "duplicate_sequence" },
    { row: { itemId: "ksi_a00000000000", sequence: "   " }, code: "query_empty" },
  ];
  for (const { row, code } of cases) {
    const rows = code === "duplicate_sequence" ? [row, { ...row }] : [row];
    const result = validateResearchBackedQueries({ rows, ...base });
    assert.equal(result.ok, false, `expected rejection for ${code}`);
    assert.ok(result.issues.some((issue) => issue.code === code), `expected issue ${code} got ${JSON.stringify(result.issues)}`);
  }

  for (const sequence of [
    "site:myshopify.com/products \"quoted\"",
    "http://myshopify.com/products x",
    "site:myshopify.com/products " + "x".repeat(170),
    "site:myshopify.com/products " + Array.from({ length: 13 }, () => "x").join(" "),
    "site:myshopify.com/products site:evil.com",
    "site:myshopify.com/products -excluded",
  ]) {
    assert.equal(validateResearchBackedQueries({ rows: [{ itemId: "ksi_a00000000000", sequence }], ...base }).ok, true);
  }
});

test("validateResearchBackedQueries allows edited text independent of source-keyword relevance", () => {
  const result = validateResearchBackedQueries({
    rows: [{ itemId: "ksi_a00000000000", sequence: "site:myshopify.com/products golf accessories" }],
    persistedItemIds: ["ksi_a00000000000"],
    sourceKeywords: { "ksi_a00000000000": { keyword: "pickleball paddles", sourceSeeds: ["pickleball"] } },
    stripTokens: [],
  });
  assert.equal(result.ok, true);
});

test("validateResearchBackedQueries keeps a relevant query sharing a normalized seed token", () => {
  const result = validateResearchBackedQueries({
    rows: [{ itemId: "ksi_a00000000000", sequence: "site:myshopify.com/products golf accessories" }],
    persistedItemIds: ["ksi_a00000000000"],
    sourceKeywords: { "ksi_a00000000000": { keyword: "golf tees", sourceSeeds: ["golf accessories"] } },
    stripTokens: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].sequence, "site:myshopify.com/products golf accessories");
});

test("validateResearchBackedQueries rejects out-of-range row counts", () => {
  const empty = validateResearchBackedQueries({ rows: [], persistedItemIds: [] });
  assert.equal(empty.ok, false);
  assert.ok(empty.issues.some((issue) => issue.code === "rows_length"));
  const tooMany = [];
  for (let i = 0; i < 101; i += 1) {
    tooMany.push({ itemId: `ksi_${i.toString(16).padStart(12, "0")}`, sequence: `site:myshopify.com/products keyword ${i}` });
  }
  const result = validateResearchBackedQueries({ rows: tooMany, persistedItemIds: tooMany.map((row) => row.itemId) });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "rows_length"));
});
