import fs from "node:fs";
import path from "node:path";

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const externallyConfigured = new Set(Object.keys(process.env));

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
    if (!externallyConfigured.has(key)) process.env[key] = value;
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

function boolean(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (/^(?:1|true|yes|on)$/i.test(raw)) return true;
  if (/^(?:0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig({ cwd = process.cwd() } = {}) {
  loadDotEnv(path.join(cwd, ".env"));

  const config = {
    port: integer("PORT", 3000, { max: 65535 }),
    host: process.env.HOST || "127.0.0.1",
    inputCsv: configuredPath(process.env.INPUT_CSV || "./data/categories.csv", cwd),
    outputCsv: configuredPath(process.env.OUTPUT_CSV || "./data/leads.csv", cwd),
    generatedQueriesCsv: configuredPath(
      process.env.GENERATED_QUERIES_CSV || "./data/generated-queries.csv",
      cwd
    ),
    googleApiKey: process.env.GOOGLE_API_KEY || "",
    googleSearchEngineId: process.env.GOOGLE_SEARCH_ENGINE_ID || "",
    browserlessUrl:
      process.env.BROWSERLESS_URL || "https://production-sfo.browserless.io/content",
    browserlessToken: process.env.BROWSERLESS_TOKEN || "",
    browserlessFallbackToken: process.env.BROWSERLESS_FALLBACK_TOKEN || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    enableAiNormalization: boolean("ENABLE_AI_NORMALIZATION", false),
    queryGenerationModel: process.env.QUERY_GENERATION_MODEL || "gpt-5.6-luna",
    queryReasoningEffort: process.env.QUERY_REASONING_EFFORT || "low",
    queryGenerationTimeoutMs: integer("QUERY_GENERATION_TIMEOUT_MS", 120000, {
      min: 5000,
      max: 300000
    }),
    queryMaxOutputTokens: integer("QUERY_MAX_OUTPUT_TOKENS", 12000, {
      min: 1000,
      max: 50000
    }),
    webSearchContextSize: process.env.WEB_SEARCH_CONTEXT_SIZE || "medium",
    enableWebResearch: boolean("ENABLE_WEB_RESEARCH", true),
    researchGeography: process.env.RESEARCH_GEOGRAPHY || "global English-language market",
    maxResearchSources: integer("MAX_RESEARCH_SOURCES", 8, { max: 20 }),
    generatedQueryCount: integer("GENERATED_QUERY_COUNT", 10, { max: 20 }),
    queryCandidateCount: integer("QUERY_CANDIDATE_COUNT", 25, { max: 40 }),
    queryRepairRounds: integer("QUERY_REPAIR_ROUNDS", 2, { min: 0, max: 5 }),
    queryProbeConcurrency: integer("QUERY_PROBE_CONCURRENCY", 3, { max: 10 }),
    minQueryResults: integer("MIN_QUERY_RESULTS", 5, { min: 1, max: 10 }),
    minQueryUniqueHosts: integer("MIN_QUERY_UNIQUE_HOSTS", 4, {
      min: 1,
      max: 10
    }),
    maxShopTypes: integer("MAX_SHOP_TYPES", 100, { max: 1000 }),
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
  if (
    config.generatedQueriesCsv === config.inputCsv ||
    config.generatedQueriesCsv === config.outputCsv
  ) {
    throw new Error(
      "GENERATED_QUERIES_CSV must differ from INPUT_CSV and OUTPUT_CSV"
    );
  }
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(
    config.queryReasoningEffort
  )) {
    throw new Error(
      "QUERY_REASONING_EFFORT must be one of none, low, medium, high, xhigh, or max"
    );
  }
  if (!["low", "medium", "high"].includes(config.webSearchContextSize)) {
    throw new Error("WEB_SEARCH_CONTEXT_SIZE must be low, medium, or high");
  }
  return Object.freeze(config);
}

export function assertRunConfig(config) {
  const missing = [];
  if (!config.googleApiKey) missing.push("GOOGLE_API_KEY");
  if (!config.googleSearchEngineId) missing.push("GOOGLE_SEARCH_ENGINE_ID");
  if (!config.openaiApiKey) missing.push("OPENAI_API_KEY");
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
}
