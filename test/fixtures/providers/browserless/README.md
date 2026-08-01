# Browserless Content fixture contract

Contract: `browserless-content-response-headers-v1`

Endpoint: `POST /content` (the `/chromium/content` convenience alias contract),
with a JSON request containing `url` and `gotoOptions`. The response body is
rendered `text/html`.

The adapter consumes these documented response values:

- `Content-Type`, which must identify HTML;
- `X-Response-Code`, the target site's HTTP response code; and
- `X-Response-URL`, the target site's final URL after redirects.

Browserless REST status, status text, target IP, and target port are not used as
store evidence. Unknown additive headers are ignored and cannot affect behavior.
Missing or malformed consumed values produce a typed, privacy-safe contract
error. The final URL must separately pass public-URL and verified-store-host
checks before rendered content is usable.

The fixtures are fictional, sanitized, and hand-maintained from the official
Browserless Content API and Request Configuration documentation as reviewed on
2026-08-01. They contain no token, customer data, or collected storefront data.
