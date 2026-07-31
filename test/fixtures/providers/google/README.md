# Google Custom Search fixture contract

Contract: `google-custom-search-v1`

The adapter consumes `kind`, optional `items`,
`searchInformation.totalResults`, and optional `queries.nextPage`. Each consumed
item requires `title`, `link`, and `snippet` at the documented path. Additive
provider metadata is ignored, while missing or malformed consumed fields produce
a typed, privacy-safe contract error.

The JSON fixtures are fictional, sanitized, and hand-maintained. They contain no
API key, search-engine identifier, customer data, or collected contact values.
