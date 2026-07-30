import http from "node:http";
import { fileURLToPath } from "node:url";
import { assertRunConfig, loadConfig } from "./config.js";
import { runPipeline } from "./pipeline.js";
import { log } from "./logger.js";

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function initialStatus() {
  return {
    state: "idle",
    runId: "",
    startedAt: "",
    completedAt: "",
    queriesTotal: 0,
    queriesProcessed: 0,
    blankQueriesSkipped: 0,
    storesDiscovered: 0,
    storesQualified: 0,
    storesRejected: 0,
    failures: 0,
    outputRows: 0,
    error: ""
  };
}

export function createLeadServer(config, { pipeline = runPipeline } = {}) {
  let status = initialStatus();

  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      return sendJson(response, 200, { status: "ok" });
    }
    if (request.method === "GET" && requestUrl.pathname === "/status") {
      return sendJson(response, 200, status);
    }
    if (request.method === "POST" && requestUrl.pathname === "/run") {
      if (status.state === "running") {
        return sendJson(response, 409, {
          error: "A lead-generation job is already running",
          runId: status.runId
        });
      }
      try {
        assertRunConfig(config);
      } catch (error) {
        return sendJson(response, 503, { error: error.message });
      }

      status = {
        ...initialStatus(),
        state: "running",
        runId: crypto.randomUUID(),
        startedAt: new Date().toISOString()
      };
      const accepted = { state: status.state, runId: status.runId };
      sendJson(response, 202, accepted);

      setImmediate(async () => {
        try {
          await pipeline(config, status);
          status.state = "completed";
          log("run_completed", {
            runId: status.runId,
            outputRows: status.outputRows,
            qualified: status.storesQualified,
            rejected: status.storesRejected,
            failures: status.failures
          });
        } catch (error) {
          status.state = "failed";
          status.error = error instanceof Error ? error.message : String(error);
          log("run_failed", { runId: status.runId, error });
        } finally {
          status.completedAt = new Date().toISOString();
        }
      });
      return;
    }
    return sendJson(response, 404, { error: "Not found" });
  });
}

export function startServer(config = loadConfig()) {
  const server = createLeadServer(config);
  server.listen(config.port, config.host, () => {
    log("server_started", { host: config.host, port: config.port });
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    startServer();
  } catch (error) {
    log("startup_failed", { error });
    process.exitCode = 1;
  }
}
