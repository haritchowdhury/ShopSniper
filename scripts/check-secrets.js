import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    expression: /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']/giu,
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

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);
const EXCLUDED_FILES = new Set([
  ".env",
  "My workflow 3.json",
  "My workflow 4.json"
]);

function repositoryFiles(directory = ".", relative = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    if (!relative && EXCLUDED_FILES.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const display = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...repositoryFiles(file, display));
    else if (entry.isFile()) files.push(display);
  }
  return files;
}

export function scanRepository() {
  const findings = [];
  for (const file of repositoryFiles()) {
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) continue;
    findings.push(...scanText(buffer.toString("utf8"), file));
  }
  return findings;
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
