const { clearSessionCookie } = require("../lib/auth");

module.exports = async (req, res) => {
  res.setHeader("Set-Cookie", clearSessionCookie());
  return res.status(200).json({ ok: true });
};
