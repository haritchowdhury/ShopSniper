import fs from "node:fs/promises";

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (quoted) throw new Error("Malformed CSV: unclosed quoted field");
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function stringifyCsv(rows, headers) {
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  return [
    headers.map(escape).join(","),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))
  ].join("\n") + "\n";
}

export async function readQueries(filePath, maxQueries = 500) {
  const rows = parseCsv(await fs.readFile(filePath, "utf8"));
  if (!rows.length) throw new Error("Input CSV is empty");

  const headers = rows[0].map((header) => header.trim());
  const queryIndex = headers.indexOf("Search Query");
  if (queryIndex === -1) {
    throw new Error('Input CSV must contain the exact header "Search Query"');
  }

  const queries = [];
  let blanksSkipped = 0;
  for (const row of rows.slice(1)) {
    const query = (row[queryIndex] || "").trim();
    if (!query) {
      blanksSkipped += 1;
      continue;
    }
    queries.push(query);
    if (queries.length > maxQueries) {
      throw new Error(`Input exceeds MAX_QUERIES (${maxQueries})`);
    }
  }
  return { queries, blanksSkipped };
}
