const QUEUE_KEYS = Object.freeze([
  "awsPipelineDiscoveryQueueUrl",
  "awsPipelineDomainAggregationQueueUrl",
  "awsPipelineLeadQueueUrl",
  "awsPipelineLeadAggregationQueueUrl",
  "awsPipelineTrafficQueueUrl",
  "awsPipelineFinalAggregationQueueUrl"
]);

function validHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function loadAwsPipelineConfig(baseConfig) {
  if (!baseConfig || typeof baseConfig !== "object") {
    throw new Error("AWS pipeline base configuration is required");
  }
  if (baseConfig.runExecutionBackend === "local" && !baseConfig.awsPipelineEnabled) {
    return Object.freeze({ ...baseConfig, awsPipelineActive: false });
  }
  if (baseConfig.runExecutionBackend !== "aws" || baseConfig.awsPipelineEnabled !== true) {
    throw new Error("AWS pipeline requires RUN_EXECUTION_BACKEND=aws and AWS_PIPELINE_ENABLED=true");
  }
  const missing = [];
  if (!baseConfig.awsRegion) missing.push("AWS_REGION");
  if (!baseConfig.awsPipelineBucket) missing.push("AWS_PIPELINE_BUCKET");
  if (!baseConfig.awsPipelineSecretId) missing.push("AWS_PIPELINE_SECRET_ID");
  for (const key of QUEUE_KEYS) {
    if (!validHttpsUrl(baseConfig[key])) missing.push(key);
  }
  if (missing.length) throw new Error(`Missing or invalid AWS pipeline configuration: ${missing.join(", ")}`);
  return Object.freeze({ ...baseConfig, awsPipelineActive: true });
}
