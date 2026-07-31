import { requestText } from "./http-client.js";
import { decodeHtml, extractAttributeUrls } from "./html.js";
import { normalizeHostname, parseHttpUrl, sameAllowedHostname } from "./url-security.js";
import { classifyStorePageUrl } from "./contact-evidence.js";

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

function normalizedWords(value) {
  const ignored = new Set([
    "site", "myshopify", "com", "products", "collections", "shop", "store"
  ]);
  return String(value || "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !ignored.has(word));
}

function pagePriority(value, candidate) {
  const url = new URL(value);
  const path = url.pathname.toLocaleLowerCase("en-US");
  if (path === "/" || !path.replaceAll("/", "")) return 0;
  const classified = classifyStorePageUrl(value, {
    allowedHostnames: candidate.allowedHostnames
  });
  if (classified.classification === "contact") {
    if (/\/(?:contact|get-in-touch|customer-service)(?:[-/]|$)/.test(path)) return 1;
    if (/\/(?:support|help|customer-support)(?:[-/]|$)/.test(path)) return 2;
    return 5;
  }
  if (classified.classification === "organization_evidence") {
    return path.includes("/policies/") ? 5 : 3;
  }
  if (/\/(?:collections|products)\//.test(path)) {
    const words = new Set([
      ...normalizedWords(candidate.shopType),
      ...normalizedWords(candidate.query),
      ...(candidate.categoryVocabulary || []).flatMap(normalizedWords)
    ]);
    return [...words].some((word) => normalizedWords(path).includes(word)) ? 4 : 7;
  }
  return 7;
}

export function rankStorePageUrls(values, candidate, limit) {
  const selected = new Map();
  for (const value of values) {
    const accepted = acceptedPageUrl(value, candidate.finalUrl, candidate.allowedHostnames);
    if (!accepted) continue;
    const url = new URL(accepted);
    url.hash = "";
    const key = `${normalizeHostname(url.hostname)}${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`;
    const priority = pagePriority(url.href, candidate);
    if (priority > 5) continue;
    const existing = selected.get(key);
    if (!existing || priority < existing.priority ||
      (priority === existing.priority && url.href.localeCompare(existing.url) < 0)) {
      selected.set(key, { url: url.href, priority });
    }
  }
  return [...selected.values()]
    .sort((a, b) => a.priority - b.priority || a.url.localeCompare(b.url))
    .slice(0, limit)
    .map(({ url }) => url);
}

export function contactLinksFromHtml(html, baseUrl, allowedHostnames) {
  return extractAttributeUrls(html)
    .map((value) => acceptedPageUrl(value, baseUrl, allowedHostnames))
    .filter((value) => value && classifyStorePageUrl(value, { allowedHostnames }).accepted);
}

export async function discoverStorePages(
  candidate,
  config,
  { request = requestText } = {}
) {
  const resolvedBase = new URL(candidate.finalUrl);
  const pages = [
    new URL("/", resolvedBase).href,
    candidate.finalUrl,
    candidate.url,
    ...extractAttributeUrls(candidate.html)
      .map((value) => acceptedPageUrl(value, candidate.finalUrl, candidate.allowedHostnames))
      .filter(Boolean)
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

      pages.push(...pageUrls.map((value) =>
        acceptedPageUrl(value, rootResponse.finalUrl, candidate.allowedHostnames)
      ).filter(Boolean));
    }
  } catch {
    // Sitemap discovery is optional; homepage and internal links remain usable.
  }

  return rankStorePageUrls(pages, candidate, config.maxPagesPerStore);
}
