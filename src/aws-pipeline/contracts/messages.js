import { z } from "zod";
import { PipelineContractError } from "./errors.js";

const runId = z.string().regex(/^run_[A-Za-z0-9_-]{16,80}$/u);
const itemId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const generation = z.number().int().min(1).max(2147483647);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const attempt = z.number().int().positive();
const manifestKey = z.string().min(1).max(2048).refine((v) => !/[?#\\\u0000-\u001f\u007f]/u.test(v) &&
  !v.split("/").includes("..") && !/(?:token|secret|password|credential|authorization)/iu.test(v));

const work = (type, stage) => z.object({
  version: z.literal(1), type: z.literal(type), runId, stage: z.literal(stage), generation,
  itemId, manifestKey, manifestFingerprint: fingerprint, attempt
}).strict();
export const workMessageSchema = z.discriminatedUnion("type", [
  work("discovery.query", "discovery"), work("lead.domain", "lead"),
  work("traffic.domain", "traffic_crux")
]);
export const aggregationCheckMessageSchema = z.object({
  version: z.literal(1), type: z.literal("aggregation.check"), runId,
  stage: z.enum(["discovery", "lead", "traffic_crux"]), generation,
  reason: z.enum(["terminal_task_recorded", "zero_expected", "recovery"]), attempt
}).strict();

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
  return result.data;
}
export const parseWorkMessage = (value) => parse(workMessageSchema, value);
export const parseAggregationCheckMessage = (value) => parse(aggregationCheckMessageSchema, value);
