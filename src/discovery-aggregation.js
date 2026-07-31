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

function occurrence(candidate) {
  return {
    shopType: candidate.shopType || "",
    businessQualifier: candidate.businessQualifier || "unspecified",
    query: candidate.query || "",
    queryScore: candidate.queryScore ?? null,
    queryGenerationReason: candidate.queryGenerationReason || "",
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
      const key = `${member.shopType || ""}\u0000${member.businessQualifier || "unspecified"}`;
      if (!intents.has(key)) {
        intents.set(key, {
          originalShopType: member.originalShopType || member.shopType || "",
          shopType: member.shopType || "",
          businessQualifier: member.businessQualifier || "unspecified",
          categoryVocabulary: []
        });
      }
      const intent = intents.get(key);
      intent.categoryVocabulary = [...new Set([
        ...intent.categoryVocabulary,
        ...(member.categoryVocabulary || [])
      ])];
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
      categoryIntents: [...intents.values()].sort((a, b) =>
        `${a.shopType}:${a.businessQualifier}`.localeCompare(`${b.shopType}:${b.businessQualifier}`)
      ),
      occurrences: members.map(occurrence).sort((a, b) =>
        `${a.query}:${a.rank}:${a.resultUrl}`.localeCompare(`${b.query}:${b.rank}:${b.resultUrl}`)
      ),
      duplicateCount: Math.max(0, members.length - 1)
    };
  }).sort((a, b) => String(a.stableIdentity).localeCompare(String(b.stableIdentity)));
}
