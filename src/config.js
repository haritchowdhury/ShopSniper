import fs from "node:fs";
import path from "node:path";

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function integer(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function configuredPath(value, cwd) {
  return path.resolve(cwd, value);
}

export function loadConfig({ cwd = process.cwd() } = {}) {
  loadDotEnv(path.join(cwd, ".env"));

  const config = {
    port: integer("PORT", 3000, { max: 65535 }),
    host: process.env.HOST || "127.0.0.1",
    inputCsv: configuredPath(process.env.INPUT_CSV || "./data/input.csv", cwd),
    outputCsv: configuredPath(process.env.OUTPUT_CSV || "./data/output.csv", cwd),
    googleApiKey: process.env.GOOGLE_API_KEY || "",
    googleSearchEngineId: process.env.GOOGLE_SEARCH_ENGINE_ID || "",
    browserlessUrl:
      process.env.BROWSERLESS_URL || "https://production-sfo.browserless.io/content",
    browserlessToken: process.env.BROWSERLESS_TOKEN || "",
    browserlessFallbackToken: process.env.BROWSERLESS_FALLBACK_TOKEN || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    googleResultsPerQuery: integer("GOOGLE_RESULTS_PER_QUERY", 10, { max: 10 }),
    maxQueries: integer("MAX_QUERIES", 500, { max: 10000 }),
    maxPagesPerStore: integer("MAX_PAGES_PER_STORE", 5, { max: 20 }),
    storeConcurrency: integer("STORE_CONCURRENCY", 2, { max: 20 }),
    requestTimeoutMs: integer("REQUEST_TIMEOUT_MS", 20000, {
      min: 1000,
      max: 120000
    }),
    qualificationThreshold: integer("QUALIFICATION_THRESHOLD", 45, {
      min: 0,
      max: 100
    }),
    minRelevanceScore: integer("MIN_RELEVANCE_SCORE", 15, {
      min: 0,
      max: 100
    })
  };

  if (config.inputCsv === config.outputCsv) {
    throw new Error("INPUT_CSV and OUTPUT_CSV must point to different files");
  }
  return Object.freeze(config);
}

export function assertRunConfig(config) {
  const missing = [];
  if (!config.googleApiKey) missing.push("GOOGLE_API_KEY");
  if (!config.googleSearchEngineId) missing.push("GOOGLE_SEARCH_ENGINE_ID");
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
}
