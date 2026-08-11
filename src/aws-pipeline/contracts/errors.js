const CODES = new Set([
  "PIPELINE_CONTRACT_DRIFT", "PIPELINE_MESSAGE_INVALID", "PIPELINE_ARTIFACT_INVALID",
  "PIPELINE_ARTIFACT_CONFLICT", "PIPELINE_IDENTITY_MISMATCH", "PIPELINE_INPUT_CONFLICT",
  "PIPELINE_LEASE_LOST", "PIPELINE_CANCELLED", "PIPELINE_NOT_READY",
  "PIPELINE_PROVIDER_AMBIGUOUS", "PIPELINE_PROVIDER_UNAVAILABLE"
]);

function code(value, fallback) {
  return CODES.has(value) ? value : fallback;
}

export class PipelineContractError extends Error {
  constructor(errorCode = "PIPELINE_CONTRACT_DRIFT") {
    super(code(errorCode, "PIPELINE_CONTRACT_DRIFT"));
    this.name = "PipelineContractError";
    this.code = code(errorCode, "PIPELINE_CONTRACT_DRIFT");
  }
}

export class PipelineInvariantError extends Error {
  constructor(errorCode = "PIPELINE_INPUT_CONFLICT") {
    super(code(errorCode, "PIPELINE_INPUT_CONFLICT"));
    this.name = "PipelineInvariantError";
    this.code = code(errorCode, "PIPELINE_INPUT_CONFLICT");
  }
}

export function safePipelineError(error, fallback = "PIPELINE_ARTIFACT_INVALID") {
  const safeCode = code(error?.code, code(fallback, "PIPELINE_ARTIFACT_INVALID"));
  return { code: safeCode, message: safeCode };
}
