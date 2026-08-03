import { z } from "zod";
import { ENRICHMENT_ERROR_CODES, cruxError } from "../errors.js";
import {
  CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION,
  validateCruxDatasetMonth
} from "./bigquery-request.js";

const decimalInteger = z.string().regex(/^\d+$/u);
const tableListSchema = z.object({
  kind: z.literal("bigquery#tableList"),
  totalItems: z.number().int().nonnegative(),
  nextPageToken: z.string().min(1).optional(),
  tables: z.array(z.object({
    kind: z.literal("bigquery#table"),
    tableReference: z.object({
      projectId: z.string(),
      datasetId: z.string(),
      tableId: z.string()
    }).passthrough(),
    type: z.string()
  }).passthrough())
}).passthrough();
const querySchema = z.object({
  kind: z.literal("bigquery#queryResponse"),
  schema: z.object({
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      mode: z.string()
    }).strict())
  }).strict(),
  totalRows: decimalInteger,
  rows: z.array(z.object({
    f: z.array(z.object({ v: z.string().nullable() }).strict())
  }).strict()).optional(),
  totalBytesProcessed: decimalInteger,
  totalBytesBilled: decimalInteger.optional(),
  jobComplete: z.boolean(),
  cacheHit: z.boolean().optional(),
  pageToken: z.string().min(1).optional()
}).passthrough();
const dryRunSchema = z.object({
  kind: z.literal("bigquery#queryResponse"),
  schema: z.object({
    fields: z.array(z.object({
      name: z.string(), type: z.string(), mode: z.string()
    }).strict())
  }).strict(),
  totalBytesProcessed: decimalInteger,
  jobComplete: z.boolean(),
  pageToken: z.string().min(1).optional()
}).passthrough();
const payloadSchema = z.object({
  origin: z.string(),
  dataset_month: z.string(),
  popularity_rank: z.number().int().positive(),
  phone_density: z.number().finite().min(0).max(1),
  desktop_density: z.number().finite().min(0).max(1),
  tablet_density: z.number().finite().min(0).max(1)
}).strict();

function mismatch() {
  throw cruxError(
    ENRICHMENT_ERROR_CODES.contractMismatch,
    "CrUX BigQuery response did not match the captured contract",
    CRUX_BIGQUERY_RESPONSE_CONTRACT_VERSION
  );
}

function decode(body) {
  try {
    return typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    mismatch();
  }
}

function exactPayloadSchema(schema) {
  return schema.fields.length === 1 &&
    schema.fields[0].name === "payload" &&
    schema.fields[0].type === "STRING" &&
    schema.fields[0].mode === "NULLABLE";
}

export function parseCruxTableList(body) {
  const parsed = tableListSchema.safeParse(decode(body));
  if (!parsed.success) mismatch();
  const value = parsed.data;
  if (value.nextPageToken || value.totalItems !== value.tables.length) mismatch();
  const candidates = value.tables.filter((table) =>
    table.type === "TABLE" &&
    table.tableReference.projectId === "chrome-ux-report" &&
    table.tableReference.datasetId === "all" &&
    /^20\d{4}$/u.test(table.tableReference.tableId) &&
    Number(table.tableReference.tableId.slice(4)) >= 1 &&
    Number(table.tableReference.tableId.slice(4)) <= 12
  ).map((table) => table.tableReference.tableId);
  if (candidates.length === 0) mismatch();
  return candidates.sort().at(-1);
}

export function parseCruxBigQueryDryRun(body) {
  const parsed = dryRunSchema.safeParse(decode(body));
  if (!parsed.success || !parsed.data.jobComplete || parsed.data.pageToken ||
      !exactPayloadSchema(parsed.data.schema)) mismatch();
  const bytesProcessed = BigInt(parsed.data.totalBytesProcessed);
  if (bytesProcessed > BigInt(Number.MAX_SAFE_INTEGER)) mismatch();
  return Object.freeze({ bytesProcessed: Number(bytesProcessed) });
}

export function parseCruxBigQueryResponse(body, descriptor) {
  const parsed = querySchema.safeParse(decode(body));
  if (!parsed.success) mismatch();
  const response = parsed.data;
  if (!response.jobComplete || response.pageToken || !exactPayloadSchema(response.schema)) mismatch();
  const rows = response.rows || [];
  if (BigInt(response.totalRows) !== BigInt(rows.length)) mismatch();

  const expected = new Set(descriptor.origins);
  const rowsByOrigin = new Map();
  const contractMismatchOrigins = [];
  const seenOrigins = new Set();
  for (const row of rows) {
    if (row.f.length !== 1 || row.f[0].v == null) mismatch();
    let decoded;
    try {
      decoded = JSON.parse(row.f[0].v);
    } catch {
      mismatch();
    }
    const payload = payloadSchema.safeParse(decoded);
    if (!payload.success) mismatch();
    const value = payload.data;
    try {
      validateCruxDatasetMonth(value.dataset_month);
    } catch {
      mismatch();
    }
    if (
      value.dataset_month !== descriptor.month ||
      !expected.has(value.origin) ||
      seenOrigins.has(value.origin)
    ) mismatch();
    seenOrigins.add(value.origin);
    if (Math.abs(
      value.phone_density + value.desktop_density + value.tablet_density - 1
    ) > 0.01) {
      contractMismatchOrigins.push(value.origin);
      continue;
    }
    rowsByOrigin.set(value.origin, value);
  }

  const bytesProcessed = BigInt(response.totalBytesProcessed);
  const bytesBilled = BigInt(response.totalBytesBilled || "0");
  if (bytesProcessed > BigInt(Number.MAX_SAFE_INTEGER) ||
      bytesBilled > BigInt(Number.MAX_SAFE_INTEGER)) mismatch();
  return Object.freeze({
    rowsByOrigin,
    contractMismatchOrigins: Object.freeze(contractMismatchOrigins.sort()),
    bytesProcessed: Number(bytesProcessed),
    bytesBilled: Number(bytesBilled),
    cacheHit: response.cacheHit === true
  });
}
