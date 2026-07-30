import { requestText } from "./http-client.js";
import { decodeHtml, extractAttributeUrls } from "./html.js";
import { normalizeHostname, parseHttpUrl, sameAllowedHostname } from "./url-security.js";

const CONTACT_PATH =
  /(?:^|[/_-])(?:contact|about|support|help|customer[-_]?service|company|team|location|locations|find[-_]?us|our[-_]?story|legal|privacy)(?:[/_.-]|$)/i;

export function parseSitemap(xml) {
  const type = /<\s*(?:\w+:)?sitemapindex\b/i.test(xml)
    ? "index"
    : /<\s*(?:\w+:)?urlset\b/i.test(xml)
      ? "urlset"
      : "unknown";
  const urls = [];
  for (const match of xml.matchAll(/<\s*(?:\w+:)?loc\b[^>]*>([\s\S]*?)<\s*\/\s*(?:\w+:)?loc\s*>/gi)) {
    const value = decodeHtml(match[1]).trim();
    if (value) urls.push(value);
  }
  return { type, urls };
}

function acceptedPageUrl(value, baseUrl, allowedHostnames) {
  try {
    const url = parseHttpUrl(value, baseUrl);
    if (!sameAllowedHostname(url, allowedHostnames)) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function contactLinksFromHtml(html, baseUrl, allowedHostnames) {
  return extractAttributeUrls(html)
    .map((value) => acceptedPageUrl(value, baseUrl, allowedHostnames))
    .filter((value) => value && CONTACT_PATH.test(new URL(value).pathname));
}

export async function discoverStorePages(
  candidate,
  config,
  { request = requestText } = {}
) {
  const resolvedBase = new URL(candidate.finalUrl);
  const pages = [
    candidate.finalUrl,
    candidate.url,
    ...contactLinksFromHtml(candidate.html, candidate.finalUrl, candidate.allowedHostnames)
  ];
  const sitemapUrl = new URL("/sitemap.xml", resolvedBase).href;

  try {
    const rootResponse = await request(sitemapUrl, {
      timeoutMs: config.requestTimeoutMs,
      retries: 0,
      maxBytes: 2_000_000
    });
    if (sameAllowedHostname(rootResponse.finalUrl, candidate.allowedHostnames)) {
      const root = parseSitemap(rootResponse.body);
      let pageUrls = root.type === "urlset" ? root.urls : [];

      if (root.type === "index") {
        const childSitemaps = root.urls
          .map((value) => acceptedPageUrl(value, rootResponse.finalUrl, candidate.allowedHostnames))
          .filter(Boolean)
          .sort((a, b) => {
            const pageBias = Number(/pages/i.test(b)) - Number(/pages/i.test(a));
            return pageBias || a.localeCompare(b);
          })
          .slice(0, 5);

        for (const childUrl of childSitemaps) {
          try {
            const childResponse = await request(childUrl, {
              timeoutMs: config.requestTimeoutMs,
              retries: 0,
              maxBytes: 2_000_000
            });
            if (!sameAllowedHostname(childResponse.finalUrl, candidate.allowedHostnames)) continue;
            pageUrls.push(...parseSitemap(childResponse.body).urls);
          } catch {
            // A broken child sitemap does not invalidate the store.
          }
        }
      }

      pages.push(
        ...pageUrls
          .map((value) => acceptedPageUrl(value, rootResponse.finalUrl, candidate.allowedHostnames))
          .filter((value) => value && CONTACT_PATH.test(new URL(value).pathname))
      );
    }
  } catch {
    // Sitemap discovery is optional; homepage and internal links remain usable.
  }

  const deduplicated = [];
  const seen = new Set();
  for (const value of pages) {
    const accepted = acceptedPageUrl(value, candidate.finalUrl, candidate.allowedHostnames);
    if (!accepted) continue;
    const url = new URL(accepted);
    url.hash = "";
    const key = `${normalizeHostname(url.hostname)}${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(url.href);
  }
  return deduplicated.slice(0, config.maxPagesPerStore);
}
