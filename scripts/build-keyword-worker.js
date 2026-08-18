import { cp, mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export const KEYWORD_LAMBDA_HANDLERS = Object.freeze(["keyword-worker"]);
export const REQUIRED_PRISMA_ENGINE = "libquery_engine-rhel-openssl-3.0.x.so.node";
export const ESM_REQUIRE_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  "const require = __createRequire(import.meta.url);"
].join("\n");
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const buildRoot = path.join(projectRoot, ".lambda-build");
const outputRoot = path.join(projectRoot, "dist", "lambda");
const fixedDate = new Date("1980-01-01T00:00:00.000Z");

async function copyTree(source, destination, filter = () => true) {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter(sourcePath) {
      const relative = path.relative(source, sourcePath).split(path.sep).join("/");
      return filter(relative);
    }
  });
}

async function sortedFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Lambda staging contains symlink: ${entry.name}`);
    if (entry.isDirectory()) files.push(...await sortedFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`Unsupported Lambda staging entry: ${entry.name}`);
  }
  return files;
}

async function normalizeTimes(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) await normalizeTimes(absolute);
    await utimes(absolute, fixedDate, fixedDate);
  }
  await utimes(root, fixedDate, fixedDate);
}

async function assertRequiredInputs() {
  await stat(path.join(projectRoot, "node_modules", "@prisma", "client"));
  await stat(path.join(projectRoot, "node_modules", ".prisma", "client", REQUIRED_PRISMA_ENGINE));
}

async function buildHandler(name) {
  const staging = path.join(buildRoot, name);
  await mkdir(staging, { recursive: true });
  await build({
    entryPoints: [path.join(projectRoot, "src", "aws-pipeline", "keyword-intelligence", "handler.js")],
    outfile: path.join(staging, "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    minify: false,
    sourcemap: false,
    banner: { js: ESM_REQUIRE_BANNER },
    external: ["@prisma/client"]
  });
  await copyTree(
    path.join(projectRoot, "node_modules", "@prisma", "client"),
    path.join(staging, "node_modules", "@prisma", "client"),
    (relative) => !relative.endsWith(".map") && !relative.toLowerCase().endsWith(".md")
  );
  await copyTree(
    path.join(projectRoot, "node_modules", ".prisma", "client"),
    path.join(staging, "node_modules", ".prisma", "client"),
    (relative) => (!relative || (!relative.endsWith(".map") && !relative.toLowerCase().endsWith(".md")))
      && (!relative || !relative.includes("query_engine") || relative.endsWith(REQUIRED_PRISMA_ENGINE))
  );
  await normalizeTimes(staging);
  const files = await sortedFiles(staging);
  const archive = path.join(outputRoot, `${name}.zip`);
  const zipped = spawnSync("zip", ["-X", "-q", archive, ...files], {
    cwd: staging,
    encoding: "utf8"
  });
  if (zipped.status !== 0) throw new Error(`zip failed for ${name}: ${zipped.stderr.trim()}`);
}

export async function buildKeywordWorkerPackage() {
  await assertRequiredInputs();
  const ownStaging = path.join(buildRoot, "keyword-worker");
  const ownArchive = path.join(outputRoot, "keyword-worker.zip");
  await rm(ownStaging, { recursive: true, force: true });
  await rm(ownArchive, { force: true });
  await mkdir(ownStaging, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await buildHandler("keyword-worker");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await buildKeywordWorkerPackage();