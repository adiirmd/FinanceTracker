const { parseNotification } = require("../lib/parser");
const { appendTransaction } = require("../lib/sheets");
const { checkSpendingAlert } = require("../lib/alerts");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const secret = req.headers["x-webhook-secret"];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const sourceApp = (req.headers["x-source-app"] || "unknown").toLowerCase();

  let text;
  if (typeof req.body === "string") {
    text = req.body;
  } else if (Buffer.isBuffer(req.body)) {
    text = req.body.toString("utf8");
  } else if (req.body && typeof req.body.text === "string") {
    text = req.body.text;
  } else {
    text = "";
  }

  const parsed = parseNotification(sourceApp, text);

  if (!parsed.ok) {
    console.warn("Unparsed notification:", sourceApp, parsed.error, parsed.raw);
    return res.status(200).json({ stored: false, reason: parsed.error });
  }

  const saved = await appendTransaction(parsed.transaction);

  // The transaction is already safely stored; a failing alert must never turn
  // a successful save into an error response.
  try {
    await checkSpendingAlert(saved);
  } catch (err) {
    console.error("Spending alert failed:", err.message);
  }

  return res.status(200).json({ stored: true, transaction: saved });
};
