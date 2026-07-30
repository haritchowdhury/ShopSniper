import fs from "node:fs/promises";
import { parseCsv } from "./csv.js";

const CATEGORY_ALIASES = new Map([
  ["babyfood", "baby food"],
  ["baby foods", "baby food"],
  ["utensils", "kitchen utensils"],
  ["kitchen utensil", "kitchen utensils"],
  ["clothes", "clothing"],
  ["clothing brand", "clothing"],
  ["clothing brands", "clothing"]
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

  const comparable = originalShopType
    .toLocaleLowerCase("en-US")
    .replace(/\s+brands?$/u, "")
    .trim();
  return {
    originalShopType,
    shopType: CATEGORY_ALIASES.get(comparable) || comparable
  };
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
      if (seen.has(category.shopType)) continue;
      seen.add(category.shopType);
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
