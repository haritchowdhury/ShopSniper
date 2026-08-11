# Traffic Enrichment Service Comparison

## Objective

Compare third-party services that can add traffic or popularity signals to the
Shopify lead-generation workflow, with emphasis on cost, utility, bulk processing,
and coverage of smaller stores.

Pricing and product details were checked on July 30, 2026. Vendor pricing can
change, so the linked official pages should be checked again before purchasing.

## Recommendation

Use a tiered enrichment strategy:

1. Run DataForSEO for every qualified unique domain.
2. Add Google CrUX as a free supporting signal.
3. Calculate a provisional lead score.
4. Use Similarweb only for valuable or ambiguous leads if a coverage probe and
   commercial quote justify it.
5. Do not purchase Semrush solely for this workflow. Reconsider it only if its
   wider competitor, channel, and market-research capabilities will also be used.

The recommended initial combination is **DataForSEO plus CrUX**.

## Summary comparison

| Service | Cost model | What it measures | Utility for this workflow | Main limitation |
| --- | --- | --- | --- | --- |
| DataForSEO Labs | Pay as you go: approximately $0.012 per task plus $0.00012 per returned domain; $50 minimum top-up | Estimated Google organic, paid, featured-snippet, and local-pack traffic | Best cost-to-utility ratio for bulk lead scoring | It estimates search traffic, not total store traffic |
| Similarweb API | Quote-based subscription add-on or API-only package; usage consumes data credits | Estimated total visits, visitors, engagement, and traffic sources | Best direct approximation of overall website traffic | Non-public dollar pricing and weaker coverage for small sites |
| Semrush Trends API | Paid monthly API plan; Basic public purchase pricing was approximately $1,000/month when checked, while Premium is quote-based | Visits, users, engagement, rank, channels, and broader market intelligence | Strong all-in-one competitive research capability | Excessive fixed cost for traffic enrichment alone |
| Google CrUX | API access is free; BigQuery usage may incur normal Google Cloud query charges | Real-user performance and coarse popularity information | Useful supporting evidence and a free popularity proxy | Does not provide monthly visit counts |

## DataForSEO Labs

### Cost

The current Google Labs pricing for standard endpoints is:

- $0.012 per task
- $0.00012 per returned item or domain
- $50 minimum account top-up
- Unused account funds do not expire

The Bulk Traffic Estimation endpoint accepts up to 1,000 domains in one request.

For the recent 78-domain eyewear run, the expected endpoint cost is:

```text
$0.012 + (78 × $0.00012) = $0.02136
```

For 1,000 domains:

```text
$0.012 + (1,000 × $0.00012) = $0.132
```

These calculations assume Bulk Traffic Estimation is billed under the current
"all other endpoints" Google Labs rate and that all domains fit into one task.
The API response includes its actual charged cost, which should be logged.

### Utility

DataForSEO estimates monthly traffic from the keywords for which a domain ranks,
their search volumes, and expected click-through rates. It can return separate
organic, paid, featured-snippet, and local-pack estimates.

This is useful for:

- Measuring organic discoverability
- Detecting brands with meaningful search demand
- Estimating SEO maturity
- Processing the entire deduplicated domain set inexpensively

It should not be presented as total monthly traffic. A successful Shopify brand
driven primarily by Instagram, TikTok, affiliates, email, or direct visits may
have a low DataForSEO estimate despite meaningful revenue.

Recommended output labels:

```text
organic_traffic_estimate
paid_search_traffic_estimate
organic_keyword_count
```

Official references:

- Bulk Traffic Estimation:
  https://docs.dataforseo.com/v3/dataforseo_labs-google-bulk_traffic_estimation-live/
- Google Labs pricing:
  https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api
- Minimum payment:
  https://dataforseo.com/help-center/minimum-payment
- July 2026 pricing update:
  https://dataforseo.com/update/pricing-update-in-dataforseo-apis

## Similarweb API

### Cost

Similarweb sells API access as a subscription add-on or an API-only package.
Dollar pricing is not public and requires a commercial quote.

The Traffic and Engagement endpoint consumes one data credit per metric per
result. Requesting all eight supported metrics consumes up to eight credits per
domain and time result.

For 78 domains and one monthly result:

- Visits only: 78 credits
- Visits plus three engagement metrics: 312 credits
- All eight metrics: 624 credits

These figures describe credit consumption, not dollar cost.

### Utility

Similarweb provides the closest match to overall website traffic:

- Total visits
- Unique visitors
- Page views
- Bounce rate
- Pages per visit
- Average visit duration
- New and returning users
- Traffic sources and other competitive intelligence through additional endpoints

It is therefore the strongest premium option when the question is, "How large is
this store's overall audience?"

The principal risk is small-store coverage. Similarweb states that low-traffic
sites can return "not enough data," and some desktop-dependent features do not
display data below approximately 5,000 monthly desktop visits. This may affect
many emerging Shopify brands.

Before purchasing, run a controlled probe against 100 to 200 known domains and
measure:

- Percentage of domains with non-null traffic
- Coverage by existing lead-quality band
- Stability across two or three months
- Cost per usable result
- Correlation with known high-quality brands

Official references:

- Traffic and Engagement endpoint:
  https://docs.similarweb.com/api-v5/similarweb-api/website-analysis-api/website-performance/traffic-and-engagement
- API access:
  https://developers.similarweb.com/docs/similarweb-web-traffic-api
- Credit model:
  https://docs.similarweb.com/api-v5/integrations
- Small-site coverage:
  https://support.similarweb.com/hc/en-us/articles/32914267250077-Similarweb-s-Data-Accuracy

## Semrush Trends API

### Cost

Semrush Trends has Basic and Premium API plans. Basic can be purchased without a
separate Semrush subscription. Premium requires a sales quote.

When checked, Semrush's public Trends API purchase page showed approximately
$1,000 per month for the Basic allocation. This price should be confirmed directly
before purchase because checkout pricing and regional terms can change.

The current API documentation states:

- A default monthly allowance of 10,000 Trends API requests
- Traffic Summary costs one API unit per returned line
- Up to 200 domains can be submitted to one Traffic Summary request
- Empty Traffic Summary results are not charged
- No free Trends API trial

The 78-domain eyewear dataset could therefore be submitted in one request and
would consume 78 units if every domain returned a result.

### Utility

Traffic Summary can return:

- Visits and users
- Traffic rank
- Desktop and mobile visits
- Bounce rate
- Average visit duration
- Pages per visit
- Direct, referral, search, social, email, display, and AI traffic channels
- A data-accuracy field

Premium adds daily and weekly traffic, geographic distribution, top pages,
audience insights, demographics, and other market-research datasets.

Semrush is useful when traffic enrichment is only one part of a broader research
system. It is difficult to justify for the current pipeline alone because the
fixed monthly commitment is vastly larger than DataForSEO's expected usage cost.

Semrush also restricts caching API data for more than one month without express
written permission. That constraint must be considered before exposing enriched
data through a customer-facing product.

Official references:

- Trends API overview:
  https://developer.semrush.com/api/v3/trends/overview/
- Trends API reference and unit costs:
  https://developer.semrush.com/api/v3/trends/api-reference/
- API access and allowances:
  https://developer.semrush.com/api/v3/get-started/api-access/
- API usage restrictions:
  https://developer.semrush.com/api/v4/introduction/api-usage-restrictions/

## Google CrUX

### Cost

The Chrome UX Report API provides free REST access with a Google Cloud API key.
The public BigQuery dataset can also be queried, subject to normal BigQuery usage
and billing rules.

### Utility

CrUX contains aggregated observations from real Chrome users. The API primarily
returns performance metrics such as Core Web Vitals, not traffic counts.

The BigQuery dataset includes a coarse popularity rank measured from total
navigations. Bands include ranges such as top 1,000, top 5,000, top 10,000,
top 50,000, and progressively larger groups.

Useful interpretations are:

```text
CrUX record exists -> the origin had enough eligible Chrome usage for inclusion
No CrUX record     -> traffic is unknown; do not interpret this as zero traffic
Popularity band    -> broad relative popularity, not monthly visits
```

CrUX can also add store-performance signals that may help qualify operational
maturity, but performance should remain separate from popularity.

Official references:

- CrUX API:
  https://developer.chrome.com/docs/crux/api
- CrUX popularity metric:
  https://developer.chrome.com/docs/crux/methodology/metrics
- CrUX BigQuery:
  https://developer.chrome.com/docs/crux/bigquery

## Proposed enrichment fields

The lead CSV can be extended with:

```csv
organic_traffic_estimate
paid_search_traffic_estimate
organic_keyword_count
crux_available
crux_popularity_band
crux_lcp_p75
crux_inp_p75
total_traffic_estimate
traffic_provider
traffic_confidence
traffic_checked_at
```

`total_traffic_estimate` should remain empty unless it came from a total-traffic
provider such as Similarweb or Semrush. DataForSEO organic traffic must not be
silently substituted into that column.

## Proposed scoring approach

Traffic should complement, not replace, the current lead-quality signals.

```text
lead score =
  existing Shopify/store/contact quality
  + organic visibility band
  + optional total traffic band
  + CrUX popularity evidence
  - low-confidence or stale-data penalty
```

Recommended traffic confidence values:

- `high`: total-traffic provider returned a result with a strong accuracy signal
- `medium`: DataForSEO returned meaningful ranked-keyword and traffic evidence
- `low`: only CrUX existence or a coarse popularity band is available
- `unknown`: no provider returned usable information

Cache traffic results by normalized root domain for approximately 30 days. This
reduces cost and fits Semrush's standard one-month caching restriction if Semrush
is later adopted.

## Final ranking

1. **DataForSEO** — best first integration and best cost-to-utility ratio
2. **Google CrUX** — useful free supporting evidence
3. **Similarweb** — best premium total-traffic signal, subject to coverage testing
4. **Semrush** — powerful but presently unnecessary for this workflow

