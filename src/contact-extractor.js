import { decodeHtml, extractAttributeUrls, extractTitle, stripHtml } from "./html.js";

const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,}\d)/g;
const SOCIAL_HOSTS = [
  "instagram.com",
  "facebook.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "youtube.com",
  "pinterest.com"
];

function safelyDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeEmail(value) {
  const email = safelyDecode(value)
    .trim()
    .replace(/^mailto:/i, "")
    .split("?")[0]
    .toLowerCase()
    .replace(/[),.;:]+$/, "");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)) return "";
  if (/\.(?:png|jpe?g|gif|webp|svg)$/i.test(email)) return "";
  return email;
}

export function normalizePhone(value) {
  const trimmed = safelyDecode(value)
    .replace(/^tel:/i, "")
    .trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return `${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

function resolveLink(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function structuredContacts(html) {
  const emails = [];
  const phones = [];
  let name = "";
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const value = JSON.parse(decodeHtml(match[1]));
      const queue = Array.isArray(value) ? [...value] : [value];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        if (!name && typeof item.name === "string") name = item.name.trim();
        if (typeof item.email === "string") emails.push(item.email);
        if (typeof item.telephone === "string") phones.push(item.telephone);
        for (const nested of Object.values(item)) {
          if (nested && typeof nested === "object") {
            queue.push(...(Array.isArray(nested) ? nested : [nested]));
          }
        }
      }
    } catch {
      // Invalid JSON-LD is common and can be ignored.
    }
  }
  return { emails, phones, name };
}

export function extractContactEvidence({ html = "", url }) {
  const text = stripHtml(html);
  const hrefs = extractAttributeUrls(html);
  const structured = structuredContacts(html);
  const rawEmails = [
    ...structured.emails,
    ...(text.match(EMAIL_PATTERN) || []),
    ...hrefs.filter((href) => /^mailto:/i.test(href))
  ];
  const rawPhones = [
    ...structured.phones,
    ...(text.match(PHONE_PATTERN) || []),
    ...hrefs.filter((href) => /^tel:/i.test(href))
  ];

  const emails = [...new Set(rawEmails.map(normalizeEmail).filter(Boolean))];
  const phones = [...new Set(rawPhones.map(normalizePhone).filter(Boolean))];
  const socialProfiles = [...new Set(
    hrefs
      .map((href) => resolveLink(href, url))
      .filter((href) => {
        if (!href) return false;
        const hostname = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
        return SOCIAL_HOSTS.some(
          (socialHost) => hostname === socialHost || hostname.endsWith(`.${socialHost}`)
        );
      })
      .map((href) => {
        const social = new URL(href);
        social.search = "";
        social.hash = "";
        return social.href;
      })
  )];
  const contactUrl = /contact|support|help|customer[-_]?service/i.test(new URL(url).pathname)
    ? url
    : "";

  return {
    url,
    storeName: structured.name || extractTitle(html),
    emails,
    phones,
    socialProfiles,
    contactUrl,
    textSnippet: text.slice(0, 2500)
  };
}

export function consolidateEvidence(pages) {
  const emailSources = new Map();
  const phoneSources = new Map();
  const socialProfiles = new Set();
  let storeName = "";
  let contactUrl = "";

  for (const page of pages) {
    if (!storeName && page.storeName) storeName = page.storeName;
    if (!contactUrl && page.contactUrl) contactUrl = page.contactUrl;
    for (const email of page.emails) if (!emailSources.has(email)) emailSources.set(email, page.url);
    for (const phone of page.phones) if (!phoneSources.has(phone)) phoneSources.set(phone, page.url);
    for (const profile of page.socialProfiles) socialProfiles.add(profile);
  }

  const email = emailSources.keys().next().value || "";
  const phone = phoneSources.keys().next().value || "";
  return {
    storeName,
    email,
    emailSourceUrl: email ? emailSources.get(email) : "",
    phone,
    phoneSourceUrl: phone ? phoneSources.get(phone) : "",
    contactUrl,
    socialProfiles: [...socialProfiles],
    allEmails: [...emailSources.keys()],
    allPhones: [...phoneSources.keys()],
    snippets: pages.map(({ url, textSnippet }) => ({ url, text: textSnippet }))
  };
}
