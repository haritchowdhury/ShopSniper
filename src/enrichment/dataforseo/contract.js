import { z } from "zod";
import { ENRICHMENT_ERROR_CODES, dataForSeoError } from "../errors.js";
import {
  DATAFORSEO_ITEM_TYPES,
  DATAFORSEO_API_VERSION_PATTERN,
  normalizeDataForSeoHostname
} from "./request.js";

const finiteNonNegative = z.number().finite().nonnegative();
const nonNegativeInteger = z.number().int().nonnegative();
const metricSchema = z.object({
  etv: finiteNonNegative,
  count: nonNegativeInteger
}).passthrough();
const itemSchema = z.object({
  se_type: z.literal("google"),
  target: z.string(),
  metrics: z.object({
    organic: metricSchema,
    paid: metricSchema,
    featured_snippet: metricSchema,
    local_pack: metricSchema
  }).passthrough()
}).passthrough();
const resultSchema = z.object({
  se_type: z.literal("google"),
  location_code: z.number().int().positive().nullable(),
  language_code: z.null(),
  total_count: nonNegativeInteger,
  items_count: nonNegativeInteger,
  items: z.array(itemSchema)
}).passthrough();
const taskSchema = z.object({
  status_code: z.number().int(),
  status_message: z.string(),
  cost: finiteNonNegative,
  result_count: nonNegativeInteger,
  data: z.object({
    targets: z.array(z.string()),
    item_types: z.array(z.string()).optional(),
    location_code: z.number().int().positive().optional()
  }).passthrough(),
  result: z.array(resultSchema).nullable()
}).passthrough();
const rootSchema = z.object({
  version: z.string().regex(DATAFORSEO_API_VERSION_PATTERN),
  status_code: z.number().int(),
  status_message: z.string(),
  cost: finiteNonNegative,
  tasks_count: nonNegativeInteger,
  tasks_error: nonNegativeInteger,
  tasks: z.array(taskSchema)
}).passthrough();

function mismatch() {
  throw dataForSeoError(
    ENRICHMENT_ERROR_CODES.contractMismatch,
    "DataForSEO response did not match the captured contract"
  );
}

function rejected(root, task) {
  const capturedZeroCostRejection =
    root.status_code === 20000 && root.status_message === "Ok." &&
    root.cost === 0 && root.tasks_count === 1 &&
    root.tasks_error === 1 && root.tasks.length === 1 &&
    task.status_code === 40501 && task.status_message === "Invalid Field: 'targets'." &&
    task.cost === 0 && task.result_count === 0 && task.result === null &&
    task.data.api === "dataforseo_labs" &&
    task.data.function === "bulk_traffic_estimation" && task.data.se_type === "google" &&
    Array.isArray(task.data.targets) && task.data.targets.length === 0;
  if (!capturedZeroCostRejection) mismatch();
  throw dataForSeoError(
    ENRICHMENT_ERROR_CODES.providerRejected,
    "DataForSEO rejected the request",
    { paidOutcome: "zero_cost_proven" }
  );
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function parseDataForSeoResponse(body, descriptor) {
  let payload;
  try {
    payload = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    mismatch();
  }
  const parsed = rootSchema.safeParse(payload);
  if (!parsed.success) mismatch();
  const root = parsed.data;
  if (root.tasks_count !== 1 || root.tasks.length !== 1) mismatch();
  const task = root.tasks[0];
  if (root.status_code !== 20000 || task.status_code !== 20000) rejected(root, task);
  if (root.tasks_error !== 0) mismatch();
  if (!task.result || task.result_count !== 1 || task.result.length !== 1) mismatch();
  if (root.cost !== task.cost) mismatch();

  let echoedTargets;
  try {
    echoedTargets = task.data.targets.map((target) => {
      const normalized = normalizeDataForSeoHostname(target);
      if (normalized !== target) mismatch();
      return normalized;
    });
  } catch (error) {
    if (error?.code === ENRICHMENT_ERROR_CODES.contractMismatch) throw error;
    mismatch();
  }
  if (
    new Set(echoedTargets).size !== echoedTargets.length ||
    !sameArray(sorted(echoedTargets), descriptor.targets)
  ) mismatch();
  if (!task.data.item_types || !sameArray(task.data.item_types, DATAFORSEO_ITEM_TYPES)) {
    mismatch();
  }

  const result = task.result[0];
  const expectedLocation = descriptor.scope === "worldwide"
    ? null
    : descriptor.scope.locationCode;
  const hasTaskLocation = Object.hasOwn(task.data, "location_code");
  if (
    result.location_code !== expectedLocation ||
    (descriptor.scope === "worldwide" && hasTaskLocation) ||
    (descriptor.scope !== "worldwide" && task.data.location_code !== expectedLocation)
  ) mismatch();
  if (result.total_count !== descriptor.targets.length || result.items_count !== result.items.length) {
    mismatch();
  }

  const expected = new Set(descriptor.targets);
  const itemsByTarget = new Map();
  for (const item of result.items) {
    let normalized;
    try {
      normalized = normalizeDataForSeoHostname(item.target);
    } catch {
      mismatch();
    }
    if (normalized !== item.target || !expected.has(item.target) || itemsByTarget.has(item.target)) {
      mismatch();
    }
    itemsByTarget.set(item.target, item.metrics);
  }
  return {
    itemsByTarget,
    unavailableTargets: descriptor.targets.filter((target) => !itemsByTarget.has(target)),
    cost: root.cost
  };
}
