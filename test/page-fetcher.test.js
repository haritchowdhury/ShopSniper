import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  BrowserlessContractError,
  parseBrowserlessContentResponse
} from "../src/browserless-adapter.js";
import { extractContactEvidence } from "../src/contact-extractor.js";
import { assessPageResponse, fetchPage } from "../src/page-fetcher.js";

function storefrontHtml(text = "Specialist eyewear frames and lenses") {
  return `<html><body><script src="/cdn/shop/theme.js"></script>${text.repeat(8)}</body></html>`;
}

function renderedResponse(finalUrl, body = storefrontHtml(), status = 200) {
  return {
    body,
    finalUrl: "https://browserless.example/content",
    status: 200,
    contentType: "text/html; charset=utf-8",
    responseHeaders: {
      "x-response-code": String(status),
      "x-response-url": finalUrl
    }
  };
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

test("disabled Browserless returns the ordinary response without rendering", async () => {
  let calls = 0;
  const response = await fetchPage("https://8.8.8.8/", {
    requestTimeoutMs: 1000,
    browserlessEnabled: false,
    browserlessUrl: "https://browserless.example/content",
    browserlessToken: "fixture-token",
    browserlessFallbackToken: "fixture-fallback-token"
  }, {
    purpose: "storefront",
    request: async () => {
      calls += 1;
      return {
        body: "<html><body>Please enable JavaScript to view this shop</body></html>",
        finalUrl: "https://8.8.8.8/",
        status: 200,
        contentType: "text/html"
      };
    }
  });

  assert.equal(calls, 1);
  assert.equal(response.rendered, false);
  assert.equal(response.renderAttempted, false);
  assert.equal(response.renderUnavailable, true);
  assert.equal(response.fetchAssessment.usable, false);
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
        : renderedResponse("https://8.8.8.8/");
    }
  });
  assert.equal(calls, 2);
  assert.equal(response.rendered, true);
  assert.equal(response.fetchAssessment.usable, true);
  assert.equal(response.ordinaryAssessment.reason, "javascript_or_consent_shell");
});

test("rendered Shopify commerce remains usable with embedded CAPTCHA scripts", async () => {
  let calls = 0;
  const renderedCommerce = `<html><body>
    <script>window.ShopifyCaptcha = { siteKey: "fixture" };</script>
    <main><a href="/products/frame">Shop eyewear</a>${"Specialist frames and lenses in stock. ".repeat(8)}</main>
  </body></html>`;
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
        : renderedResponse("https://8.8.8.8/", renderedCommerce);
    }
  });

  assert.equal(calls, 2);
  assert.equal(response.rendered, true);
  assert.equal(response.fetchAssessment.challenge, false);
  assert.equal(response.fetchAssessment.usable, true);
});

test("challenge and password pages remain distinguishable", () => {
  const challenge = assessPageResponse({
    body: "<html><body>Checking your browser. Verify you are human.</body></html>",
    contentType: "text/html"
  }, { purpose: "storefront" });
  const password = assessPageResponse({
    body: `<html><body class="password"><form action="/password"><input type="password">${"Opening soon. Enter using password. ".repeat(8)}</form></body></html>`,
    contentType: "text/html",
    finalUrl: "https://8.8.8.8/password"
  }, { purpose: "storefront" });
  assert.equal(challenge.reason, "challenge_page");
  assert.equal(challenge.challenge, true);
  assert.equal(password.passwordProtected, true);
  assert.equal(password.challenge, false);
});

test("script-only CAPTCHA integrations do not block normal Shopify commerce", () => {
  const assessment = assessPageResponse({
    body: `<html><body>
      <script>window.ShopifyCaptcha = { siteKey: "fixture" };</script>
      <script src="https://www.google.com/recaptcha/api.js"></script>
      <main><a href="/products/frame">Shop specialist eyewear frames</a>${"Prescription lenses and active products. ".repeat(8)}</main>
    </body></html>`,
    contentType: "text/html",
    finalUrl: "https://8.8.8.8/"
  }, { purpose: "storefront" });

  assert.equal(assessment.challenge, false);
  assert.equal(assessment.usable, true);
  assert.deepEqual(assessment.challengeSignals, []);
});

test("strong Cloudflare markup and visible CAPTCHA challenges remain blocked", () => {
  const cloudflare = assessPageResponse({
    body: `<html><body><div id="cf-chl-widget">${"Please wait. ".repeat(20)}</div></body></html>`,
    contentType: "text/html"
  }, { purpose: "storefront" });
  const captcha = assessPageResponse({
    body: `<html><body><h1>Security check</h1><p>Complete the CAPTCHA to continue.</p>${"Verification required. ".repeat(8)}</body></html>`,
    contentType: "text/html"
  }, { purpose: "storefront" });

  assert.equal(cloudflare.reason, "challenge_page");
  assert.deepEqual(cloudflare.challengeSignals, ["strong_challenge_markup"]);
  assert.equal(captcha.reason, "challenge_page");
  assert.deepEqual(captcha.challengeSignals, ["visible_human_verification"]);
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
        return renderedResponse(
          "https://8.8.8.8/contact",
          "<html><body>Rendered contact page</body></html>"
        );
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
        : renderedResponse(
            "https://8.8.8.8/pages/contact-us",
            '<html><body><form><textarea name="message"></textarea><button type="submit">Send</button></form></body></html>'
          );
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

test("Browserless fixture contract accepts the pinned headers and rejects malformed variants", () => {
  const directory = new URL("./fixtures/providers/browserless/", import.meta.url);
  const fixture = (name) => JSON.parse(fs.readFileSync(new URL(name, directory), "utf8"));
  const accepted = parseBrowserlessContentResponse(
    fixture("content-response-headers-v1-success.json")
  );
  assert.equal(accepted.finalUrl, "https://fixture-store.example/pages/contact-us");
  assert.equal(accepted.status, 200);
  for (const name of [
    "content-response-headers-v1-missing-final-url.json",
    "content-response-headers-v1-malformed-code.json"
  ]) {
    assert.throws(
      () => parseBrowserlessContentResponse(fixture(name)),
      BrowserlessContractError
    );
  }
});

test("Browserless external redirects and missing attribution cannot contribute evidence", async () => {
  async function execute(rendered) {
    let calls = 0;
    return fetchPage("https://8.8.8.8/", {
      requestTimeoutMs: 1000,
      browserlessUrl: "https://browserless.example/content",
      browserlessToken: "fixture-token",
      browserlessFallbackToken: ""
    }, {
      purpose: "storefront",
      allowedHostnames: ["8.8.8.8"],
      request: async () => {
        calls += 1;
        return calls === 1
          ? {
              body: "<html><body>Please enable JavaScript to view this shop</body></html>",
              finalUrl: "https://8.8.8.8/",
              status: 200,
              contentType: "text/html"
            }
          : rendered;
      }
    });
  }

  const external = await execute(renderedResponse("https://9.9.9.9/"));
  assert.equal(external.rendered, false);
  assert.equal(external.renderAttempted, true);
  assert.equal(external.finalUrl, "https://8.8.8.8/");
  assert.equal(external.renderError, "Rendered fetch failed");

  const missing = renderedResponse("https://8.8.8.8/");
  delete missing.responseHeaders["x-response-url"];
  assert.equal((await execute(missing)).rendered, false);
  assert.equal((await execute(renderedResponse("https://8.8.8.8/", storefrontHtml(), 404))).rendered, false);
});

test("incidental lock-related copy on normal commerce pages is not password protection", () => {
  for (const phrase of ["opening soon", "password", "coming soon"]) {
    const assessment = assessPageResponse({
      body: storefrontHtml(`Active catalog and checkout. Our second location is ${phrase}. `),
      contentType: "text/html",
      finalUrl: "https://8.8.8.8/"
    }, { purpose: "storefront" });
    assert.equal(assessment.passwordProtected, false, phrase);
  }
});
