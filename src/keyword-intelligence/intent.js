const INTENT_BASE = {
  transactional: 1.0,
  commercial: 0.85,
  navigational: 0.3,
  informational: 0.05,
};

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsAny(text, terms) {
  const low = text.toLowerCase();
  return terms.some((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, "u").test(low));
}

export function commercialIntentScore(keyword, mainIntent, config) {
  const base = INTENT_BASE[(mainIntent || "").toLowerCase()] ?? 0.2;
  let score = base;
  const mods = config.intent.commercialModifiers || [];
  if (mods.length && containsAny(keyword, mods)) {
    score = Math.min(1.0, score + 0.1);
  }
  const info = config.intent.informationalModifiers || [];
  if (info.length && containsAny(keyword, info)) {
    score = Math.max(0.0, score - 0.4);
  }
  return Math.max(0.0, Math.min(1.0, score));
}

export function isInformational(keyword, mainIntent, config) {
  const infoLabels = new Set(config.intent.informationalLabels || []);
  if (infoLabels.has((mainIntent || "").toLowerCase())) {
    return true;
  }
  const infoMods = config.intent.informationalModifiers || [];
  return infoMods.length > 0 && containsAny(keyword, infoMods);
}

export { INTENT_BASE };