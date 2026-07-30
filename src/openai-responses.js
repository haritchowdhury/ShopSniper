import { requestText } from "./http-client.js";

function outputText(payload) {
  const text = (payload.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .filter((item) => item?.type === "output_text")
    .map((item) => item.text || "")
    .join("");
  if (text) return text;

  const refusal = (payload.output || [])
    .flatMap((item) => item?.content || [])
    .find((item) => item?.type === "refusal");
  if (refusal) throw new Error(`OpenAI refused the query-planning request: ${refusal.refusal}`);
  throw new Error("OpenAI returned no structured text output");
}

function sourceUrls(payload) {
  const urls = [];
  for (const item of payload.output || []) {
    for (const source of item?.action?.sources || []) {
      if (typeof source?.url === "string") urls.push(source.url);
    }
  }
  return [...new Set(urls)].filter((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });
}

export async function createStructuredResponse(
  {
    name,
    schema,
    system,
    input,
    config,
    webSearch = false
  },
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
    text: {
      format: {
        type: "json_schema",
        name,
        strict: true,
        schema
      }
    },
    max_output_tokens: config.queryMaxOutputTokens,
    store: false
  };

  if (webSearch) {
    body.tools = [{
      type: "web_search",
      search_context_size: config.webSearchContextSize
    }];
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

  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error("OpenAI returned invalid JSON");
  }
  if (payload.error) {
    throw new Error(`OpenAI query planning failed: ${payload.error.message || "unknown error"}`);
  }

  let value;
  try {
    value = JSON.parse(outputText(payload));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("OpenAI returned malformed structured output");
    }
    throw error;
  }
  return { value, sourceUrls: sourceUrls(payload) };
}
