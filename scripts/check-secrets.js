import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");

const PATTERNS = [
  {
    name: "private_key",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu
  },
  {
    name: "provider_token",
    expression: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/gu
  },
  {
    name: "credentialed_url",
    expression: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/([^\s/:]+):([^\s/@]+)@[^\s]+/giu,
    valueGroup: 2
  },
  {
    name: "credential_assignment",
    expression: /(?<![\w-])["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']/giu,
    valueGroup: 1
  }
];

function isPlaceholder(value) {
  return /^(?:test|fixture|example|placeholder|redacted|changeme|none|null|undefined|user|password|token|secret|key|<[^>]+>)$/iu.test(value) ||
    /^\$\{[^}]+\}$/u.test(value) ||
    /(?:example|fixture|placeholder|redacted|dummy|fake|test-only|your[-_])/iu.test(value) ||
    /^[A-Z][A-Z0-9_]*$/u.test(value);
}

function lineNumber(text, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

export function scanText(text, file = "<memory>") {
  const findings = [];
  for (const pattern of PATTERNS) {
    pattern.expression.lastIndex = 0;
    for (const match of text.matchAll(pattern.expression)) {
      if (pattern.valueGroup && isPlaceholder(match[pattern.valueGroup].trim())) {
        continue;
      }
      findings.push({
        file,
        line: lineNumber(text, match.index),
        pattern: pattern.name
      });
    }
  }
  return findings;
}

const EXCLUDED_PATH_SEGMENTS = new Set([
  ".git",
  ".lambda-build",
  ".next",
  "build",
  "coverage",
  "node_modules",
  "out"
]);
const EXCLUDED_EXACT_PATHS = new Set([
  ".env",
  "email_scraper/.env",
  "frontend/.env.local",
  "email_scraper/My workflow 3.json",
  "email_scraper/My workflow 4.json"
]);

function normalizedRepositoryPath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//u, "");
}

export function isExcludedRepositoryPath(value) {
  const file = normalizedRepositoryPath(value);
  if (EXCLUDED_EXACT_PATHS.has(file)) return true;
  return file.split("/").some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment));
}

export function listRepositoryFiles(repositoryRoot = REPOSITORY_ROOT) {
  const files = [];
  const visit = (directory, relative = "") => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const display = normalizedRepositoryPath(
        relative ? path.join(relative, entry.name) : entry.name
      );
      if (isExcludedRepositoryPath(display) || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, display);
      else if (entry.isFile()) files.push(display);
    }
  };
  visit(repositoryRoot);
  return files;
}

export function scanRepository({
  repositoryRoot = REPOSITORY_ROOT,
  files = listRepositoryFiles(repositoryRoot)
} = {}) {
  const findings = [];
  for (const file of files) {
    const absolute = path.resolve(repositoryRoot, file);
    const relative = normalizedRepositoryPath(path.relative(repositoryRoot, absolute));
    if (relative.startsWith("../") || isExcludedRepositoryPath(relative)) continue;
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) continue;
    findings.push(...scanText(buffer.toString("utf8"), relative));
  }
  return findings.sort((left, right) =>
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.pattern.localeCompare(right.pattern)
  );
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : "";
if (invokedPath === process.argv[1]) {
  const findings = scanRepository();
  if (findings.length) {
    for (const finding of findings) {
      console.error(`${finding.pattern} ${finding.file}:${finding.line}`);
    }
    console.error(`Secret scan failed with ${findings.length} redacted finding(s).`);
    process.exitCode = 1;
  } else {
    console.log("Secret scan passed; no credential-shaped assignments found.");
  }
}
