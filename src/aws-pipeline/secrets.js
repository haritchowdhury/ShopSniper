import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { PipelineContractError } from "./contracts/errors.js";

const googleCredentialsSchema = z.object({
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  project_id: z.string().min(1)
}).strict();

const secretSchema = z.object({
  DATABASE_URL: z.string().min(1),
  GOOGLE_API_KEY: z.string(),
  GOOGLE_SEARCH_ENGINE_ID: z.string(),
  BROWSERLESS_TOKEN: z.string(),
  BROWSERLESS_FALLBACK_TOKEN: z.string(),
  DATAFORSEO_LOGIN: z.string(),
  DATAFORSEO_PASSWORD: z.string(),
  CRUX_API_KEY: z.string(),
  CRUX_BIGQUERY_PROJECT_ID: z.string(),
  GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().min(1)
}).strict();

const caches = new WeakMap();

function drift() {
  throw new PipelineContractError("PIPELINE_CONTRACT_DRIFT");
}

async function fetchAndParse(client, secretId) {
  let response;
  try {
    response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  } catch {
    drift();
  }
  if (typeof response?.SecretString !== "string" || response.SecretBinary != null) drift();
  let raw;
  try {
    raw = JSON.parse(response.SecretString);
  } catch {
    drift();
  }
  const parsed = secretSchema.safeParse(raw);
  if (!parsed.success) drift();
  let googleApplicationCredentials;
  try {
    googleApplicationCredentials = googleCredentialsSchema.parse(
      JSON.parse(parsed.data.GOOGLE_APPLICATION_CREDENTIALS_JSON)
    );
  } catch {
    drift();
  }
  const secret = parsed.data;
  return Object.freeze({
    databaseUrl: secret.DATABASE_URL,
    googleApiKey: secret.GOOGLE_API_KEY,
    googleSearchEngineId: secret.GOOGLE_SEARCH_ENGINE_ID,
    browserlessToken: secret.BROWSERLESS_TOKEN,
    browserlessFallbackToken: secret.BROWSERLESS_FALLBACK_TOKEN,
    dataForSeoLogin: secret.DATAFORSEO_LOGIN,
    dataForSeoPassword: secret.DATAFORSEO_PASSWORD,
    cruxApiKey: secret.CRUX_API_KEY,
    cruxBigQueryProjectId: secret.CRUX_BIGQUERY_PROJECT_ID,
    googleApplicationCredentials: Object.freeze(googleApplicationCredentials)
  });
}

export function loadPipelineSecrets({ client, secretId }) {
  if (!client || typeof client.send !== "function" || typeof secretId !== "string" || !secretId) drift();
  let byId = caches.get(client);
  if (!byId) {
    byId = new Map();
    caches.set(client, byId);
  }
  if (byId.has(secretId)) return byId.get(secretId);
  const pending = fetchAndParse(client, secretId).catch((error) => {
    byId.delete(secretId);
    throw error;
  });
  byId.set(secretId, pending);
  return pending;
}
