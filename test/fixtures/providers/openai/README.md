# OpenAI normalization fixture contract

Contract: `openai-chat-completions-shopify-lead-v1`

Endpoint: `POST /v1/chat/completions`, non-streaming Chat Completions with
`response_format.type=json_schema` and `strict=true`.

The fixtures are sanitized, fictional, hand-maintained contract examples based
on the public OpenAI Structured Outputs guide and Chat Completions API reference.
They are not captured provider payloads and contain no keys, tokens, customer
data, or collected contact values.

Consumed outer response fields:

- `object`, exactly `chat.completion`;
- `choices`, exactly one choice;
- `choices[0].index`, exactly `0`;
- `choices[0].finish_reason`, which must be `stop`;
- `choices[0].message.role`, exactly `assistant`;
- `choices[0].message.content`, a JSON string matching the strict lead schema;
- `choices[0].message.refusal`, which must be `null`.

Known provider metadata such as `id`, `created`, `model`, `usage`,
`system_fingerprint`, `service_tier`, `logprobs`, message `annotations`, and
unknown additive outer fields is intentionally ignored. It cannot affect lead
behavior. Missing or malformed consumed fields cause a typed, privacy-safe
contract error.

The inner lead object requires exactly `store_url`, `store_name`, `email`,
`phone`, `contact_url`, `social_profiles`, and `additional_information`.
Unknown inner fields are rejected because the request schema sets
`additionalProperties=false`.
