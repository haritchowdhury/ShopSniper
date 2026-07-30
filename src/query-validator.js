const REQUIRED_PREFIX = "site:myshopify.com/products ";
const ABSTRACT_ENDINGS = new Set([
  "brand",
  "brands",
  "business",
  "businesses",
  "company",
  "companies",
  "fashion",
  "food",
  "shop",
  "shops",
  "store",
  "stores"
]);
const VAGUE_PHRASES = new Set([
  "baby food",
  "cooking utensils",
  "kitchen utensils"
]);
const INFORMATIONAL = /\b(?:best|guide|ideas|how|recipe|recipes|review|reviews|tips|what|why)\b/i;
const INSTRUCTION_LIKE =
  /\b(?:ignore|disregard|override|execute|system\s+prompt|instructions?|api[_ -]?key|token)\b/i;
const UNSUPPORTED_OPERATOR =
  /(?:^|\s)(?:inurl|intitle|allintitle|filetype|cache|related|link|before|after):|\b(?:AND|OR)\b/i;
const MODIFIERS = new Set([
  "affordable",
  "best",
  "custom",
  "eco",
  "friendly",
  "handmade",
  "luxury",
  "natural",
  "new",
  "organic",
  "premium",
  "sustainable",
  "unique"
]);

const CATEGORY_FAMILIES = [
  {
    category: /\b(?:clothes|clothing|fashion|apparel|streetwear|activewear)\b/i,
    products:
      /\b(?:blazer|blouse|bodysuit|bra|cardigan|coat|corset|dress|hoodie|jacket|jeans|joggers|leggings|lingerie|overshirt|pants|pyjamas|pajamas|shirt|shorts|skirt|socks|suit|sweater|sweatshirt|swimwear|tee|t-shirt|top|trousers|underwear|vest)\b/i
  },
  {
    category: /\bbaby\s*(?:food|foods|feeding)\b/i,
    products:
      /\b(?:bars?|biscuits|broth|cereal|formula|meal|melts|oatmeal|pouch(?:es)?|pudding|puree|purée|puffs|snacks?|teething)\b/i
  },
  {
    category: /\b(?:kitchen\s+utensils?|utensils?|cookware|kitchenware)\b/i,
    products:
      /\b(?:baster|brush|can opener|chopper|colander|cutter|grater|knife|ladle|masher|measuring cups?|peeler|press|rolling pin|scoop|shears|skimmer|spatula|spoons?|strainer|tongs|tool|turner|utensils?|whisk)\b/i
  }
];

export function normalizeProductPhrase(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N} &'’/-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeGeneratedQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function categoryRelevant(shopType, phrase, categoryVocabulary = []) {
  const family = CATEGORY_FAMILIES.find(({ category }) => category.test(shopType));
  if (family) return family.products.test(phrase);

  const phraseTokens = new Set(phrase.split(" ").filter((word) => word.length > 2));
  const vocabularyMatch = categoryVocabulary.some((entry) => {
    const normalized = normalizeProductPhrase(entry);
    if (normalized === phrase || normalized.includes(phrase) || phrase.includes(normalized)) {
      return true;
    }
    const vocabularyTokens = new Set(
      normalized.split(" ").filter((word) => word.length > 2)
    );
    const overlap = [...phraseTokens].filter((word) => vocabularyTokens.has(word)).length;
    return overlap >= 1;
  });
  if (categoryVocabulary.length) return vocabularyMatch;

  const categoryWords = normalizeProductPhrase(shopType)
    .split(" ")
    .filter((word) => word.length > 3);
  return !categoryWords.length || categoryWords.some((word) => phrase.includes(word));
}

export function validateCandidateShape(value) {
  if (!value || typeof value !== "object") return false;
  return (
    ["product_phrase", "product_family", "query", "market_signal", "seasonality",
      "query_generation_reason"].every((key) => typeof value[key] === "string") &&
    Array.isArray(value.source_urls) &&
    value.source_urls.every((url) => typeof url === "string") &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
}

export function validateCandidate(
  candidate,
  shopType,
  {
    seenQueries = new Set(),
    previouslyUsedQueries = new Set(),
    categoryVocabulary = []
  } = {}
) {
  if (!validateCandidateShape(candidate)) {
    return { valid: false, rejectionReason: "invalid_candidate_schema" };
  }

  const rawQuery = normalizeGeneratedQuery(candidate.query);
  const phrase = normalizeProductPhrase(candidate.product_phrase);
  const words = phrase.split(" ").filter(Boolean);
  const normalizedQuery = `${REQUIRED_PREFIX}${phrase}`;

  let rejectionReason = "";
  if (/["“”]/u.test(candidate.query) || /["“”]/u.test(candidate.product_phrase)) {
    rejectionReason = "quoted_query";
  } else if (UNSUPPORTED_OPERATOR.test(rawQuery) || (rawQuery.match(/\bsite:/g) || []).length !== 1) {
    rejectionReason = "unsupported_search_operator";
  } else if (!rawQuery.startsWith(REQUIRED_PREFIX) || rawQuery !== normalizedQuery) {
    rejectionReason = "invalid_query_format";
  } else if (words.length < 2 || words.length > 5) {
    rejectionReason = "invalid_product_phrase_length";
  } else if (INSTRUCTION_LIKE.test(phrase) || INFORMATIONAL.test(phrase)) {
    rejectionReason = "non_product_intent";
  } else if (
    VAGUE_PHRASES.has(phrase) ||
    ABSTRACT_ENDINGS.has(words.at(-1)) ||
    words.every((word) => MODIFIERS.has(word))
  ) {
    rejectionReason = "abstract_product_phrase";
  } else if (!categoryRelevant(shopType, phrase, categoryVocabulary)) {
    rejectionReason = "out_of_category";
  } else if (seenQueries.has(normalizedQuery)) {
    rejectionReason = "duplicate_candidate";
  } else if (
    [...seenQueries].some(
      (existing) =>
        candidateSimilarity(
          phrase,
          existing.replace(/^site:myshopify\.com\/products\s+/i, "")
        ) >= 0.8
    )
  ) {
    rejectionReason = "near_duplicate_candidate";
  } else if (previouslyUsedQueries.has(normalizedQuery)) {
    rejectionReason = "previously_used_query";
  }

  if (rejectionReason) {
    return { valid: false, rejectionReason, query: normalizedQuery, productPhrase: phrase };
  }

  seenQueries.add(normalizedQuery);
  return {
    valid: true,
    rejectionReason: "",
    candidate: {
      ...candidate,
      product_phrase: phrase,
      product_family: normalizeProductPhrase(candidate.product_family) || phrase,
      query: normalizedQuery,
      source_urls: [...new Set(candidate.source_urls)].slice(0, 8)
    }
  };
}

export function validateCandidates(candidates, shopType, options = {}) {
  const seenQueries = options.seenQueries || new Set();
  const accepted = [];
  const rejected = [];
  for (const candidate of candidates) {
    const result = validateCandidate(candidate, shopType, {
      ...options,
      seenQueries
    });
    if (result.valid) accepted.push(result.candidate);
    else rejected.push({ candidate, ...result });
  }
  return { accepted, rejected, seenQueries };
}

export function candidateSimilarity(left, right) {
  const a = new Set(normalizeProductPhrase(left).split(" ").filter(Boolean));
  const b = new Set(normalizeProductPhrase(right).split(" ").filter(Boolean));
  const intersection = [...a].filter((word) => b.has(word)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}
