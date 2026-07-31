import { z } from "zod";
import { requestText } from "./http-client.js";

export const OPENAI_RESPONSES_CONTRACT_VERSION = "openai-responses-query-planning-v1";

const responseEnvelopeSchema = z.object({
  status: z.enum(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"]),
  incomplete_details: z.object({ reason: z.string() }).passthrough().nullable().optional(),
  output: z.array(z.object({ type: z.string() }).passthrough())
}).passthrough();

const messageItemSchema = z.object({
  type: z.literal("message"),
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("output_text"), text: z.string() }).passthrough(),
    z.object({ type: z.literal("refusal"), refusal: z.string() }).passthrough()
  ]))
}).passthrough();

const webSearchItemSchema = z.object({
  type: z.literal("web_search_call"),
  action: z.object({
    sources: z.array(z.object({ url: z.string() }).passthrough())
  }).passthrough()
}).passthrough();

export class OpenAiResponsesContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenAiResponsesContractError";
    this.code = code;
    this.contractVersion = OPENAI_RESPONSES_CONTRACT_VERSION;
  }
}

function contractError(code, message) {
  return new OpenAiResponsesContractError(code, message);
}

function parsePayload(body) {
  let payload;
  try {
    payload = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    throw contractError("invalid_json", "OpenAI Responses payload was not valid JSON");
  }
  if (payload?.error) {
    throw contractError("provider_error", "OpenAI query planning returned a provider error");
  }
  const parsed = responseEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw contractError(
      "response_shape_mismatch",
      "OpenAI Responses payload did not match the query-planning v1 contract"
    );
  }
  if (parsed.data.status === "incomplete") {
    throw contractError(
      `incomplete_${parsed.data.incomplete_details?.reason || "unknown"}`,
      "OpenAI query-planning output was incomplete"
    );
  }
  if (parsed.data.status !== "completed") {
    throw contractError("response_not_completed", "OpenAI query-planning output did not complete");
  }
  return parsed.data;
}

export function parseStructuredResponse(body) {
  const payload = parsePayload(body);
  const messageItems = payload.output.filter(({ type }) => type === "message");
  if (messageItems.length !== 1) {
    throw contractError("message_count_mismatch", "OpenAI returned an unexpected message count");
  }
  const message = messageItemSchema.safeParse(messageItems[0]);
  if (!message.success) {
    throw contractError("message_shape_mismatch", "OpenAI message output did not match the v1 contract");
  }
  const refusal = message.data.content.find(({ type }) => type === "refusal");
  if (refusal) throw contractError("refusal", "OpenAI refused the query-planning request");
  const textItems = message.data.content.filter(({ type }) => type === "output_text");
  if (textItems.length !== 1 || !textItems[0].text) {
    throw contractError("output_text_mismatch", "OpenAI returned no single structured text output");
  }

  let value;
  try {
    value = JSON.parse(textItems[0].text);
  } catch {
    throw contractError("malformed_structured_output", "OpenAI structured output was not valid JSON");
  }

  const urls = [];
  for (const item of payload.output.filter(({ type }) => type === "web_search_call")) {
    const parsed = webSearchItemSchema.safeParse(item);
    if (!parsed.success) {
      throw contractError(
        "web_search_shape_mismatch",
        "OpenAI web-search sources did not match the v1 contract"
      );
    }
    for (const { url } of parsed.data.action.sources) {
      try {
        const parsedUrl = new URL(url);
        if (["http:", "https:"].includes(parsedUrl.protocol)) urls.push(parsedUrl.href);
      } catch {
        throw contractError("invalid_source_url", "OpenAI returned an invalid research source URL");
      }
    }
  }
  return { value, sourceUrls: [...new Set(urls)] };
}

export async function createStructuredResponse(
  { name, schema, system, input, config, webSearch = false },
  { request = requestText } = {}
) {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is not configured");

  const body = {
    model: config.queryGenerationModel,
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(input) }
    ],
    reasoning: { effort: config.queryReasoningEffort },
    text: { format: { type: "json_schema", name, strict: true, schema } },
    max_output_tokens: config.queryMaxOutputTokens,
    store: false
  };
  if (webSearch) {
    body.tools = [{ type: "web_search", search_context_size: config.webSearchContextSize }];
    body.tool_choice = "required";
    body.include = ["web_search_call.action.sources"];
  }

  const response = await request("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    timeoutMs: config.queryGenerationTimeoutMs,
    retries: 1,
    maxBytes: 2_000_000
  });
  return parseStructuredResponse(response.body);
}
