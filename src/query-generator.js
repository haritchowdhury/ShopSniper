import {
  generateRepairCandidates,
  researchCategory
} from "./category-researcher.js";

export async function generateInitialCandidates(
  category,
  config,
  dependencies = {}
) {
  const research = dependencies.researchCategory || researchCategory;
  const result = await research(category, config, dependencies);
  return { ...result, mode: "ai", error: "" };
}

export async function generateRepairs(
  category,
  research,
  failures,
  existingQueries,
  count,
  config,
  dependencies = {}
) {
  const generator = dependencies.generateRepairCandidates || generateRepairCandidates;
  try {
    return await generator(
      category,
      research,
      failures,
      existingQueries,
      count,
      config,
      dependencies
    );
  } catch (error) {
    const existing = new Set(existingQueries);
    const phrases = [];
    const synonym = new Map([
      ["trousers", "pants"],
      ["sweatshirt", "hoodie"],
      ["spatula", "turner"],
      ["puree", "pouch"],
      ["purée", "pouch"]
    ]);
    for (const failure of failures) {
      const phrase = String(failure.query || "")
        .replace(/^site:myshopify\.com\/products\s+/i, "")
        .trim();
      const words = phrase.split(/\s+/).filter(Boolean);
      if (words.length > 2) phrases.push(words.slice(1).join(" "));
      const replacement = synonym.get(words.at(-1));
      if (replacement) phrases.push([...words.slice(0, -1), replacement].join(" "));
      if (words.length >= 2) {
        const last = words.at(-1);
        phrases.push(
          [...words.slice(0, -1), last.endsWith("s") ? last.slice(0, -1) : `${last}s`]
            .join(" ")
        );
      }
    }
    const candidates = [...new Set(phrases)]
      .filter((phrase) => phrase && !existing.has(`site:myshopify.com/products ${phrase}`))
      .slice(0, count)
      .map((phrase) => ({
        product_phrase: phrase,
        product_family: phrase.split(" ").at(-1),
        query: `site:myshopify.com/products ${phrase}`,
        market_signal: "Deterministic repair based on the existing research set",
        source_urls: research.source_urls || [],
        seasonality: "mixed",
        confidence: 0.4,
        query_generation_reason:
          "Simplified wording or a catalog synonym was used after a weak probe"
      }));
    if (!candidates.length) throw error;
    return candidates;
  }
}
