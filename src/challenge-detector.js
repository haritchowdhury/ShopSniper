import { stripHtml } from "./html.js";

// These markers are emitted by an active Cloudflare challenge, rather than by
// ordinary storefront integrations that merely load CAPTCHA-related scripts.
const STRONG_MARKUP_PATTERN = /(?:\bcf-chl-|cloudflare\s+ray\s+id\b)/i;

// Only inspect rendered/visible text for human-verification language. This is
// intentionally more specific than a raw /captcha/ match because Shopify
// themes and contact forms commonly embed harmless reCAPTCHA configuration.
const VISIBLE_CHALLENGE_PATTERN = /(?:checking\s+your\s+browser|verify\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human|unusual\s+traffic\s+from\s+(?:your|this)\s+(?:computer\s+)?network|attention\s+required[^.]{0,120}cloudflare|(?:complete|solve|enter|pass)\s+(?:the\s+)?(?:security\s+)?(?:check|challenge|captcha)|captcha\s+(?:is\s+)?(?:required|verification|challenge))/i;
const SHORT_BLOCK_PATTERN = /(?:\baccess\s+denied\b|\bbot\s+detection\b|\bunusual\s+traffic\b)/i;

export function assessChallengeEvidence(html = "", visibleText = stripHtml(html)) {
  const markupSignal = STRONG_MARKUP_PATTERN.test(html);
  const visibleSignal = VISIBLE_CHALLENGE_PATTERN.test(visibleText);
  // Generic denial phrases are useful on challenge shells, but are too broad
  // to trust on long policy/help pages where they can be ordinary prose.
  const shortBlockSignal = visibleText.length <= 2000 && SHORT_BLOCK_PATTERN.test(visibleText);
  const signals = [
    markupSignal ? "strong_challenge_markup" : "",
    visibleSignal ? "visible_human_verification" : "",
    shortBlockSignal ? "short_block_page" : ""
  ].filter(Boolean);

  return Object.freeze({
    challenge: signals.length > 0,
    signals: Object.freeze(signals)
  });
}
