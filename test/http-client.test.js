import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpResponseSizeLimitError,
  requestText
} from "../src/http-client.js";

function streamingResponse(chunks, { contentLength, status = 200 } = {}) {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (reads >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunks[reads]));
      reads += 1;
    },
    cancel() {
      cancelled = true;
    }
  }, { highWaterMark: 0 });
  const headers = contentLength == null ? {} : { "content-length": String(contentLength) };
  return {
    response: new Response(body, { status, headers: { "content-type": "text/html", ...headers } }),
    counts: () => ({ reads, cancelled })
  };
}

test("declared oversized responses are cancelled before body reads", async () => {
  const fixture = streamingResponse(["not-read"], { contentLength: 100, status: 503 });
  let fetchCalls = 0;
  await assert.rejects(
    requestText("https://fixture.invalid/", {
      maxBytes: 10,
      retries: 2,
      validatePublic: false,
      fetchImpl: async () => {
        fetchCalls += 1;
        return fixture.response;
      }
    }),
    (error) => error instanceof HttpResponseSizeLimitError &&
      error.code === "HTTP_RESPONSE_SIZE_LIMIT"
  );
  assert.equal(fetchCalls, 1);
  assert.deepEqual(fixture.counts(), { reads: 0, cancelled: true });
});

test("unknown-length responses stop and cancel as soon as streamed bytes exceed the cap", async () => {
  const fixture = streamingResponse(["12345", "67890", "extra-unread"]);
  await assert.rejects(
    requestText("https://fixture.invalid/", {
      maxBytes: 9,
      retries: 0,
      validatePublic: false,
      fetchImpl: async () => fixture.response
    }),
    HttpResponseSizeLimitError
  );
  assert.deepEqual(fixture.counts(), { reads: 2, cancelled: true });
});

test("the byte cap accepts exact bounded UTF-8 and counts bytes rather than characters", async () => {
  const fixture = streamingResponse(["é", "ok"]);
  const result = await requestText("https://fixture.invalid/", {
    maxBytes: 4,
    retries: 0,
    validatePublic: false,
    fetchImpl: async () => fixture.response
  });
  assert.equal(result.body, "éok");
  assert.deepEqual(fixture.counts(), { reads: 2, cancelled: false });
});
