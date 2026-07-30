export function decodeHtml(value = "") {
  const named = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " "
  };
  return value
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] === "#") {
        const hexadecimal = entity[1]?.toLowerCase() === "x";
        const number = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        return Number.isFinite(number) ? String.fromCodePoint(number) : match;
      }
      return named[entity.toLowerCase()] ?? match;
    })
    .replace(/\u00a0/g, " ");
}

export function stripHtml(html = "") {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function extractAttributeUrls(html = "", attribute = "href") {
  const urls = [];
  const expression = new RegExp(
    `\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    "gi"
  );
  for (const match of html.matchAll(expression)) {
    urls.push(decodeHtml(match[1] ?? match[2] ?? match[3] ?? ""));
  }
  return urls;
}

export function extractCanonical(html = "", baseUrl = "") {
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/\brel\s*=\s*(?:"[^"]*\bcanonical\b[^"]*"|'[^']*\bcanonical\b[^']*'|canonical)/i.test(tag)) {
      continue;
    }
    const href = extractAttributeUrls(tag)[0];
    if (!href) continue;
    try {
      const url = new URL(href, baseUrl);
      if (["http:", "https:"].includes(url.protocol)) {
        url.hash = "";
        return url.href;
      }
    } catch {
      // Ignore malformed canonical URLs.
    }
  }
  return "";
}

export function extractTitle(html = "") {
  const og = html.match(
    /<meta\b(?=[^>]*\bproperty\s*=\s*["']og:site_name["'])(?=[^>]*\bcontent\s*=\s*["']([^"']+)["'])[^>]*>/i
  );
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtml(og?.[1] || title?.[1] || "")
    .replace(/\s*[|–—-]\s*(?:official\s+)?(?:site|store|shop)\s*$/i, "")
    .trim();
}
