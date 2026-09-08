const crypto = require("crypto");

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * A plain `a === b` bails out at the first differing character, so the time it
 * takes reveals how much of a guess was correct — enough, over many requests,
 * to reconstruct a secret byte by byte. Hashing both sides first keeps the
 * compared buffers equal-length (timingSafeEqual throws otherwise) and hides
 * the real length too.
 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Cleans a string that will be stored in the sheet and echoed back to the
 * dashboard: strips control characters, collapses runs of whitespace, and caps
 * the length so one oversized notification can't bloat a row or a response.
 */
function sanitizeText(value, maxLength = 500) {
  if (value === undefined || value === null) return "";
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * Accepts only a finite, positive, sanely-sized amount. Rejects NaN,
 * Infinity, negatives, and absurd values that would corrupt totals.
 */
const MAX_AMOUNT = 1e12;

function parsePositiveAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n > MAX_AMOUNT) return null;
  return Math.round(n * 100) / 100;
}

module.exports = { safeEqual, sanitizeText, parsePositiveAmount, MAX_AMOUNT };
