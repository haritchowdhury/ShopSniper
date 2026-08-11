import { createHash } from "node:crypto";
import { PipelineContractError } from "../contracts/errors.js";

const RUN_ID = /^run_[A-Za-z0-9_-]{16,80}$/u;
const ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const STAGES = new Set(["discovery", "lead", "traffic_crux"]);
const SOURCES = new Set(["dataforseo", "crux-rest", "crux-bigquery"]);

function valid(value, pattern = ITEM_ID) {
  if (typeof value !== "string" || !pattern.test(value) || /[?#\\/\u0000-\u001f\u007f]/u.test(value) ||
      value === "." || value === ".." || /(?:token|secret|password|credential|authorization)/iu.test(value)) {
    throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
  }
  return value;
}
const run = (value) => valid(value, RUN_ID);
const item = (value) => valid(value);

export const queryManifestKey = (runId) => `runs/${run(runId)}/queries/manifest.json`;
export const queryArtifactKey = (runId, queryId) => `runs/${run(runId)}/queries/${item(queryId)}/domains.json`;
export const domainManifestKey = (runId) => `runs/${run(runId)}/domains-manifest.json`;
export const candidateArtifactKey = (runId, shopId) => `runs/${run(runId)}/domains/${item(shopId)}/candidate.json`;
export const leadArtifactKey = (runId, shopId) => `runs/${run(runId)}/domains/${item(shopId)}/lead.json`;
export function providerArtifactKey(runId, shopId, source) {
  if (!SOURCES.has(source)) throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
  return `runs/${run(runId)}/domains/${item(shopId)}/traffic/${source}.json`;
}
export const trafficArtifactKey = (runId, shopId) => `runs/${run(runId)}/domains/${item(shopId)}/traffic-crux.json`;

function derived(prefix, parts) {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("base64url").slice(0, 24);
  return `${prefix}${digest}`;
}
export function pipelineStageId(runId, stage, generation) {
  run(runId);
  if (!STAGES.has(stage) || !Number.isInteger(generation) || generation < 1 || generation > 2147483647) {
    throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
  }
  return derived("pipeline_stage_", [runId, stage, String(generation)]);
}
export function pipelineTaskId(stageId, itemKey) {
  valid(stageId, /^pipeline_stage_[A-Za-z0-9_-]{24}$/u);
  item(itemKey);
  return derived("pipeline_task_", [stageId, itemKey]);
}
