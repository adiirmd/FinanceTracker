const jwt = require("jsonwebtoken");
const { safeEqual } = require("./secure");

// Deliberately NO cookies. The client holds the token in a JavaScript
// variable only, never in a cookie, localStorage, or sessionStorage, so it
// is destroyed by any page reload or navigation and the user must log in
// again. The short expiry is only a server-side backstop for a token that
// somehow gets captured; it is not what logs the user out.
const TOKEN_EXPIRY_SECONDS = 60 * 60; // 1h

const MIN_SECRET_LENGTH = 32;

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing JWT_SECRET env var");
  if (secret.length < MIN_SECRET_LENGTH) {
    // Refuses rather than warns: a guessable signing key means anyone can mint
    // a valid session, so a login that fails loudly beats one that succeeds on
    // a key that does not hold. Verification treats the throw as a rejected
    // token, so a misconfigured deployment locks up instead of opening up.
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

function checkCredentials(username, password) {
  const expectedUser = process.env.ADMIN_USER;
  const expectedPass = process.env.ADMIN_PASS;
  if (!expectedUser || !expectedPass) return false;

  // Both compared in constant time, and both evaluated every call so a wrong
  // username costs exactly as long as a wrong password.
  const okUser = safeEqual(String(username || ""), expectedUser);
  const okPass = safeEqual(String(password || ""), expectedPass);
  return okUser && okPass;
}

function issueToken(username) {
  return jwt.sign({ sub: username }, getSecret(), {
    expiresIn: TOKEN_EXPIRY_SECONDS,
    algorithm: "HS256",
  });
}

/** Reads and verifies the bearer token from the Authorization header. */
function getSession(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) return null;

  try {
    // Pinning the algorithm blocks "alg: none" and HS/RS confusion tricks.
    return jwt.verify(match[1], getSecret(), { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

/** Call at the top of any protected API handler. Sends 401 and returns false if unauthenticated. */
function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

module.exports = {
  checkCredentials,
  issueToken,
  getSession,
  requireAuth,
  TOKEN_EXPIRY_SECONDS,
};
