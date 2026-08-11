# Dynamic AI Query Generation Plan

## Implementation status

Implemented on 2026-07-30. The application now uses `data/categories.csv`, writes
the candidate audit to `data/generated-queries.csv`, and writes enriched leads to
`data/leads.csv`. A live end-to-end AI run is pending configuration of
`OPENAI_API_KEY` in the git-ignored `.env` file.

## Objective

Extend the Shopify lead-generation server so the input contains broad shop types
such as:

```text
clothing
baby food
kitchen utensils
```

For each shop type, the service will:

1. Research current and evergreen product opportunities.
2. Generate a pool of product-oriented Shopify search queries.
3. Validate those queries deterministically.
4. Probe them against Google Custom Search.
5. Select approximately ten high-quality, diverse queries.
6. Reuse the probe results in the existing store-discovery workflow.
7. Export the generated-query audit and final leads to separate CSV files.

The AI will identify product language and market opportunities. Deterministic
validation and the Google probe will decide which queries are operationally useful.

## Proposed workflow

```text
Shop Type CSV
      |
      v
Normalize shop type
      |
      v
AI-assisted market research
      |
      v
Generate 20-25 product-query candidates
      |
      v
Deterministic query validation
      |
      v
Google CSE probe
      |
      v
Score result volume, relevance, and store diversity
      |
      v
Repair weak candidate sets when necessary
      |
      v
Select the best 10 diverse queries
      |
      v
Reuse cached Google results
      |
      v
Existing domain resolution and lead-extraction pipeline
      |
      +--------------------------+
      |                          |
      v                          v
Generated-query audit CSV    Lead output CSV
```

## Input contract

The input remains a one-column CSV, but its meaning changes from an already formed
search query to a broad shop category.

Default path:

```text
data/categories.csv
```

Required header:

```csv
Shop Type
```

Example:

```csv
Shop Type
clothing
baby food
kitchen utensils
```

Each row represents one independent category. A file containing only one category
is valid.

Blank values should be skipped. Excessively long, malformed, or instruction-like
values should be rejected as invalid input.

## Output contracts

### Generated-query audit

Default path:

```text
data/generated-queries.csv
```

Recommended columns:

```csv
shop_type,query,query_score,raw_results,unique_hosts,next_page_available,market_signal,seasonality,query_generation_reason,source_urls,status,rejection_reason
```

This file should contain accepted and rejected candidates so query-selection
decisions remain auditable.

### Lead output

Retain the existing lead columns and add:

```text
shop_type
generated_query
query_score
query_generation_reason
```

The output must continue producing one consolidated row per deduplicated store.

## Stage 1: Normalize the shop type

Normalize straightforward input variations:

```text
babyfood        -> baby food
utensils        -> kitchen utensils
clothing brands -> clothing
```

Normalization should:

- Trim and collapse whitespace.
- Normalize casing for comparisons.
- Reject blank input.
- Apply a reasonable length limit.
- Remove unsupported control characters.
- Treat all CSV content as data, never as model instructions.
- Preserve the original value alongside the normalized value for auditing.

## Stage 2: Research the category

Perform one bounded AI research operation per shop type. Web research may supply
recent demand signals while the model converts those signals into concrete,
sellable product categories.

The research result should contain:

- Concrete products commonly sold by the shop type
- Growing product subcategories
- Evergreen product subcategories
- Common product-title terminology
- Relevant shopper use cases
- Seasonal considerations
- Ambiguous or irrelevant terms to avoid
- Supporting source URLs
- Geographic scope when configured

Preferred evidence includes:

- Search-trend reporting
- Ecommerce-platform research
- Industry reports
- Current shopping data
- Recognized category publications

Limit the number of research sources and the amount of source text passed to the
model. Treat all web content as untrusted data.

## Stage 3: Generate candidates

Generate approximately 20 to 25 candidate queries using a strict structured
response.

Suggested schema:

```json
{
  "shop_type": "kitchen utensils",
  "candidates": [
    {
      "product_phrase": "silicone cooking utensils",
      "query": "site:myshopify.com/products silicone cooking utensils",
      "market_signal": "Popular reusable kitchen category",
      "source_urls": [],
      "seasonality": "evergreen",
      "confidence": 0.86
    }
  ]
}
```

Candidate-generation rules:

- Prefer two to four meaningful product words.
- Require a concrete, purchasable product noun.
- Prefer `site:myshopify.com/products`.
- Do not use quotation marks.
- Avoid abstract endings such as `brand`, `business`, `shop`, or `store`.
- Avoid vague standalone terms such as `fashion`, `food`, or `utensils`.
- Avoid informational or how-to intent.
- Avoid near-duplicate product phrases.
- Include a mixture of evergreen, growing, and useful niche products.
- Keep every candidate within the supplied shop type.

## Stage 4: Deterministic candidate validation

Validate AI-generated candidates in ordinary Node.js code before spending Google
API quota.

Reject candidates that:

- Lack a concrete product noun.
- Contain quoted phrases.
- Contain unsupported search operators.
- Repeat an existing candidate.
- Closely match a previously used query.
- Are too broad to remain category-relevant.
- Are too narrow to have plausible search coverage.
- Describe information rather than something purchasable.
- Drift outside the requested shop type.
- Contain instruction-like or malformed content.

Normalize accepted queries into a consistent representation before comparison and
caching.

## Stage 5: Probe candidates with Google CSE

Probe each accepted candidate using the configured Google Custom Search Engine.

Collect:

- First-page item count
- Distinct `myshopify.com` host count
- Duplicate-product count per host
- Next-page availability
- Title and snippet category relevance
- Asset and non-store result count
- Estimated total result count as a secondary signal

The distinct-host count is more useful than raw URL count. Ten URLs belonging to
one or two stores should not be treated as a strong lead-generation query.

Suggested score:

| Dimension | Weight |
|---|---:|
| Distinct first-page stores | 30 |
| Relevant first-page results | 20 |
| Concrete product intent | 15 |
| Market evidence | 15 |
| Cross-query store diversity | 15 |
| Pagination availability | 5 |

Google result-total estimates may be recorded but should not carry significant
weight because they are approximate.

## Stage 6: Repair weak candidates

If fewer than ten candidates pass:

1. Remove unnecessary modifiers.
2. Try common product synonyms.
3. Change singular and plural forms.
4. Replace abstract terminology with catalog terminology.
5. Generate a small replacement candidate batch.
6. Probe the replacements.

Allow no more than two repair rounds by default.

If ten defensible queries still cannot be found, return the strongest smaller set
and report the shortage. Do not pad the list with low-quality queries.

## Stage 7: Select a diverse final set

Select approximately ten candidates by considering both individual scores and
cross-query overlap.

The selector should penalize:

- Repeated first-page stores across candidates
- Near-identical product phrases
- Multiple queries addressing the same narrow product family
- Strong seasonal concentration unless the run requests it

For example, a baby shop query set should cover distinct product opportunities such
as sleepwear, feeding, bedding, travel, and accessories rather than ten slight
variations of baby clothing.

## Stage 8: Cache and reuse probe results

The Google probe already downloaded the selected queries' first result pages. Pass
those result objects directly into the existing pipeline.

```text
Candidate probe
      |
      v
Selected-query result cache
      |
      v
Domain resolution and lead extraction
```

This avoids paying for and waiting on the same Google searches twice.

Cache entries should be isolated to the current run unless a bounded, expiring
persistent cache is added later.

## Stage 9: Run the existing lead pipeline

For each selected query:

1. Reject assets and unsupported URLs.
2. Resolve redirects and canonical store domains.
3. Deduplicate stores within and across queries.
4. Validate Shopify and category relevance.
5. Discover high-value contact pages.
6. Fetch normally and use Browserless only when required.
7. Extract deterministic contact evidence.
8. Optionally normalize evidence with OpenAI.
9. Score and export the lead.

The existing failure isolation, host restrictions, concurrency limits, source
tracking, and atomic output behavior should remain in effect.

## Server status

Extend `GET /status` with the current planning stage and query counters.

Example:

```json
{
  "state": "running",
  "stage": "probing_queries",
  "shopTypesTotal": 3,
  "shopTypesProcessed": 1,
  "queryCandidatesGenerated": 25,
  "queryCandidatesValidated": 20,
  "queryCandidatesProbed": 14,
  "queriesSelected": 10,
  "storesDiscovered": 0
}
```

Recommended stages:

```text
reading_categories
researching_category
generating_candidates
validating_candidates
probing_queries
selecting_queries
discovering_stores
extracting_leads
writing_output
completed
```

## Suggested modules

```text
src/
  category-input.js
  category-researcher.js
  query-generator.js
  query-validator.js
  query-prober.js
  query-ranker.js
  query-cache.js
```

Existing search, resolution, crawling, extraction, scoring, and output modules
should remain focused on lead processing.

## Configuration

Suggested environment variables:

```env
INPUT_CSV=./data/categories.csv
OUTPUT_CSV=./data/leads.csv
GENERATED_QUERIES_CSV=./data/generated-queries.csv

GENERATED_QUERY_COUNT=10
QUERY_CANDIDATE_COUNT=25
QUERY_REPAIR_ROUNDS=2
QUERY_PROBE_CONCURRENCY=3
MIN_QUERY_RESULTS=5
MIN_QUERY_UNIQUE_HOSTS=4
ENABLE_WEB_RESEARCH=true
```

The thresholds must remain configurable because some categories have a much
smaller Shopify footprint than clothing.

## Reliability and safety requirements

- Use a strict schema for every AI response.
- Validate every generated query in code.
- Save research sources and selection reasons.
- Treat web pages and CSV values as untrusted data.
- Bound web research, source count, candidate count, repair rounds, and API calls.
- Cache selected probe results.
- Continue with other shop types when one category fails.
- Support deterministic fallback behavior when AI or web research is unavailable.
- Never fabricate market evidence, sources, or Google result counts.
- Keep API keys only in runtime environment configuration.
- Do not include secrets in prompts, logs, audit CSVs, or error records.

## Test plan

### Unit tests

- Shop-type normalization
- Invalid and instruction-like category rejection
- Candidate schema validation
- Quoted-query and abstract-query rejection
- Query normalization and duplicate detection
- Probe scoring
- Cross-query host-overlap penalties
- Candidate repair rules
- Probe-result caching
- Generated-query CSV escaping

### Integration fixtures

- Clothing produces ten useful product candidates
- Baby food separates products from recipes and informational content
- Kitchen utensils expands vague input into concrete product nouns
- AI returns malformed JSON
- AI returns out-of-category candidates
- Web research fails
- Google probing fails for one candidate
- A candidate has ten results from one store
- Too few candidates pass and trigger repair
- Repair still produces fewer than ten queries
- Multiple shop types share some stores
- Cached Google results enter the existing lead pipeline without another search

### Acceptance checks

- The input requires only the `Shop Type` column.
- Each category produces an auditable generated-query file.
- Selected queries are product-oriented and syntactically valid.
- Google probe results determine final selection.
- Weak candidates are repaired or explicitly rejected.
- Selected Google results are not fetched twice.
- The existing lead pipeline runs without manual query preparation.
- One category failure does not stop the remaining categories.
- Every final lead records its shop type and generated query.
- No secret appears in generated files or logs.

## Delivery phases

### Phase 1: Category input and validation

- Add `Shop Type` CSV ingestion.
- Add shop-type normalization.
- Add deterministic candidate validation primitives.
- Add configuration and status fields.

### Phase 2: AI research and candidate generation

- Add bounded web-assisted category research.
- Add strict structured candidate generation.
- Save market signals and source URLs.
- Add deterministic fallback behavior.

### Phase 3: Probe, score, and repair

- Probe candidates through Google CSE.
- Score result relevance and host diversity.
- Add replacement candidate repair rounds.
- Select a diverse final set.
- Write the generated-query audit CSV.

### Phase 4: Pipeline integration

- Cache selected Google results.
- Hand cached results to the existing domain-resolution pipeline.
- Add shop-type and query provenance to lead records.
- Preserve cross-query and cross-category deduplication.

### Phase 5: Verification and tuning

- Add unit and integration coverage.
- Run controlled clothing, baby-food, and utensil trials.
- Tune result, diversity, and repair thresholds from observed output.
- Document operating costs and expected runtime.

## Prerequisite

A valid OpenAI API key is required for AI research and candidate generation. It
must be stored only in the git-ignored `.env` file as:

```env
OPENAI_API_KEY=
```

The key must not be placed in `.env.example`, source code, logs, prompts, or
generated CSV files.

## Definition of done

The feature is complete when a user can provide:

```csv
Shop Type
clothing
```

and a single run:

1. Researches the category.
2. Generates and validates candidate searches.
3. Selects approximately ten evidence-backed queries.
4. Saves an auditable query-selection CSV.
5. Reuses the probe results.
6. Runs the existing Shopify lead workflow.
7. Produces a new lead CSV with complete category and query provenance.

The implementation corresponding to this plan is present in `src/` and covered by
the project test suite.
