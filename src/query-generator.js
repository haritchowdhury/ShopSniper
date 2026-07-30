import {
  generateRepairCandidates,
  researchCategory
} from "./category-researcher.js";

const FALLBACK_PHRASES = {
  clothing: [
    "barrel jeans",
    "oversized sweatshirt",
    "running shorts",
    "outdoor overshirt",
    "boho maxi skirt",
    "babydoll top",
    "wrap skirt",
    "palazzo pants",
    "flare leggings",
    "floral corset dress",
    "linen wide leg pants",
    "cropped denim jacket",
    "ribbed knit dress",
    "graphic t-shirt",
    "cargo jogger pants",
    "quilted puffer vest",
    "satin midi skirt",
    "wool blend blazer",
    "high waisted shorts",
    "zip up hoodie",
    "one piece swimwear",
    "cotton polo shirt",
    "pleated tennis skirt",
    "seamless sports bra",
    "relaxed fit cardigan"
  ],
  "baby food": [
    "organic baby puree",
    "fruit puree pouch",
    "vegetable puree pouch",
    "baby oatmeal cereal",
    "infant rice cereal",
    "baby teething biscuits",
    "baby yogurt melts",
    "baby snack puffs",
    "toddler fruit snacks",
    "baby food pouches",
    "plant based baby formula",
    "goat milk baby formula",
    "baby smoothie pouch",
    "toddler meal pouch",
    "baby breakfast pouch",
    "baby chia pudding",
    "freeze dried fruit snacks",
    "baby lentil puree",
    "baby quinoa cereal",
    "baby protein puree",
    "allergen introduction puffs",
    "baby bone broth",
    "toddler oat bars",
    "baby puree multipack",
    "baby cereal variety pack"
  ],
  "kitchen utensils": [
    "silicone cooking utensils",
    "wooden cooking spoons",
    "stainless steel tongs",
    "heat resistant spatula",
    "balloon wire whisk",
    "stainless steel ladle",
    "manual vegetable peeler",
    "box cheese grater",
    "digital measuring cups",
    "nesting measuring spoons",
    "fine mesh strainer",
    "stainless steel colander",
    "potato masher tool",
    "pizza cutter wheel",
    "manual can opener",
    "kitchen utility knife",
    "herb kitchen shears",
    "wooden rolling pin",
    "silicone pastry brush",
    "slotted turner spatula",
    "garlic press tool",
    "vegetable chopper tool",
    "ice cream scoop",
    "pasta serving spoon",
    "fish turner spatula"
  ]
};

function fallbackKey(shopType) {
  if (/\b(?:clothing|clothes|apparel|fashion)\b/i.test(shopType)) return "clothing";
  if (/\bbaby\s*(?:food|foods|feeding)\b/i.test(shopType)) return "baby food";
  if (/\b(?:kitchen\s+utensils?|utensils?|kitchenware)\b/i.test(shopType)) {
    return "kitchen utensils";
  }
  return "";
}

function asFallbackCandidate(phrase) {
  return {
    product_phrase: phrase,
    product_family: phrase.split(" ").at(-1),
    query: `site:myshopify.com/products ${phrase}`,
    market_signal: "Deterministic fallback; no live market evidence",
    source_urls: [],
    seasonality: "evergreen",
    confidence: 0.5,
    query_generation_reason:
      "Fallback catalog phrase used because AI-assisted generation was unavailable"
  };
}

export function deterministicFallbackCandidates(shopType, count = 25) {
  const phrases = FALLBACK_PHRASES[fallbackKey(shopType)] || [];
  return phrases.slice(0, count).map(asFallbackCandidate);
}

export async function generateInitialCandidates(
  category,
  config,
  dependencies = {}
) {
  const research = dependencies.researchCategory || researchCategory;
  try {
    const result = await research(category, config, dependencies);
    return { ...result, mode: "ai", error: "" };
  } catch (error) {
    const candidates = deterministicFallbackCandidates(
      category.shopType,
      config.queryCandidateCount
    );
    if (!candidates.length) throw error;
    return {
      shopType: category.shopType,
      research: {
        summary: "AI-assisted research unavailable; deterministic fallback catalog used.",
        concrete_products: candidates.map((candidate) => candidate.product_phrase),
        growing_products: [],
        evergreen_products: candidates.map((candidate) => candidate.product_phrase),
        product_title_terms: candidates.map((candidate) => candidate.product_phrase),
        shopper_use_cases: [],
        seasonal_considerations: [],
        avoid_terms: [],
        source_urls: [],
        geographic_scope: config.researchGeography
      },
      candidates,
      mode: "fallback",
      error: error instanceof Error ? error.message : String(error)
    };
  }
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
