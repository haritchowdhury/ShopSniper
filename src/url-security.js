import dns from "node:dns/promises";
import net from "node:net";

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIp(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(normalized)) return isPrivateIpv4(normalized);
  if (!net.isIPv6(normalized)) return true;
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

export function parseHttpUrl(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  url.hash = "";
  return url;
}

export async function assertPublicUrl(value, { lookup = dns.lookup } = {}) {
  const url = parseHttpUrl(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Local and private network targets are not allowed");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Local and private network targets are not allowed");
    }
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Target resolves to a local or private network address");
  }
  return url;
}

export function normalizeHostname(value) {
  return value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

export function isMyShopifyHostname(value) {
  const hostname = normalizeHostname(value);
  return hostname === "myshopify.com" || hostname.endsWith(".myshopify.com");
}

export function sameAllowedHostname(value, allowedHostnames) {
  const hostname = normalizeHostname(parseHttpUrl(value).hostname);
  return allowedHostnames.some((allowed) => hostname === normalizeHostname(allowed));
}
