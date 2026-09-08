const { getSession } = require("../lib/auth");

module.exports = async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ authenticated: false });
  return res.status(200).json({ authenticated: true, username: session.sub });
};
