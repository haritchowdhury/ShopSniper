import { createHash } from "node:crypto";
import { PipelineContractError } from "../contracts/errors.js";

function normalize(value, seen) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new PipelineContractError("PIPELINE_ARTIFACT_INVALID");
    return value.toISOString();
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PipelineContractError("PIPELINE_ARTIFACT_INVALID");
    return value;
  }
  if (typeof value !== "object") throw new PipelineContractError("PIPELINE_ARTIFACT_INVALID");
  if (seen.has(value)) throw new PipelineContractError("PIPELINE_ARTIFACT_INVALID");
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    output = value.map((item) => normalize(item, seen));
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new PipelineContractError("PIPELINE_ARTIFACT_INVALID");
    }
    output = {};
    for (const key of Object.keys(value).sort()) output[key] = normalize(value[key], seen);
  }
  seen.delete(value);
  return output;
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value, new Set()));
}

export function sha256Hex(bytesOrString) {
  if (typeof bytesOrString !== "string" && !Buffer.isBuffer(bytesOrString) &&
      !(bytesOrString instanceof Uint8Array)) {
    throw new PipelineContractError("PIPELINE_ARTIFACT_INVALID");
  }
  return createHash("sha256").update(bytesOrString).digest("hex");
}

export function fingerprintJson(value) {
  return sha256Hex(canonicalJson(value));
}
