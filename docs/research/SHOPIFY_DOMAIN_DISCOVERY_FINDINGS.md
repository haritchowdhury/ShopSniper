# Shopify Store Discovery Through `myshopify.com`

**Workflow reviewed:** `My workflow 3.json` and `My workflow 4.json`  
**Report date:** July 30, 2026

## Executive summary

The workflow can discover Shopify stores that use custom domains even when the Google result contains a Shopify-assigned `myshopify.com` URL.

The definitive conclusions are:

1. Searching for `myshopify` does **not** restrict results to stores without custom domains.
2. Shopify stores retain a `myshopify.com` identity after connecting a custom domain.
3. A Google result hosted on `myshopify.com` does **not** prove that the merchant lacks a custom domain.
4. A query using `site:myshopify.com` can deliberately locate indexed Shopify-assigned URLs.
5. The custom domain can often be recovered by following redirects or reading the page's canonical URL.
6. The current workflow requests only one result per query, so the first result returned by its configured Google Custom Search Engine is especially important.

## How the workflow performs discovery

`My workflow 4` reads a column named `Search Query` from Google Sheets and passes it to `My workflow 3` as `Query`.

`My workflow 3` sends that value directly to the Google Custom Search JSON API:

```text
q = {{ $json.Query }}
num = 1
```

This means:

- Google receives the sheet query without the workflow adding a Shopify filter.
- Any Shopify restriction must be written into the sheet query itself.
- Only the first search result is requested.
- The workflow extracts the hostname from the returned result and attempts to crawl its sitemap and contact-related pages.

Relevant locations in the exported workflows:

- `My workflow 4.json`, line 57: maps the Google Sheet's `Search Query` field to `Query`.
- `My workflow 3.json`, lines 36–37: passes `Query` to Google as `q`.
- `My workflow 3.json`, lines 40–41: sets `num` to `1`.
- `My workflow 3.json`, line 102: extracts the root hostname from Google's result URL.

## What Shopify does with domains

Every Shopify store receives a `myshopify.com` domain. Shopify uses the original domain as a permanent store identifier, including for authentication, support, and application integrations.

When a merchant adds a custom domain and makes it the primary domain, Shopify can redirect other connected domains, including the storefront's `myshopify.com` domain, to the primary domain. However, the Shopify identity remains assigned to the store.

Consequently, any of the following can happen:

- The `myshopify.com` URL redirects to the custom domain.
- The `myshopify.com` page remains directly accessible but declares the custom domain as canonical.
- Google retains an older `myshopify.com` URL in its index.
- Google indexes a Shopify-hosted product, file, or other resource even though customers normally use the custom domain.

Therefore, the presence of `myshopify.com` in a result cannot be used as a “no custom domain” test.

## Meaning of different Google queries

### Bare keyword

```text
myshopify herbs spices
```

Here, `myshopify` is an ordinary search term. This does not guarantee that the returned URL will be on `myshopify.com`.

### Shopify-domain restriction

```text
site:myshopify.com herbs spices
```

The `site:` operator restricts results to indexed URLs under `myshopify.com`. It still does not prove that the associated store lacks a custom domain.

### More precise category discovery

Quoted phrases can reduce irrelevant results:

```text
site:myshopify.com "low sodium" "salt free seasoning"
```

This is the query that produced the verified example below.

## Verified example: Spiceology

### Store identity

| Field | Verified value |
|---|---|
| Store | Spiceology |
| Product category | Spices, seasoning blends, and salt-free seasoning |
| Shopify-assigned domain | `https://spiceology.myshopify.com/` |
| Custom domain | `https://spiceology.com/` |

### Query tested

```text
site:myshopify.com "low sodium" "salt free seasoning"
```

This query was sent through the same Google Custom Search Engine configured in the exported n8n workflow, with `num=1`.

At the time of testing, the API reported five matching results. Its first result was:

```text
Title:
Buy Everything Bagel Seasoning | Salt-Free Sesame & Garlic Blend

URL:
https://spiceology.myshopify.com/products/everything-bagel-salt-free-seasoning
```

### Custom-domain verification

The returned Shopify product page declares the following canonical URL:

```html
<link
  rel="canonical"
  href="https://spiceology.com/products/everything-bagel-salt-free-seasoning"
>
```

The Shopify homepage also declares the custom store homepage as canonical:

```html
<link rel="canonical" href="https://spiceology.com/">
```

Verified pages:

- Shopify homepage: <https://spiceology.myshopify.com/>
- Custom homepage: <https://spiceology.com/>
- Shopify product URL: <https://spiceology.myshopify.com/products/everything-bagel-salt-free-seasoning>
- Custom product URL: <https://spiceology.com/products/everything-bagel-salt-free-seasoning>

This is direct evidence that a query restricted to `myshopify.com` can return a store that operates with a custom domain.

## Verification method

The example was established through the following process:

1. Constructed a query containing a `myshopify.com` restriction and specific product-category phrases.
2. Sent the query through the workflow's configured Google Custom Search Engine.
3. Used the same one-result limit configured in the workflow.
4. Recorded the first result returned by the API.
5. Opened the returned `myshopify.com` product page.
6. Inspected the page's canonical URL.
7. Verified that the canonical URL used the custom `spiceology.com` domain.
8. Opened the custom-domain product and homepage to confirm the store identity and category.

## Definitive answer to the original question

**No—the workflow does not find only Shopify stores that lack custom domains.**

It can find:

- stores that still use `myshopify.com` as their public domain;
- stores that use a custom primary domain;
- stores whose Shopify URL redirects to a custom domain;
- stores whose Shopify URL remains accessible but points search engines to a custom canonical domain;
- stale or alternate Shopify URLs retained in Google's index;
- Shopify-hosted product pages, files, or other resources.

Separately, **yes—Shopify stores retain a Shopify-assigned identity after adding a custom domain.**

## Recommended query patterns

### Broad category discovery

```text
site:myshopify.com "PRODUCT CATEGORY"
```

Example:

```text
site:myshopify.com "salt free seasoning"
```

### More precise category discovery

```text
site:myshopify.com "CATEGORY PHRASE 1" "CATEGORY PHRASE 2"
```

Verified example:

```text
site:myshopify.com "low sodium" "salt free seasoning"
```

### Product-page discovery

```text
site:myshopify.com/products "PRODUCT CATEGORY"
```

Example:

```text
site:myshopify.com/products "salt free seasoning"
```

### Collection-page discovery

```text
site:myshopify.com/collections "PRODUCT CATEGORY"
```

Example:

```text
site:myshopify.com/collections "skin care"
```

Product and collection searches are generally more focused than searching all pages under `myshopify.com`.

## How to recover or classify the custom domain

For every returned `myshopify.com` URL, the workflow can inspect:

1. **Final URL after redirects**  
   If the request finishes on a non-`myshopify.com` hostname, that hostname is the custom primary domain.

2. **Canonical link**  
   Read:

   ```html
   <link rel="canonical" href="...">
   ```

   A non-`myshopify.com` canonical hostname is strong evidence of the store's preferred custom domain.

3. **Sitemap URLs**  
   Shopify sitemaps frequently use the primary or canonical domain. The hostnames found in `sitemap.xml` can reveal the custom domain.

4. **Internal navigation links**  
   Homepage, product, collection, contact, and policy links may use the custom hostname.

These checks should be combined. A missing redirect does not prove that no custom domain exists, as demonstrated by stores whose Shopify URL remains accessible while the custom domain is canonical.

## Search and workflow limitations

### One-result limit

The current workflow uses:

```text
num = 1
```

This means each sheet row can discover at most one Google result. It significantly reduces coverage and makes the workflow sensitive to small ranking changes.

### Ranking variability

Results can vary because of:

- Google index changes;
- the configured Programmable Search Engine;
- geographic location;
- language;
- query wording;
- personalization in ordinary Google Search;
- category competition;
- redirects and canonicalization.

A query that ranks a store first in ordinary Google Search might not rank it first in the workflow's Custom Search Engine. Queries should be tested through the actual configured API.

### Incomplete Shopify coverage

This technique finds only URLs indexed by Google. It will miss:

- password-protected stores;
- stores blocked from indexing;
- newly launched stores not yet indexed;
- stores whose `myshopify.com` URLs have been fully replaced in Google's index by custom canonical URLs;
- stores omitted by the configured Custom Search Engine.

### False positives and non-store results

Searches can return:

- theme demonstrations;
- inactive stores;
- sold-out product pages;
- Shopify CDN files;
- PDFs and other assets;
- development or test stores;
- directories discussing Shopify stores.

The workflow should validate that the final target is a functioning storefront before treating it as a lead.

## Recommended workflow improvements

1. Increase `num` from `1` to a larger value, such as `10`.
2. Add pagination with Google's `start` parameter.
3. Normalize and deduplicate stores by Shopify hostname and final custom hostname.
4. Record all of the following separately:
   - Google result URL;
   - original `myshopify.com` hostname;
   - final URL after redirects;
   - canonical URL;
   - detected custom domain.
5. Reject non-store resources such as PDFs and static CDN files.
6. Check storefront status before crawling contact information.
7. Store the query that produced every lead for auditability.
8. Test important queries through the configured Custom Search API rather than assuming ordinary Google rankings will match.

## Security observation

The exported workflow files contain service credentials in plain text, including Google and Browserless credentials. These values should be rotated and moved into n8n's credential store or environment-backed secrets. They should not remain embedded in workflow exports.

## Sources

- Shopify Help Center, “Removing domains”:  
  <https://help.shopify.com/en/manual/domains/removing-domains>
- Shopify Help Center, “Change your primary domain”:  
  <https://help.shopify.com/en/manual/domains/domain-type/change-primary-domain>
- Shopify Help Center, “Domains”:  
  <https://help.shopify.com/en/manual/domains/custom-domains/about-custom-domains>
- Google Search Help, “Refine Google searches”:  
  <https://support.google.com/websearch/answer/2466433>
- Google Search Central, “Redirects and Google Search”:  
  <https://developers.google.com/search/docs/crawling-indexing/301-redirects>
- Google Custom Search JSON API:  
  <https://developers.google.com/custom-search/v1/>
- Verified Spiceology custom-domain product:  
  <https://spiceology.com/products/everything-bagel-salt-free-seasoning>

