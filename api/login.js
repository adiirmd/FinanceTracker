const { checkCredentials, issueToken, TOKEN_EXPIRY_SECONDS } = require("../lib/auth");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const { username, password } = req.body || {};

  if (!checkCredentials(username, password)) {
    return res.status(401).json({ error: "Nama pengguna atau kata sandi salah" });
  }

  // Returned in the body, not as a Set-Cookie header: nothing about this
  // login survives a page reload.
  return res.status(200).json({
    token: issueToken(username),
    expiresIn: TOKEN_EXPIRY_SECONDS,
  });
};
