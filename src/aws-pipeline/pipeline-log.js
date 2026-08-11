const ALLOWED = Object.freeze([
  "runId", "stage", "generation", "itemId", "attempt", "outcome",
  "durationMs", "artifactKey", "safeCode", "count"
]);

export function pipelineLog(event, fields = {}, write = console.log) {
  const record = { event: String(event) };
  for (const key of ALLOWED) {
    if (fields[key] !== undefined) record[key] = fields[key];
  }
  write(JSON.stringify(record));
  return record;
}
