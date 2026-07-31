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

## Query-planning Responses contract

Contract: `openai-responses-query-planning-v1`

Endpoint: `POST /v1/responses`, non-streaming Responses API with
`text.format.type=json_schema` and `strict=true`.

The adapter requires a completed `status`, exactly one message item, exactly one
non-empty `output_text` content item, and strict JSON parsing of the generated
research/query object. Refusal content and incomplete responses are explicit
typed failures. When web search is enabled, consumed source URLs come only from
`output[type=web_search_call].action.sources[].url`.

Additive outer provider metadata and unconsumed output item types are ignored.
Missing or malformed consumed fields fail safely. The fixtures are fictional and
contain no provider credentials, customer data, or collected lead values.
