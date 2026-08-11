import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig } from "../config.js";
import { createPrismaClient } from "../prisma-client.js";
import { createPrismaRunRepository } from "../prisma-run-repository.js";
import { S3ArtifactStore } from "./adapters/artifact-store.js";
import { SqsDispatcher } from "./adapters/queue-dispatcher.js";
import { pipelineLog } from "./pipeline-log.js";
import { PipelineCoordinatorRepository } from "./repositories/pipeline-coordinator-repository.js";
import { loadAwsPipelineConfig } from "./runtime-config.js";
import { loadPipelineSecrets } from "./secrets.js";

let warmPrisma;
let warmDatabaseUrl;

function warmPrismaClient(databaseUrl) {
  if (!warmPrisma) {
    warmPrisma = createPrismaClient(databaseUrl);
    warmDatabaseUrl = databaseUrl;
  } else if (warmDatabaseUrl !== databaseUrl) {
    throw new Error("PIPELINE_INPUT_CONFLICT");
  }
  return warmPrisma;
}

export async function createPipelineRuntime(overrides = {}) {
  const config = overrides.config ?? loadAwsPipelineConfig(overrides.baseConfig ?? loadConfig());
  if (!config.awsPipelineActive) {
    return Object.freeze({
      config,
      prisma: overrides.prisma,
      repository: overrides.repository,
      coordinator: overrides.coordinator,
      artifactStore: overrides.artifactStore,
      dispatcher: overrides.dispatcher,
      secrets: overrides.secrets,
      s3Client: overrides.s3Client,
      sqsClient: overrides.sqsClient,
      secretsClient: overrides.secretsClient,
      log: overrides.log ?? pipelineLog
    });
  }

  const s3Client = overrides.s3Client ?? new S3Client({ region: config.awsRegion });
  const sqsClient = overrides.sqsClient ?? new SQSClient({ region: config.awsRegion });
  const secretsClient = overrides.secretsClient ?? new SecretsManagerClient({ region: config.awsRegion });
  const secrets = overrides.secrets ?? await loadPipelineSecrets({
    client: secretsClient,
    secretId: config.awsPipelineSecretId
  });
  const prisma = overrides.prisma ?? warmPrismaClient(secrets.databaseUrl);
  const repository = overrides.repository ?? createPrismaRunRepository(prisma, { ...config, ...secrets });
  const coordinator = overrides.coordinator ?? new PipelineCoordinatorRepository(prisma);
  const artifactStore = overrides.artifactStore ?? new S3ArtifactStore({
    client: s3Client,
    bucket: config.awsPipelineBucket,
    maxBytes: config.awsPipelineMaxArtifactBytes
  });
  const dispatcher = overrides.dispatcher ?? new SqsDispatcher({ client: sqsClient });
  return Object.freeze({
    config, prisma, repository, coordinator, artifactStore, dispatcher, secrets,
    s3Client, sqsClient, secretsClient, log: overrides.log ?? pipelineLog
  });
}
