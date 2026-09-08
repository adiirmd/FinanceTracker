const { parseNotification } = require("../lib/parser");
const { appendTransaction } = require("../lib/sheets");
const { checkSpendingAlert } = require("../lib/alerts");
const { safeEqual, sanitizeText } = require("../lib/secure");

// A phone notification is a couple of sentences; anything far beyond that is
// junk or an attempt to stuff the sheet, so it's cut before parsing.
const MAX_NOTIFICATION_CHARS = 1000;
const MAX_SOURCE_CHARS = 40;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const secret = req.headers["x-webhook-secret"];
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected || !safeEqual(String(secret || ""), expected)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const sourceApp = sanitizeText(req.headers["x-source-app"] || "unknown", MAX_SOURCE_CHARS)
    .toLowerCase()
    // Keep the app label to a predictable shape so it stays usable as a filter.
    .replace(/[^a-z0-9._-]/g, "") || "unknown";

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

  text = sanitizeText(text, MAX_NOTIFICATION_CHARS);

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
