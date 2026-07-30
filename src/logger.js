function sanitize(value) {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "string") {
    return value
      .replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, "$1[redacted]")
      .replace(/(bearer\s+)[a-z0-9._-]+/gi, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/api.?key|token|authorization|secret/i.test(key))
        .map(([key, entry]) => [key, sanitize(entry)])
    );
  }
  return value;
}

export function log(event, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...sanitize(fields)
    })}\n`
  );
}
