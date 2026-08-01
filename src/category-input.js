import fs from "node:fs/promises";
import { parseCsv } from "./csv.js";

const CATEGORY_ALIASES = new Map([
  ["babyfood", "baby food"],
  ["baby foods", "baby food"],
  ["utensils", "kitchen utensils"],
  ["kitchen utensil", "kitchen utensils"],
  ["clothes", "clothing"]
]);

const BUSINESS_QUALIFIERS = new Map([
  ["brand", "brand"],
  ["brands", "brand"],
  ["retailer", "retailer"],
  ["retailers", "retailer"]
]);

const INSTRUCTION_LIKE =
  /\b(?:ignore|disregard|override|reveal|execute|system\s+prompt|developer\s+message|assistant\s+message|follow\s+these\s+instructions|api[_ -]?key|bearer\s+token)\b/i;

export function normalizeShopType(value) {
  if (typeof value !== "string") {
    throw new Error("Shop type must be text");
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Shop type contains unsupported control characters");
  }

  const originalShopType = value.trim().replace(/\s+/gu, " ");
  if (!originalShopType) throw new Error("Shop type is blank");
  if (originalShopType.length > 80) {
    throw new Error("Shop type exceeds the 80-character limit");
  }
  if (INSTRUCTION_LIKE.test(originalShopType) || /[<>{}`;$]/u.test(originalShopType)) {
    throw new Error("Shop type looks like instructions rather than a category");
  }
  if (!/^[\p{L}\p{N} &'’()/-]+$/u.test(originalShopType)) {
    throw new Error("Shop type contains unsupported characters");
  }

  const normalized = originalShopType.toLocaleLowerCase("en-US");
  const qualifierMatch = normalized.match(/\s+(brand|brands|retailer|retailers)$/u);
  const businessQualifier = qualifierMatch
    ? BUSINESS_QUALIFIERS.get(qualifierMatch[1])
    : "unspecified";
  const comparable = qualifierMatch
    ? normalized.slice(0, qualifierMatch.index).trim()
    : normalized;
  if (!comparable) throw new Error("Shop type must include a product category");
  return {
    originalShopType,
    shopType: CATEGORY_ALIASES.get(comparable) || comparable,
    businessQualifier
  };
}

export function toCategoryIntent(category) {
  if (!category || typeof category !== "object") {
    throw new Error("Category intent must be an object");
  }
  return {
    originalShopType: typeof category.originalShopType === "string"
      ? category.originalShopType
      : "",
    shopType: typeof category.shopType === "string" ? category.shopType : "",
    businessQualifier: category.businessQualifier || "unspecified"
  };
}

function normalizedExactInput(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ");
}

export function categoryIntentKey(category) {
  const intent = toCategoryIntent(category);
  return JSON.stringify([
    normalizedExactInput(intent.originalShopType),
    normalizedExactInput(intent.shopType).toLocaleLowerCase("en-US"),
    normalizedExactInput(intent.businessQualifier || "unspecified").toLocaleLowerCase("en-US")
  ]);
}

export function compareCategoryIntents(left, right) {
  return categoryIntentKey(left).localeCompare(categoryIntentKey(right));
}

export function normalizeShopTypes(values, maxShopTypes = 100) {
  if (!Array.isArray(values)) {
    throw new Error("shopTypes must be an array");
  }
  if (values.length < 1) {
    throw new Error("shopTypes must contain at least one category");
  }
  if (values.length > maxShopTypes) {
    throw new Error(`shopTypes must contain at most ${maxShopTypes} categories`);
  }

  const categories = [];
  const seen = new Set();
  const invalid = [];
  for (const [index, value] of values.entries()) {
    try {
      const category = normalizeShopType(value);
      const key = categoryIntentKey(category);
      if (seen.has(key)) continue;
      seen.add(key);
      categories.push(category);
    } catch (error) {
      invalid.push({
        index,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (invalid.length) {
    const error = new Error("One or more shop types are invalid");
    error.validationDetails = invalid;
    throw error;
  }
  if (!categories.length) {
    throw new Error("shopTypes must contain at least one category");
  }
  return categories;
}

export async function readCategories(filePath, maxShopTypes = 100) {
  const rows = parseCsv(await fs.readFile(filePath, "utf8"));
  if (!rows.length) throw new Error("Input CSV is empty");

  const headers = rows[0].map((header) => header.trim());
  const categoryIndex = headers.indexOf("Shop Type");
  if (categoryIndex === -1) {
    throw new Error('Input CSV must contain the exact header "Shop Type"');
  }

  const categories = [];
  const invalid = [];
  let blanksSkipped = 0;
  const seen = new Set();

  for (const [offset, row] of rows.slice(1).entries()) {
    const rawValue = row[categoryIndex] || "";
    if (!rawValue.trim()) {
      blanksSkipped += 1;
      continue;
    }
    try {
      const category = normalizeShopType(rawValue);
      const key = categoryIntentKey(category);
      if (seen.has(key)) continue;
      seen.add(key);
      categories.push(category);
    } catch (error) {
      invalid.push({
        row: offset + 2,
        originalShopType: rawValue.trim().slice(0, 80),
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (categories.length > maxShopTypes) {
      throw new Error(`Input exceeds MAX_SHOP_TYPES (${maxShopTypes})`);
    }
  }

  if (!categories.length && !invalid.length) {
    throw new Error("Input CSV contains no shop types");
  }
  return { categories, invalid, blanksSkipped };
}
