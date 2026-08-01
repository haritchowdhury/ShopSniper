import assert from "node:assert/strict";
import test from "node:test";
import { extractContactEvidence } from "../src/contact-extractor.js";
import { assessPageResponse, fetchPage } from "../src/page-fetcher.js";

function storefrontHtml(text = "Specialist eyewear frames and lenses") {
  return `<html><body><script src="/cdn/shop/theme.js"></script>${text.repeat(8)}</body></html>`;
}

test("ordinary usable storefront HTML does not invoke Browserless", async () => {
  let calls = 0;
  const response = await fetchPage("https://8.8.8.8/", {
    requestTimeoutMs: 1000,
    browserlessUrl: "https://browserless.example/content",
    browserlessToken: "fixture-token",
    browserlessFallbackToken: ""
  }, {
    purpose: "storefront",
    request: async () => {
      calls += 1;
      return {
        body: storefrontHtml(),
        finalUrl: "https://8.8.8.8/",
        status: 200,
        contentType: "text/html"
      };
    }
  });
  assert.equal(calls, 1);
  assert.equal(response.rendered, false);
  assert.equal(response.renderAttempted, false);
});

test("a JavaScript shell invokes Browserless and returns rendered evidence", async () => {
  let calls = 0;
  const response = await fetchPage("https://8.8.8.8/", {
    requestTimeoutMs: 1000,
    browserlessUrl: "https://browserless.example/content",
    browserlessToken: "fixture-token",
    browserlessFallbackToken: ""
  }, {
    purpose: "storefront",
    request: async () => {
      calls += 1;
      return calls === 1
        ? {
            body: "<html><body>Please enable JavaScript to view this shop</body></html>",
            finalUrl: "https://8.8.8.8/",
            status: 200,
            contentType: "text/html"
          }
        : {
            body: storefrontHtml(),
            finalUrl: "https://browserless.example/content",
            status: 200,
            contentType: "text/html"
          };
    }
  });
  assert.equal(calls, 2);
  assert.equal(response.rendered, true);
  assert.equal(response.fetchAssessment.usable, true);
  assert.equal(response.ordinaryAssessment.reason, "javascript_or_consent_shell");
});

test("challenge and password pages remain distinguishable", () => {
  const challenge = assessPageResponse({
    body: "<html><body>Checking your browser. Verify you are human.</body></html>",
    contentType: "text/html"
  }, { purpose: "storefront" });
  const password = assessPageResponse({
    body: `<html><body class="password">${"Opening soon. Enter using password. ".repeat(8)}</body></html>`,
    contentType: "text/html"
  }, { purpose: "storefront" });
  assert.equal(challenge.reason, "challenge_page");
  assert.equal(challenge.challenge, true);
  assert.equal(password.passwordProtected, true);
  assert.equal(password.challenge, false);
});

test("Browserless uses the second configured token when the first one fails", async () => {
  const calls = [];
  const response = await fetchPage(
    "https://8.8.8.8/contact",
    {
      requestTimeoutMs: 1000,
      browserlessUrl: "https://browserless.example/content",
      browserlessToken: "primary",
      browserlessFallbackToken: "secondary"
    },
    {
      request: async (url, options) => {
        calls.push({ url: String(url), method: options.method || "GET" });
        if (calls.length < 3) throw new Error(`failure ${calls.length}`);
        return {
          body: "<html><body>Rendered contact page</body></html>",
          finalUrl: String(url),
          status: 200,
          contentType: "text/html"
        };
      }
    }
  );

  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[1].url).searchParams.get("token"), "primary");
  assert.equal(new URL(calls[2].url).searchParams.get("token"), "secondary");
  assert.equal(response.rendered, true);
  assert.equal(response.finalUrl, "https://8.8.8.8/contact");
});

test("an unusable ordinary contact page invokes the bounded rendered fallback", async () => {
  let calls = 0;
  const response = await fetchPage("https://8.8.8.8/pages/contact-us", {
    requestTimeoutMs: 1000,
    browserlessUrl: "https://browserless.example/content",
    browserlessToken: "fixture-token",
    browserlessFallbackToken: ""
  }, {
    purpose: "evidence",
    request: async () => {
      calls += 1;
      return calls === 1
        ? {
            body: "<html><body>Not found</body></html>",
            finalUrl: "https://8.8.8.8/pages/contact-us",
            status: 200,
            contentType: "text/html"
          }
        : {
            body: '<html><body><form><textarea name="message"></textarea><button type="submit">Send</button></form></body></html>',
            finalUrl: "https://browserless.example/content",
            status: 200,
            contentType: "text/html"
          };
    }
  });
  assert.equal(calls, 2);
  assert.equal(response.rendered, true);
  assert.match(response.body, /textarea/);
  const evidence = extractContactEvidence({
    html: response.body,
    url: response.finalUrl,
    requestedUrl: "https://8.8.8.8/pages/contact-us",
    allowedHostnames: ["8.8.8.8"],
    status: response.status,
    fetchAssessment: response.fetchAssessment
  });
  assert.equal(evidence.contactUrl, "https://8.8.8.8/pages/contact-us");
});
