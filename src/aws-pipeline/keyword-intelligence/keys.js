import { PipelineContractError } from "../contracts/errors.js";
import { canonicalJson, fingerprintJson, sha256Hex } from "../core/canonical.js";
import {
  KEYWORD_ENDPOINT_SUGGESTIONS,
  KEYWORD_ENDPOINT_RELATED,
  KEYWORD_ENDPOINT_OVERVIEW,
  KEYWORD_STAGES
} from "./contracts.js";

const RESEARCH_ID = /^kr_[A-Za-z0-9_-]{24}$/u;
const ITEM_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;

function valid(value, pattern = ITEM_ID) {
  if (typeof value !== "string" || !pattern.test(value) || /[?#\\/\u0000-\u001f\u007f]/u.test(value) ||
      value === "." || value === ".." || /(?:token|secret|password|credential|authorization)/iu.test(value)) {
    throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
  }
  return value;
}

const research = (value) => valid(value, RESEARCH_ID);
const item = (value) => valid(value);

function stageName(value) {
  if (!KEYWORD_STAGES.includes(value)) throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
  return value;
}

export function keywordGenerationSegment(generation) {
  if (!Number.isInteger(generation) || generation < 1 || generation > 2147483647) {
    throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
  }
  return `generation-${generation}`;
}

export function keywordTaskArtifactKey(researchIdValue, generation, stage, itemIdValue) {
  return `runs/keyword-research/${research(researchIdValue)}/${keywordGenerationSegment(generation)}/${stageName(stage)}/${item(itemIdValue)}.json`;
}

export function keywordManifestKey(researchIdValue, generation, stage) {
  return `runs/keyword-research/${research(researchIdValue)}/${keywordGenerationSegment(generation)}/${stageName(stage)}/manifest.json`;
}

export function keywordResultKey(researchIdValue, generation) {
  return `runs/keyword-research/${research(researchIdValue)}/${keywordGenerationSegment(generation)}/market_overview/result.json`;
}

export function keywordRequestFingerprint(endpointKey, request) {
  if (![KEYWORD_ENDPOINT_SUGGESTIONS, KEYWORD_ENDPOINT_RELATED, KEYWORD_ENDPOINT_OVERVIEW].includes(endpointKey)) {
    throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
  }
  const body = canonicalJson(request);
  return sha256Hex(`${endpointKey}\n${body}`);
}

export function keywordCacheKey(endpointKey, request) {
  return `${endpointKey}:${sha256Hex(canonicalJson(request)).slice(0, 24)}`;
}

export function keywordTaskInputFingerprint({ contractVersion, researchId: researchIdValue, generation, payload }) {
  if (typeof contractVersion !== "string" || !contractVersion ||
      typeof researchIdValue !== "string" || !RESEARCH_ID.test(researchIdValue) ||
      !Number.isInteger(generation) || generation < 1 || payload === undefined) {
    throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
  }
  return fingerprintJson({ contractVersion, researchId: researchIdValue, generation, payload });
}

export function keywordStageInputFingerprint({ researchId: researchIdValue, generation, stage, tasks }) {
  if (typeof researchIdValue !== "string" || !RESEARCH_ID.test(researchIdValue) ||
      !Number.isInteger(generation) || generation < 1 || !KEYWORD_STAGES.includes(stage) ||
      !Array.isArray(tasks)) {
    throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
  }
  const ordered = [...tasks].sort((left, right) => String(left.itemKey).localeCompare(String(right.itemKey)));
  return fingerprintJson({
    researchId: researchIdValue,
    generation,
    stage,
    tasks: ordered.map((task) => ({
      itemKey: task.itemKey,
      inputFingerprint: task.inputFingerprint,
      endpointKey: task.endpointKey,
      requestFingerprint: task.requestFingerprint
    }))
  });
}

export function digestHex(value) {
  return sha256Hex(value);
}

export function sameHex(value) {
  if (typeof value !== "string" || !HEX_64.test(value)) throw new PipelineContractError("PIPELINE_MESSAGE_INVALID");
  return value;
}