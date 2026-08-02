import { candidateSimilarity } from "./query-validator.js";

function adjustedScore(probe, selected, selectedHosts) {
  const hosts = probe.uniqueHosts || [];
  const newHosts = hosts.filter((host) => !selectedHosts.has(host)).length;
  const diversityScore = hosts.length ? (newHosts / hosts.length) * 15 : 0;

  let similarityPenalty = 0;
  for (const prior of selected) {
    const similarity = candidateSimilarity(
      probe.candidate.product_phrase,
      prior.candidate.product_phrase
    );
    if (similarity >= 0.8) similarityPenalty = Math.max(similarityPenalty, 12);
    else if (similarity >= 0.5) similarityPenalty = Math.max(similarityPenalty, 6);
    if (
      probe.candidate.product_family &&
      probe.candidate.product_family === prior.candidate.product_family
    ) {
      similarityPenalty = Math.max(similarityPenalty, 5);
    }
  }
  const seasonalCount = selected.filter(
    (prior) => prior.candidate.seasonality === "seasonal"
  ).length;
  const seasonalPenalty =
    probe.candidate.seasonality === "seasonal"
      ? Math.min(12, seasonalCount * 4)
      : 0;
  return Math.max(
    0,
    Math.round(
      (probe.baseScore + diversityScore - similarityPenalty - seasonalPenalty) * 100
    ) / 100
  );
}

export function selectDiverseQueries(probes, count) {
  const remaining = probes.filter((probe) => !probe.rejectionReason);
  const selected = [];
  const selectedHosts = new Set();
  const familyCounts = new Map();
  const selectionRejections = new Map();
  const maxPerFamily = Math.max(1, Math.ceil(count * 0.3));

  while (selected.length < count && remaining.length) {
    let bestIndex = -1;
    let bestScore = -1;
    for (let index = 0; index < remaining.length; index += 1) {
      const family = remaining[index].candidate.product_family || "";
      if ((familyCounts.get(family) || 0) >= maxPerFamily) continue;
      const score = adjustedScore(remaining[index], selected, selectedHosts);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    const [best] = remaining.splice(bestIndex, 1);
    best.queryScore = bestScore;
    selected.push(best);
    const family = best.candidate.product_family || "";
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
    for (const host of best.uniqueHosts) selectedHosts.add(host);
  }

  for (const probe of remaining) {
    const family = probe.candidate.product_family || "";
    if ((familyCounts.get(family) || 0) >= maxPerFamily) {
      selectionRejections.set(
        probe.candidate.query,
        "product_family_concentration"
      );
    }
  }
  return { selected, unselected: remaining, selectionRejections };
}
