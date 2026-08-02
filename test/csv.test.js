import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseCsv, readQueries, stringifyCsv } from "../src/csv.js";
import { OUTPUT_HEADERS, outputHeaders } from "../src/output.js";
import { writeOutput } from "../src/output.js";

test("CSV parser handles commas, escaped quotes, and newlines", () => {
  const rows = parseCsv('Search Query,note\r\n"coffee, tea","said ""hello"""\r\n"line\nbreak",ok\r\n');
  assert.deepEqual(rows, [
    ["Search Query", "note"],
    ["coffee, tea", 'said "hello"'],
    ["line\nbreak", "ok"]
  ]);
});

test("G3 CSV fields are appended without shifting legacy columns", () => {
  assert.deepEqual(OUTPUT_HEADERS.slice(0, 25), [
    "shop_type", "generated_query", "query_score", "query_generation_reason",
    "search_query", "google_rank", "google_result_url", "myshopify_domain",
    "final_url", "canonical_url", "resolved_domain", "store_name", "email",
    "email_source_url", "phone", "phone_source_url", "contact_url",
    "social_profiles", "additional_information", "shopify_confidence",
    "relevance_score", "lead_score", "status", "rejection_reason", "error"
  ]);
  assert.equal(OUTPUT_HEADERS[25], "business_qualifier");
  assert.equal(OUTPUT_HEADERS.at(-2), "matched_categories");
  assert.equal(OUTPUT_HEADERS.at(-1), "original_shop_type");
});

test("CSV writer round-trips special values", () => {
  const source = [{ a: "café 👓", b: 'comma, quote " and\nnewline 眼鏡' }];
  const serialized = stringifyCsv(source, ["a", "b"]);
  assert.deepEqual(parseCsv(serialized), [
    ["a", "b"],
    ["café 👓", 'comma, quote " and\nnewline 眼鏡']
  ]);
});

test("CSV writer neutralizes spreadsheet formulas without changing numeric values", () => {
  const dangerous = ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tformula", "\rformula", "  =trimmed"];
  const serialized = stringifyCsv(
    dangerous.map((value, index) => ({ value, numeric: index })),
    ["value", "numeric"]
  );
  const parsed = parseCsv(serialized).slice(1);
  assert.deepEqual(parsed.map(([value]) => value), dangerous.map((value) => `'${value}`));
  assert.deepEqual(parsed.map(([, numeric]) => numeric), dangerous.map((_, index) => String(index)));
});

test("CSV parser rejects unclosed quoted fields", () => {
  assert.throws(() => parseCsv('header\n"unfinished'), /unclosed quoted field/);
});

test("query reader requires the exact header and reports blank rows", async () => {
  const fixture = (name) =>
    fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
  assert.deepEqual(await readQueries(fixture("queries.csv"), 10), {
    queries: ["organic spices", "coffee, tea"],
    blanksSkipped: 1
  });
  await assert.rejects(
    readQueries(fixture("missing-header.csv"), 10),
    /exact header "Search Query"/
  );
});

test("backend CSV export rejects contradictory v2 score states", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "score-state-csv-"));
  const output = path.join(directory, "leads.csv");
  try {
    await assert.rejects(writeOutput(output, [{
      status: "rejected",
      pipeline_version: 2,
      scoring_version: 2,
      lead_score: 72,
      score_breakdown: {
        version: 2,
        components: {
          identity: 14,
          shopifyValidation: 20,
          categoryFit: 24,
          contactEvidence: 14
        },
        total: 72,
        semantics: "deterministic_evidence_rank_not_probability"
      }
    }]), /Lead score state/u);
    await assert.rejects(fs.access(output));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function publicTraffic({ dataForSeo = false, crux = false, material = true } = {}) {
  const metrics = (organic, paid) => ({
    estimated_google_search_traffic: organic + paid,
    organic_estimated_traffic: organic,
    organic_keyword_count: 7,
    paid_estimated_traffic: paid,
    paid_keyword_count: paid === 0 ? 0 : 2,
    featured_snippet_estimated_traffic: 3,
    featured_snippet_keyword_count: 1,
    local_pack_estimated_traffic: 4,
    local_pack_keyword_count: 1
  });
  return {
    version: "traffic-enrichment-public-v1",
    ...(dataForSeo && {
      dataforseo: {
        state: material ? "partial" : "no_coverage",
        ...(material && {
          label: "Estimated Google search traffic",
          target: "fixture.example",
          worldwide: metrics(10.5, 1.5),
          markets: [{ country_code: "IN", ...metrics(4, 0) }],
          observed_at: "2026-08-01T00:00:00.000Z"
        })
      }
    }),
    ...(crux && {
      crux: {
        state: material ? "partial" : "no_coverage",
        origin_metrics: material ? {
          state: "available",
          origin: "https://fixture.example",
          metrics: { largest_contentful_paint_p75_ms: 2400 },
          observed_form_factor_fractions: { desktop: 0.4, phone: 0.6, tablet: 0 },
          collection_period: { first_date: "2026-07-01", last_date: "2026-07-28" },
          observed_at: "2026-08-01T00:00:00.000Z"
        } : { state: "no_coverage" },
        popularity: { state: "no_coverage" }
      }
    }),
    ...(material && {
      traffic_sources: [dataForSeo ? "dataforseo" : null, crux ? "crux" : null].filter(Boolean),
      traffic_attributions: [
        ...(dataForSeo ? [{
          source: "dataforseo",
          name: "DataForSEO Labs",
          text: "=provider attribution",
          source_url: "https://example.com/source"
        }] : []),
        ...(crux ? [{
          source: "crux",
          name: "Chrome UX Report",
          text: "CrUX attribution",
          source_url: "https://example.com/crux",
          license: "CC BY 4.0",
          license_url: "https://creativecommons.org/licenses/by/4.0/",
          transformation: "Selected and renamed"
        }] : [])
      ]
    })
  };
}

test("backend traffic CSV headers reflect source enablement without changing legacy headers", () => {
  assert.deepEqual(outputHeaders([{ status: "rejected" }]), OUTPUT_HEADERS);
  const dataHeaders = outputHeaders([{
    status: "rejected",
    traffic_enrichment: publicTraffic({ dataForSeo: true, material: false })
  }]);
  assert(dataHeaders.includes("dataforseo_state"));
  assert(dataHeaders.includes("dataforseo_in_estimated_google_search_traffic"));
  assert.equal(dataHeaders.some((header) => header.startsWith("crux_")), false);
  assert.equal(dataHeaders.includes("traffic_attribution_text"), false);

  const bothHeaders = outputHeaders([{
    status: "rejected",
    traffic_enrichment: publicTraffic({ dataForSeo: true, crux: true })
  }]);
  assert(bothHeaders.includes("dataforseo_state"));
  assert(bothHeaders.includes("crux_state"));
  assert(bothHeaders.includes("traffic_license_urls"));
});

test("backend traffic CSV flattens metrics and safely emits attribution", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traffic-csv-"));
  const output = path.join(directory, "leads.csv");
  try {
    await writeOutput(output, [{
      status: "rejected",
      traffic_enrichment: publicTraffic({ dataForSeo: true, crux: true })
    }]);
    const [headers, values] = parseCsv(await fs.readFile(output, "utf8"));
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    assert.equal(row.dataforseo_worldwide_estimated_google_search_traffic, "12");
    assert.equal(row.dataforseo_in_estimated_google_search_traffic, "4");
    assert.equal(row.dataforseo_us_estimated_google_search_traffic, "");
    assert.equal(row.crux_largest_contentful_paint_p75_ms, "2400");
    assert.equal(row.traffic_sources, "dataforseo | crux");
    assert.equal(row.traffic_attribution_text, "'=provider attribution | CrUX attribution");
    assert.match(row.traffic_license_urls, /creativecommons/u);
    assert.equal(values.includes("[object Object]"), false);
    assert.equal(values.some((value) => value.includes("traffic-enrichment-public-v1")), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("backend traffic CSV rejects malformed semantic material before attribution", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traffic-csv-invalid-"));
  const output = path.join(directory, "leads.csv");
  try {
    const invalid = publicTraffic({ crux: true });
    invalid.crux.origin_metrics.observed_form_factor_fractions = {
      desktop: 1,
      phone: 1,
      tablet: 1
    };
    await assert.rejects(writeOutput(output, [{
      status: "rejected",
      traffic_enrichment: invalid
    }]), /Public traffic enrichment contract/u);
    await assert.rejects(fs.access(output));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("invalid traffic material preserves an existing CSV and creates no temporary output", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "traffic-csv-preserve-"));
  const output = path.join(directory, "leads.csv");
  const existing = "legacy,content\r\nkept,unchanged\r\n";
  try {
    await fs.writeFile(output, existing, "utf8");
    const invalid = publicTraffic({ crux: true });
    invalid.crux.origin_metrics.collection_period = {
      first_date: "2026-07-28",
      last_date: "2026-07-01"
    };

    await assert.rejects(writeOutput(output, [{
      status: "rejected",
      traffic_enrichment: invalid
    }]), /Public traffic enrichment contract/u);

    assert.equal(await fs.readFile(output, "utf8"), existing);
    assert.deepEqual(await fs.readdir(directory), ["leads.csv"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
