import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LAMBDA_HANDLERS, REQUIRED_PRISMA_ENGINE } from "./build-lambda.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = path.join(projectRoot, "dist", "lambda");
const maxZipBytes = 45 * 1024 * 1024;
const maxUnzippedBytes = 200 * 1024 * 1024;
const forbidden = [/(^|\/)\.env(?:\.|$)/i, /(^|\/)test(?:s)?\//i, /(^|\/)fixtures?\//i,
  /(^|\/)docs?\//i, /\.map$/i, /\.md$/i, /credential/i];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function walk(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  let bytes = 0;
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Package contains symlink: ${entry.name}`);
    if (entry.isDirectory()) {
      const nested = await walk(root, absolute);
      bytes += nested.bytes;
      files.push(...nested.files);
    } else if (entry.isFile()) {
      bytes += (await stat(absolute)).size;
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  return { bytes, files };
}

function validateInventory(files) {
  for (const file of files) {
    if (file.startsWith("/") || file.split("/").includes("..")) throw new Error(`Unsafe ZIP path: ${file}`);
    if (forbidden.some((pattern) => pattern.test(file))) throw new Error(`Forbidden ZIP file: ${file}`);
  }
  const engines = files.filter((file) => /query_engine.*\.node$/i.test(file));
  if (engines.length !== 1 || !engines[0].endsWith(REQUIRED_PRISMA_ENGINE)) {
    throw new Error(`Unexpected Prisma engines: ${engines.join(",")}`);
  }
}

async function coldImport(indexPath) {
  const resultPath = path.join(path.dirname(indexPath), ".cold-import.json");
  const program = `import{writeFileSync}from"node:fs";const before=process.memoryUsage().rss;const start=process.hrtime.bigint();await import(${JSON.stringify(pathToFileURL(indexPath).href)});const end=process.hrtime.bigint();writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({durationMs:Number(end-start)/1e6,rssBytes:process.memoryUsage().rss,rssDeltaBytes:process.memoryUsage().rss-before}));`;
  run(process.execPath, ["--input-type=module", "--eval", program]);
  return JSON.parse(await readFile(resultPath, "utf8"));
}

const measurements = [];
for (const name of LAMBDA_HANDLERS) {
  const archive = path.join(outputRoot, `${name}.zip`);
  const zipBytes = (await stat(archive)).size;
  const zipEntries = run("unzip", ["-Z1", archive]).trim().split("\n").filter(Boolean).sort();
  validateInventory(zipEntries);
  const extraction = await mkdtemp(path.join(tmpdir(), `storesignal-${name}-`));
  try {
    run("unzip", ["-q", archive, "-d", extraction]);
    const inventory = await walk(extraction);
    const files = inventory.files.sort();
    validateInventory(files);
    if (JSON.stringify(files) !== JSON.stringify(zipEntries)) throw new Error(`ZIP inventory mismatch: ${name}`);
    if (zipBytes > maxZipBytes) throw new Error(`${name} ZIP exceeds 45 MB`);
    if (inventory.bytes > maxUnzippedBytes) throw new Error(`${name} unzipped package exceeds 200 MB`);
    measurements.push({
      handler: name,
      zipBytes,
      unzippedBytes: inventory.bytes,
      fileListHash: createHash("sha256").update(`${files.join("\n")}\n`).digest("hex"),
      requiredEngine: REQUIRED_PRISMA_ENGINE,
      enginePresent: true,
      coldImport: await coldImport(path.join(extraction, "index.mjs")),
      files
    });
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}
const report = { node: process.version, measurements };
await writeFile(path.join(outputRoot, "measurements.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
