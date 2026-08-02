import { z } from "zod";
import { ENRICHMENT_ERROR_CODES, cruxError } from "../errors.js";
import {
  CRUX_API_RESPONSE_CONTRACT_VERSION,
  CRUX_METRICS
} from "./api-request.js";

const finiteNonNegative = z.number().finite().nonnegative();
const decimalString = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u);
const numericMetric = z.object({
  percentiles: z.object({ p75: finiteNonNegative }).passthrough()
}).passthrough();
const clsMetric = z.object({
  percentiles: z.object({ p75: decimalString }).passthrough()
}).passthrough();
const formFactorsMetric = z.object({
  fractions: z.object({
    desktop: z.number().finite().min(0).max(1),
    phone: z.number().finite().min(0).max(1),
    tablet: z.number().finite().min(0).max(1)
  }).passthrough()
}).passthrough();
const dateSchema = z.object({
  year: z.number().int().min(2000).max(9999),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31)
}).passthrough();
const successSchema = z.object({
  record: z.object({
    key: z.object({ origin: z.string() }).passthrough(),
    metrics: z.object({
      largest_contentful_paint: numericMetric.optional(),
      interaction_to_next_paint: numericMetric.optional(),
      cumulative_layout_shift: clsMetric.optional(),
      first_contentful_paint: numericMetric.optional(),
      experimental_time_to_first_byte: numericMetric.optional(),
      form_factors: formFactorsMetric.optional()
    }).passthrough(),
    collectionPeriod: z.object({
      firstDate: dateSchema,
      lastDate: dateSchema
    }).passthrough()
  }).passthrough()
}).passthrough();
const notFoundSchema = z.object({
  error: z.object({
    code: z.literal(404),
    message: z.literal("chrome ux report data not found"),
    status: z.literal("NOT_FOUND")
  }).strict()
}).strict();

function mismatch() {
  throw cruxError(
    ENRICHMENT_ERROR_CODES.contractMismatch,
    "CrUX REST response did not match the captured contract",
    CRUX_API_RESPONSE_CONTRACT_VERSION
  );
}

function decode(body) {
  try {
    return typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    mismatch();
  }
}

function isoDate(value) {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  if (
    date.getUTCFullYear() !== value.year ||
    date.getUTCMonth() + 1 !== value.month ||
    date.getUTCDate() !== value.day
  ) mismatch();
  return date.toISOString().slice(0, 10);
}

export function parseCruxNotFound(body) {
  if (!notFoundSchema.safeParse(decode(body)).success) mismatch();
  return Object.freeze({ coverage: "unavailable", reason: "not_found" });
}

export function parseCruxApiResponse(body, descriptor) {
  const parsed = successSchema.safeParse(decode(body));
  if (!parsed.success) mismatch();
  const record = parsed.data.record;
  if (record.key.origin !== descriptor.origin) mismatch();
  const present = CRUX_METRICS.filter((metric) => record.metrics[metric] != null);
  if (present.length === 0) mismatch();

  const firstDate = isoDate(record.collectionPeriod.firstDate);
  const lastDate = isoDate(record.collectionPeriod.lastDate);
  if (firstDate > lastDate) mismatch();

  const factors = record.metrics.form_factors?.fractions;
  if (factors) {
    const sum = factors.desktop + factors.phone + factors.tablet;
    if (Math.abs(sum - 1) > 0.01) mismatch();
  }
  return Object.freeze({
    metrics: Object.freeze({
      ...(record.metrics.largest_contentful_paint && {
        largestContentfulPaintP75Ms: record.metrics.largest_contentful_paint.percentiles.p75
      }),
      ...(record.metrics.interaction_to_next_paint && {
        interactionToNextPaintP75Ms: record.metrics.interaction_to_next_paint.percentiles.p75
      }),
      ...(record.metrics.cumulative_layout_shift && {
        cumulativeLayoutShiftP75: record.metrics.cumulative_layout_shift.percentiles.p75
      }),
      ...(record.metrics.first_contentful_paint && {
        firstContentfulPaintP75Ms: record.metrics.first_contentful_paint.percentiles.p75
      }),
      ...(record.metrics.experimental_time_to_first_byte && {
        timeToFirstByteP75Ms: record.metrics.experimental_time_to_first_byte.percentiles.p75
      })
    }),
    ...(factors && { formFactors: Object.freeze({ ...factors }) }),
    collectionPeriod: Object.freeze({ firstDate, lastDate })
  });
}
