import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAwsDomainPages } from "../src/aws-pipeline/lead/domain-page-fetcher.js";
import { parseAwsProviderConfig } from "../src/aws-pipeline/contracts/aws-provider-config.js";
import { createPrismaClient } from "../src/prisma-client.js";
import {
  discoverLeadForRunStoreWithFetcher,
  failedLeadForRunStore
} from "../src/pipeline.js";
import { writeOutput } from "../src/output.js";
import { createJinaFallbackExecutor } from "./lib/jina-render-fallback.js";

const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]+$/u;
const STORE_CONCURRENCY = 2; // Preserve the production lead-worker concurrency boundary.

function usage() {
  return "Usage: npm run test:jina-leads -- <run-id> [output.csv]";
}

function parseArguments(values) {
  const [runId, requestedOutput, ...extra] = values;
  if (!runId || !RUN_ID_PATTERN.test(runId) || extra.length) throw new Error(usage());
  const outputPath = requestedOutput
    ? path.resolve(requestedOutput)
    : path.resolve("data", "jina-tests", `${runId}-qualified-leads.csv`);
  if (path.extname(outputPath).toLowerCase() !== ".csv") {
    throw new Error("Output path must end in .csv");
  }
  return { runId, outputPath };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  ));
  return results;
}

function countByStatus(leads) {
  return leads.reduce((counts, lead) => {
    counts[lead.status] = (counts[lead.status] || 0) + 1;
    return counts;
  }, { qualified: 0, rejected: 0, failed: 0 });
}

export async function processRunWithJina(
  { runId, outputPath, jinaApiKey = process.env.JINA_API_KEY },
  { createDatabase = createPrismaClient, writeCsv = writeOutput,
    createFallback = createJinaFallbackExecutor } = {}
) {
  if (!jinaApiKey) throw new Error("JINA_API_KEY is required");
  const database = createDatabase();
  try {
    const run = await database.run.findUnique({
      where: { id: runId },
      select: {
        id: true,
        state: true,
        stage: true,
        resultsAvailable: true,
        executionBackend: true,
        awsProviderConfig: true
      }
    });
    if (
      !run ||
      run.executionBackend !== "aws" ||
      run.state !== "completed" ||
      run.stage !== "completed" ||
      run.resultsAvailable !== true
    ) {
      throw new Error("Run must be a completed, published AWS run");
    }

    const providerConfig = parseAwsProviderConfig(run.awsProviderConfig);
    const runStores = await database.runStore.findMany({
      where: { runId },
      select: { id: true, candidatePayload: true },
      orderBy: { id: "asc" }
    });
    if (!runStores.length) throw new Error("Run has no discovered domains");

    const executeJinaFallback = createFallback(jinaApiKey);
    const taskContext = { assertActive() {} };
    const leadConfig = {
      ...providerConfig.leadFetch,
      enableAiNormalization: providerConfig.aiNormalization.enabled,
      openaiApiKey: "",
      openaiModel: providerConfig.aiNormalization.model
    };
    if (leadConfig.enableAiNormalization) {
      throw new Error("This isolated test does not dispatch AI normalization");
    }

    let processed = 0;
    const leads = await mapWithConcurrency(
      runStores,
      STORE_CONCURRENCY,
      async (runStore) => {
        let lead;
        try {
          ({ lead } = await discoverLeadForRunStoreWithFetcher(
            leadConfig,
            runStore,
            ({ candidate }) => fetchAwsDomainPages(
              {
                candidate,
                taskContext,
                config: {
                  leadFetch: providerConfig.leadFetch,
                  browserless: providerConfig.browserless
                }
              },
              { executeBrowserless: executeJinaFallback }
            )
          ));
        } catch (error) {
          lead = failedLeadForRunStore(runStore.candidatePayload, error);
        }
        processed += 1;
        process.stdout.write(
          `\rProcessed ${processed}/${runStores.length}; latest=${lead.status}   `
        );
        return lead;
      }
    );
    process.stdout.write("\n");

    const qualified = leads.filter(({ status }) => status === "qualified");
    await writeCsv(outputPath, qualified);
    return {
      runId,
      domains: runStores.length,
      outputPath,
      written: qualified.length,
      statuses: countByStatus(leads)
    };
  } finally {
    await database.$disconnect();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const summary = await processRunWithJina(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments };
