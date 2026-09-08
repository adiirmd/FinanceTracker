const { checkCredentials, issueToken, TOKEN_EXPIRY_SECONDS } = require("../lib/auth");

// Best-effort brute-force brake. Serverless instances are recycled and there
// may be several at once, so this counter is NOT a guarantee — it only slows
// down an attacker who happens to land on a warm instance. The real defences
// are the long random ADMIN_PASS and, if you want a hard limit, a rate-limit
// rule in the Vercel dashboard (Settings -> Firewall).
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const MIN_RESPONSE_MS = 400; // floor on every login response, success or not

function clientKey(req) {
  const fwd = req.headers["x-forwarded-for"];
  const ip = Array.isArray(fwd) ? fwd[0] : String(fwd || "").split(",")[0].trim();
  return ip || "unknown";
}

function isLockedOut(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(key, { first: Date.now(), count: 1 });
    return;
  }
  rec.count++;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = async (req, res) => {
  const startedAt = Date.now();

  // Keep every response at the same minimum duration so an attacker can't tell
  // "wrong password" from "locked out" or "unknown user" by timing alone.
  const respond = async (status, body) => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_RESPONSE_MS) await sleep(MIN_RESPONSE_MS - elapsed);
    return res.status(status).json(body);
  };

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const key = clientKey(req);

  if (isLockedOut(key)) {
    return respond(429, { error: "Terlalu banyak percobaan. Coba lagi nanti." });
  }

  const { username, password } = req.body || {};

  // Reject absurd inputs before hashing them.
  if (typeof username !== "string" || typeof password !== "string" ||
      username.length > 200 || password.length > 200) {
    recordFailure(key);
    return respond(401, { error: "Nama pengguna atau kata sandi salah" });
  }

  if (!checkCredentials(username, password)) {
    recordFailure(key);
    return respond(401, { error: "Nama pengguna atau kata sandi salah" });
  }

  attempts.delete(key);

  // Returned in the body, not as a Set-Cookie header: nothing about this
  // login survives a page reload.
  return respond(200, {
    token: issueToken(username),
    expiresIn: TOKEN_EXPIRY_SECONDS,
  });
};
