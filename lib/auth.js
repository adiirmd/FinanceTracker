const jwt = require("jsonwebtoken");
const { safeEqual } = require("./secure");

// Deliberately NO cookies. The client holds the token in a JavaScript
// variable only — never in a cookie, localStorage, or sessionStorage — so it
// is destroyed by any page reload or navigation and the user must log in
// again. The short expiry is only a server-side backstop for a token that
// somehow gets captured; it is not what logs the user out.
const TOKEN_EXPIRY_SECONDS = 60 * 60; // 1h

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing JWT_SECRET env var");
  if (secret.length < 32) {
    // Warn rather than throw: refusing to start would take the whole app down
    // in production, which is worse than running with a flagged weak secret.
    console.warn("JWT_SECRET is shorter than 32 characters — rotate it for a longer random value.");
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
