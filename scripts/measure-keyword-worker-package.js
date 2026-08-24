import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  KEYWORD_LAMBDA_HANDLERS,
  REQUIRED_PRISMA_ENGINE
} from "./build-keyword-worker.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = path.join(projectRoot, "dist", "lambda");
const reportPath = path.join(outputRoot, "keyword-worker-measurements.json");
const maxZipBytes = 45 * 1024 * 1024;
const maxUnzippedBytes = 200 * 1024 * 1024;
const forbidden = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)test(?:s)?\//i,
  /(^|\/)fixtures?\//i,
  /(^|\/)docs?\//i,
  /\.map$/i,
  /\.md$/i,
  /credential/i
];

function compareUnsignedUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function walk(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  let bytes = 0;
  const files = [];
  for (const entry of entries.sort((left, right) => compareUnsignedUtf8(left.name, right.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Package contains symlink: ${entry.name}`);
    if (entry.isDirectory()) {
      const nested = await walk(root, absolute);
      bytes += nested.bytes;
      files.push(...nested.files);
    } else if (entry.isFile()) {
      bytes += (await stat(absolute)).size;
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
    } else {
      throw new Error(`Package contains unsupported entry: ${entry.name}`);
    }
  }
  return { bytes, files: files.sort(compareUnsignedUtf8) };
}

export function validateInventory(files) {
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string" || file.length === 0)) {
    throw new Error("Invalid ZIP inventory");
  }
  const sorted = [...files].sort(compareUnsignedUtf8);
  if (new Set(sorted).size !== sorted.length) throw new Error("Duplicate ZIP inventory member");
  for (const file of sorted) {
    const segments = file.replaceAll("\\", "/").split("/");
    if (file.startsWith("/") || path.win32.isAbsolute(file) || segments.includes("..") || file.endsWith("/")) {
      throw new Error(`Unsafe ZIP path: ${file}`);
    }
    if (forbidden.some((pattern) => pattern.test(file))) throw new Error(`Forbidden ZIP file: ${file}`);
  }
  const engines = sorted.filter((file) => /query_engine.*\.node$/i.test(file));
  if (engines.length !== 1 || !engines[0].endsWith(REQUIRED_PRISMA_ENGINE)) {
    throw new Error(`Unexpected Prisma engines: ${engines.join(",")}`);
  }
  return sorted;
}

async function coldImport(indexPath) {
  const program = [
    `const before=process.memoryUsage().rss;`,
    `const start=process.hrtime.bigint();`,
    `const module=await import(${JSON.stringify(pathToFileURL(indexPath).href)});`,
    `if(typeof module.handler!=="function")throw new Error("Keyword worker handler export is missing");`,
    `const end=process.hrtime.bigint();`,
    `process.stdout.write(JSON.stringify({durationMs:Number(end-start)/1e6,rssBytes:process.memoryUsage().rss,rssDeltaBytes:process.memoryUsage().rss-before}));`
  ].join("");
  return JSON.parse(run(process.execPath, ["--input-type=module", "--eval", program]));
}

export async function measureKeywordWorkerPackage() {
  if (JSON.stringify(KEYWORD_LAMBDA_HANDLERS) !== JSON.stringify(["keyword-worker"])) {
    throw new Error("Unexpected keyword Lambda handler inventory");
  }

  const measurements = [];
  for (const handler of KEYWORD_LAMBDA_HANDLERS) {
    const archive = path.join(outputRoot, `${handler}.zip`);
    const zipBytes = (await stat(archive)).size;
    const zipEntries = validateInventory(
      run("unzip", ["-Z1", archive]).trim().split("\n").filter(Boolean).sort(compareUnsignedUtf8)
    );
    const extraction = await mkdtemp(path.join(tmpdir(), `storesignal-${handler}-`));
    try {
      run("unzip", ["-q", archive, "-d", extraction]);
      const inventory = await walk(extraction);
      const files = validateInventory(inventory.files);
      if (JSON.stringify(files) !== JSON.stringify(zipEntries)) {
        throw new Error(`ZIP inventory mismatch: ${handler}`);
      }
      if (zipBytes > maxZipBytes) throw new Error(`${handler} ZIP exceeds 45 MiB`);
      if (inventory.bytes > maxUnzippedBytes) throw new Error(`${handler} expanded package exceeds 200 MiB`);
      measurements.push({
        handler,
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
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, serialized);
  process.stdout.write(serialized);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await measureKeywordWorkerPackage();
}
