# Clothing Lead Query Research

Research and live search validation performed on July 30, 2026.

## Objective

Develop a second clothing query dataset that:

- Does not repeat any of the five queries in `data/input.csv`.
- Reflects current apparel demand signals rather than generic brand phrases.
- Matches terminology likely to appear on indexed Shopify product pages.
- Avoids quoted phrases, which caused three earlier searches to return no results.
- Produces enough first-page results and distinct store domains for lead generation.

## Market signals

The shortlist uses several complementary signals:

- Shopify identifies sweatshirts as a strong search-growth category, leggings and
  shorts as activewear demand drivers, and overshirts as a growing jacket format.
- Google Shopping reported breakout interest in floral corset dresses and wrap
  skirts.
- Google Trends reported all-time-high interest in boho apparel and listed tiered
  maxi skirts among the leading boho items.
- Google's 2026 fashion-search reporting identified nostalgia-driven demand,
  including babydoll tops and palazzo pants.
- McKinsey reports that active lifestyles have become part of consumer identity,
  supporting product-specific sportswear searches.

Sources:

- [Shopify: Trending Products for 2026](https://www.shopify.com/blog/trending-products)
- [Google Shopping: Spring 2025 Search Trends](https://blog.google/products-and-platforms/products/shopping/google-shopping-spring-2025-trends/)
- [Google Trends: Spring Fashion](https://trends.withgoogle.com/trends/us/spring-fashion/)
- [Google New Zealand: 2026 Fashion Search Trends](https://blog.google/intl/en-nz/products/explore-get-answers/fashion-trends/)
- [McKinsey: Sporting Goods Industry Trends](https://www.mckinsey.com/industries/retail/our-insights/sporting-goods-industry-trends)
- [McKinsey: State of Fashion 2026](https://www.mckinsey.com/industries/retail/our-insights/state-of-fashion)

## Query design

Every query uses:

```text
site:myshopify.com/products PRODUCT PHRASE
```

This is intentionally different from the earlier quoted-brand formulation:

- Product terms are more likely to exist in titles, handles, and product copy.
- Omitting quotation marks allows Google to match natural word variations.
- Restricting to `/products` avoids themes, documentation, and most non-store pages.
- The pipeline resolves product URLs to store identities and deduplicates repeated
  products before crawling.

## Live Custom Search validation

Each shortlisted query returned ten items from the configured Google Custom Search
Engine. The distinct-host count measures diversity before redirect resolution and
cross-query deduplication.

| Query | Estimated indexed results | First-page items | Distinct first-page hosts |
|---|---:|---:|---:|
| `barrel jeans` | 2,910 | 10 | 10 |
| `oversized sweatshirt` | 14,300 | 10 | 9 |
| `running shorts` | 46,800 | 10 | 9 |
| `outdoor overshirt` | 95 | 10 | 9 |
| `boho maxi skirt` | 1,900 | 10 | 9 |
| `babydoll top` | 5,260 | 10 | 9 |
| `wrap skirt` | 15,100 | 10 | 8 |
| `palazzo pants` | 20,100 | 10 | 8 |
| `flare leggings` | 7,550 | 10 | 6 |
| `floral corset dress` | 2,740 | 10 | 5 |

Google's result totals are estimates and can change. First-page item and hostname
counts are the more useful operational measures.

## Export

The final import-ready file is:

```text
data/clothing-market-queries-v2.csv
```

It contains exactly the required `Search Query` header and ten new rows. The
existing `data/input.csv` remains unchanged.
