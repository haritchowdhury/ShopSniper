import { categoryIntentKey, compareCategoryIntents } from "./category-input.js";
import { canonicalJson } from "./aws-pipeline/core/canonical.js";
import { parseRunStoreCandidate } from "./shop-persistence-contract.js";

function normalizedAliases(candidate) {
  return [...new Set([
    candidate.stableIdentity,
    candidate.myshopifyDomain,
    candidate.resolvedDomain,
    ...(candidate.allowedHostnames || [])
  ].filter(Boolean).map((value) => String(value).toLowerCase()))];
}

function compareCandidates(left, right) {
  const leftUsable = left.initialFetch?.assessment?.usable ? 1 : 0;
  const rightUsable = right.initialFetch?.assessment?.usable ? 1 : 0;
  return rightUsable - leftUsable ||
    Number(right.identityConfidence || 0) - Number(left.identityConfidence || 0) ||
    Number(right.queryScore || 0) - Number(left.queryScore || 0) ||
    Number(left.rank || Number.MAX_SAFE_INTEGER) - Number(right.rank || Number.MAX_SAFE_INTEGER) ||
    String(left.url || "").localeCompare(String(right.url || ""));
}

function sortedStrings(values) {
  return [...new Set((values || []).filter(Boolean).map(String))].sort();
}

function intentOf(candidate) {
  const intent = candidate.categoryIntent || candidate;
  return {
    originalShopType: intent.originalShopType || "",
    shopType: intent.shopType || "",
    businessQualifier: intent.businessQualifier || "unspecified"
  };
}

function occurrence(candidate) {
  const categoryIntent = intentOf(candidate);
  return {
    categoryIntent,
    ...categoryIntent,
    query: candidate.query || "",
    queryScore: candidate.queryScore ?? null,
    queryGenerationReason: candidate.queryGenerationReason || "",
    querySourceUrls: sortedStrings(candidate.querySourceUrls),
    categoryVocabulary: sortedStrings(candidate.categoryVocabulary),
    rank: candidate.rank ?? null,
    resultUrl: candidate.url || "",
    finalUrl: candidate.finalUrl || "",
    resolvedDomain: candidate.resolvedDomain || "",
    myshopifyDomain: candidate.myshopifyDomain || ""
  };
}

export function mergeDiscoveryCandidates(candidates) {
  const parents = candidates.map((_, index) => index);
  const find = (index) => parents[index] === index
    ? index
    : (parents[index] = find(parents[index]));
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parents[Math.max(a, b)] = Math.min(a, b);
  };
  const aliasOwners = new Map();
  candidates.forEach((candidate, index) => {
    for (const alias of normalizedAliases(candidate)) {
      if (aliasOwners.has(alias)) union(index, aliasOwners.get(alias));
      else aliasOwners.set(alias, index);
    }
  });

  const clusters = new Map();
  candidates.forEach((candidate, index) => {
    const root = find(index);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(candidate);
  });

  return [...clusters.values()].map((members) => {
    const ranked = [...members].sort(compareCandidates);
    const representative = ranked[0];
    const intents = new Map();
    for (const member of members) {
      const memberIntent = intentOf(member);
      const key = categoryIntentKey(memberIntent);
      if (!intents.has(key)) {
        intents.set(key, {
          ...memberIntent,
          categoryVocabulary: []
        });
      }
      const intent = intents.get(key);
      intent.categoryVocabulary = sortedStrings([
        ...intent.categoryVocabulary,
        ...(member.categoryVocabulary || [])
      ]);
    }
    const aliases = [...new Set(members.flatMap(normalizedAliases))].sort();
    const myshopify = aliases.filter((value) => value.endsWith(".myshopify.com")).sort()[0];
    const stableIdentity = myshopify || representative.stableIdentity || aliases[0];
    return {
      ...representative,
      stableIdentity,
      myshopifyDomain: myshopify || representative.myshopifyDomain || "",
      allowedHostnames: aliases,
      identityEvidence: {
        ...(representative.identityEvidence || {}),
        stableHostname: stableIdentity,
        observedHostnames: aliases,
        mergedOccurrenceCount: members.length,
        confidence: representative.identityConfidence || 0
      },
      categoryIntents: [...intents.values()].sort(compareCategoryIntents),
      occurrences: members.map(occurrence).sort((a, b) =>
        `${a.query}:${a.rank}:${a.resultUrl}:${categoryIntentKey(a)}`.localeCompare(
          `${b.query}:${b.rank}:${b.resultUrl}:${categoryIntentKey(b)}`
        )
      ),
      duplicateCount: Math.max(0, members.length - 1)
    };
  }).sort((a, b) => String(a.stableIdentity).localeCompare(String(b.stableIdentity)));
}

function payloadRank(payload) {
  const assessments = payload.assessments || [];
  return {
    accepted: assessments.some((item) => item.accepted) ? 1 : 0,
    valid: assessments.some((item) => item.valid) ? 1 : 0,
    relevance: Math.max(0, ...assessments.map((item) => Number(item.relevanceScore || 0))),
    confidence: Math.max(0, ...assessments.map((item) => Number(item.shopifyConfidence || 0)))
  };
}

function comparePayloads(left, right) {
  const a = payloadRank(left);
  const b = payloadRank(right);
  return b.accepted - a.accepted || b.valid - a.valid || b.relevance - a.relevance ||
    b.confidence - a.confidence || canonicalJson(left).localeCompare(canonicalJson(right));
}

function uniqueCanonical(values) {
  const byBytes = new Map(values.map((value) => [canonicalJson(value), value]));
  return [...byBytes.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

export function mergeRunStoreCandidatePayloads(values) {
  const payloads = values.map(parseRunStoreCandidate);
  const parents = payloads.map((_, index) => index);
  const find = (index) => parents[index] === index ? index : (parents[index] = find(parents[index]));
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parents[Math.max(a, b)] = Math.min(a, b);
  };
  const owners = new Map();
  payloads.forEach((payload, index) => {
    for (const alias of normalizedAliases(payload)) {
      if (owners.has(alias)) union(index, owners.get(alias));
      else owners.set(alias, index);
    }
  });
  const clusters = new Map();
  payloads.forEach((payload, index) => {
    const root = find(index);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(payload);
  });
  return [...clusters.values()].map((members) => {
    const representative = [...members].sort(comparePayloads)[0];
    const aliases = sortedStrings(members.flatMap(normalizedAliases));
    const myshopifyDomain = aliases.filter((alias) => alias.endsWith(".myshopify.com"))[0] || "";
    const stableIdentity = myshopifyDomain || representative.stableIdentity;
    const intents = new Map();
    for (const intent of members.flatMap((payload) => payload.categoryIntents || [])) {
      const key = categoryIntentKey(intent);
      const current = intents.get(key) || { ...intent, categoryVocabulary: [] };
      current.categoryVocabulary = sortedStrings([
        ...current.categoryVocabulary, ...(intent.categoryVocabulary || [])
      ]);
      intents.set(key, current);
    }
    const occurrences = uniqueCanonical(members.flatMap((payload) => payload.occurrences || []));
    const assessments = uniqueCanonical(members.flatMap((payload) => payload.assessments || []));
    return parseRunStoreCandidate({
      ...representative,
      stableIdentity,
      myshopifyDomain: myshopifyDomain || representative.myshopifyDomain,
      allowedHostnames: aliases,
      identityEvidence: {
        ...representative.identityEvidence,
        stableHostname: stableIdentity,
        observedHostnames: aliases,
        mergedOccurrenceCount: occurrences.length
      },
      categoryIntents: [...intents.values()].sort(compareCategoryIntents),
      occurrences,
      assessments,
      duplicateCount: Math.max(0, occurrences.length - 1)
    });
  }).sort((left, right) => left.stableIdentity.localeCompare(right.stableIdentity));
}
