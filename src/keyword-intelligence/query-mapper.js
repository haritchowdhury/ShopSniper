import { tokenize } from "./dedup.js";

const CATEGORY_PREFIX = "site:myshopify.com/products ";
const STORE_PREFIX = "site:myshopify.com ";
const MAX_ROWS = 100;
const MAX_QUERY_LENGTH = 200;
const MAX_PHRASE_LENGTH = 160;
const MAX_WORDS = 12;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const QUOTE_RE = /["“”']/u;
const OPERATOR_RE = /\b(?:AND|OR|NOT)\b|\bsite:/u;
const COLON_RE = /:/u;
const UNARY_MINUS_RE = /(^|\s)-[^\s]/u;

function normalizePhrase(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function supportedPrefix(sequence) {
  if (sequence.startsWith(CATEGORY_PREFIX)) return { prefix: CATEGORY_PREFIX, phrase: sequence.slice(CATEGORY_PREFIX.length) };
  if (sequence.startsWith(STORE_PREFIX)) return { prefix: STORE_PREFIX, phrase: sequence.slice(STORE_PREFIX.length) };
  return null;
}

function countCodePoints(value) {
  return [...value].length;
}

export function mapSelectionToQueries(items) {
  if (!Array.isArray(items)) {
    return { ok: false, error: "selection must be an array", issues: [{ field: "items", code: "items_not_array" }] };
  }
  const rows = [];
  const seenIds = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object" || typeof item.itemId !== "string") {
      return { ok: false, error: "invalid selection item", issues: [{ field: `items[${i}].itemId`, code: "invalid_item_id" }] };
    }
    if (seenIds.has(item.itemId)) {
      return { ok: false, error: "duplicate selection item", issues: [{ field: `items[${i}].itemId`, code: "duplicate_item_id" }] };
    }
    seenIds.add(item.itemId);
    const keyword = typeof item.keyword === "string" ? item.keyword : "";
    const lane = item.lane ?? "category_discovery";
    const sequence = lane === "category_discovery" ? `${CATEGORY_PREFIX}${keyword}` : `${STORE_PREFIX}${keyword}`;
    rows.push({ itemId: item.itemId, sequence });
  }
  return { ok: true, rows };
}

export function validateResearchBackedQueries({ rows, persistedItemIds, sourceKeywords = {}, stripTokens = [] }) {
  const issues = [];
  if (!Array.isArray(rows)) {
    return { ok: false, error: "rows must be an array", issues: [{ field: "rows", code: "rows_not_array" }] };
  }
  if (rows.length < 1 || rows.length > MAX_ROWS) {
    issues.push({ field: "rows", code: "rows_length", length: rows.length });
  }
  const persisted = new Set(Array.isArray(persistedItemIds) ? persistedItemIds : []);
  const presentIds = new Set();
  const seenSequences = new Set();
  const normalized = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") {
      issues.push({ field: `rows[${i}]`, code: "row_not_object" });
      continue;
    }
    if (typeof row.itemId !== "string") {
      issues.push({ field: `rows[${i}].itemId`, code: "invalid_item_id" });
      continue;
    }
    presentIds.add(row.itemId);
    if (typeof row.sequence !== "string") {
      issues.push({ field: `rows[${i}].sequence`, code: "sequence_not_text" });
      continue;
    }
    const sequence = normalizePhrase(row.sequence);
    if (countCodePoints(sequence) > MAX_QUERY_LENGTH) {
      issues.push({ field: `rows[${i}].sequence`, code: "query_too_long" });
      continue;
    }
    if (CONTROL_RE.test(row.sequence)) {
      issues.push({ field: `rows[${i}].sequence`, code: "unsupported_control_character" });
      continue;
    }
    if (QUOTE_RE.test(row.sequence)) {
      issues.push({ field: `rows[${i}].sequence`, code: "quoted_query" });
      continue;
    }
    if (seenSequences.has(sequence)) {
      issues.push({ field: `rows[${i}].sequence`, code: "duplicate_sequence" });
      continue;
    }
    seenSequences.add(sequence);
    const prefix = supportedPrefix(sequence);
    if (!prefix) {
      issues.push({ field: `rows[${i}].sequence`, code: "invalid_query_format" });
      continue;
    }
    const { phrase } = prefix;
    if (countCodePoints(phrase) > MAX_PHRASE_LENGTH) {
      issues.push({ field: `rows[${i}].sequence`, code: "phrase_too_long" });
      continue;
    }
    const tokens = phrase.toLowerCase().match(/[a-z0-9]+/gu) || [];
    if (tokens.length < 1 || tokens.length > MAX_WORDS) {
      issues.push({ field: `rows[${i}].sequence`, code: "phrase_word_count" });
      continue;
    }
    const remainder = sequence.slice(prefix.prefix.length);
    if (COLON_RE.test(remainder) || OPERATOR_RE.test(remainder) || UNARY_MINUS_RE.test(remainder)) {
      issues.push({ field: `rows[${i}].sequence`, code: "unsupported_search_operator" });
      continue;
    }
    const source = sourceKeywords[row.itemId] || null;
    const relevance = isRelevant(sequence, source, stripTokens);
    if (source && !relevance.valid) {
      issues.push({ field: `rows[${i}].sequence`, code: "query_not_relevant" });
      continue;
    }
    normalized.push({ itemId: row.itemId, sequence, phrase, lane: prefix.prefix === CATEGORY_PREFIX ? "category_discovery" : "store_discovery" });
  }
  const missingIds = [...persisted].filter((id) => !presentIds.has(id));
  const extraIds = [...presentIds].filter((id) => !persisted.has(id));
  if (missingIds.length || extraIds.length) {
    issues.push({ field: "rows", code: "item_id_set_mismatch", missingIds, extraIds });
  }
  if (issues.length) {
    return { ok: false, error: "invalid research-backed query review", issues };
  }
  return { ok: true, rows: normalized };
}

function isRelevant(query, source, stripTokens) {
  if (!source || typeof source !== "object") return { valid: true };
  const phrase = normalizePhrase(query).replace(/^site:myshopify\.com(?:\/products)?\s+/u, "");
  if (!phrase) return { valid: false };
  const queryTokens = new Set(tokenize(phrase, stripTokens));
  if (!queryTokens.size) return { valid: false };
  const allowed = new Set();
  for (const token of tokenize(source.keyword ?? "", stripTokens)) allowed.add(token);
  for (const seed of source.sourceSeeds ?? []) {
    for (const token of tokenize(seed, stripTokens)) allowed.add(token);
  }
  if (!allowed.size) return { valid: true };
  for (const token of queryTokens) {
    if (allowed.has(token)) return { valid: true };
  }
  return { valid: false };
}