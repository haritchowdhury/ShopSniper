import {
  TOKEN_ALIASES,
  compactSignature,
  singularPluralAlias,
  tokenize,
} from "./dedup.js";

export const LEAD_FINDING_RETAILER_ALIASES = Object.freeze(["wallmart", "amazom"]);

export const LEAD_FINDING_RETAILER_MATCH = Object.freeze({
  maxEditDistance: 1,
  minEditDistanceLength: 6,
  minCompactSubstringLength: 7,
});

function normalizeToken(token) {
  return TOKEN_ALIASES[token] || singularPluralAlias(token);
}

function orderedNormalizedTokens(keyword, stripTokens) {
  return tokenize(keyword, stripTokens).map(normalizeToken);
}

function retailerForms(retailerTokens) {
  const forms = new Set();
  for (const token of retailerTokens || []) {
    const raw = String(token || "").toLowerCase();
    if (!raw) continue;
    forms.add(raw);
    forms.add(normalizeToken(raw));
  }
  for (const alias of LEAD_FINDING_RETAILER_ALIASES) forms.add(alias);
  return forms;
}

function compactCandidates(tokens) {
  const candidates = [];
  for (let i = 0; i < tokens.length; i++) {
    candidates.push(tokens[i]);
    if (i + 1 < tokens.length) candidates.push(`${tokens[i]}${tokens[i + 1]}`);
  }
  return candidates;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let previous = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + cost);
      previous = saved;
    }
  }
  return row[b.length];
}

function hasEditDistanceHit(candidate, forms, { maxEditDistance, minEditDistanceLength }) {
  if (candidate.length < minEditDistanceLength) return false;
  for (const form of forms) {
    if (form.length < minEditDistanceLength) continue;
    if (Math.abs(candidate.length - form.length) > maxEditDistance) continue;
    if (levenshtein(candidate, form) <= maxEditDistance) return true;
  }
  return false;
}

export function keywordMatchesRetailer(keyword, retailerTokens, stripTokens = []) {
  const forms = retailerForms(retailerTokens);
  if (!forms.size) return false;
  const tokens = orderedNormalizedTokens(keyword, stripTokens);
  const candidates = compactCandidates(tokens);
  for (const candidate of candidates) {
    if (forms.has(candidate)) return true;
  }
  const compact = compactSignature(String(keyword || ""));
  const { minCompactSubstringLength, maxEditDistance, minEditDistanceLength } = LEAD_FINDING_RETAILER_MATCH;
  for (const form of forms) {
    if (form.length >= minCompactSubstringLength && compact.includes(form)) return true;
  }
  for (const candidate of candidates) {
    if (hasEditDistanceHit(candidate, forms, { maxEditDistance, minEditDistanceLength })) return true;
  }
  return false;
}
