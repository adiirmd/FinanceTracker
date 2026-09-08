/**
 * Retries a flaky async call (Google Sheets API, mainly) with exponential
 * backoff. Only retries errors that a retry can plausibly fix — rate limits,
 * momentary server errors, network blips. Bad requests, auth failures, and
 * "not found" errors fail immediately since retrying won't help.
 */
function isRetryableError(err) {
  const status = (err && err.code) || (err && err.response && err.response.status);
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const msg = (err && err.message) || "";
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 250 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 150);
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isRetryableError };
