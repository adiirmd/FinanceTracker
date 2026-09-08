const { requireAuth } = require("../../lib/auth");
const { updateTransaction, deleteTransaction } = require("../../lib/sheets");
const { sanitizeText, parsePositiveAmount } = require("../../lib/secure");

const MAX_SOURCE_CHARS = 40;
const MAX_NOTE_CHARS = 500;

// Ids are built by this app as "<Sheet-Name>|<type>|<row>". Validating the
// shape stops a crafted id from steering a write at an arbitrary cell or an
// unrelated tab.
const ID_PATTERN = /^[A-Za-z]+-\d{4}\|(income|expense)\|\d{1,5}$/;

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = String(req.query.id || "");
  if (!ID_PATTERN.test(id)) {
    return res.status(400).json({ error: "id tidak valid" });
  }

  if (req.method === "PUT") {
    const { amount, source, raw } = req.body || {};
    const updates = {};

    if (amount !== undefined) {
      const cleanAmount = parsePositiveAmount(amount);
      if (cleanAmount === null) {
        return res.status(400).json({ error: "jumlah harus angka positif yang wajar" });
      }
      updates.amount = cleanAmount;
    }
    if (source !== undefined) updates.source = sanitizeText(source, MAX_SOURCE_CHARS);
    if (raw !== undefined) updates.raw = sanitizeText(raw, MAX_NOTE_CHARS);

    const updated = await updateTransaction(id, updates);
    if (!updated) return res.status(404).json({ error: "not found" });
    return res.status(200).json({ transaction: updated });
  }

  if (req.method === "DELETE") {
    const deleted = await deleteTransaction(id);
    if (!deleted) return res.status(404).json({ error: "not found" });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method not allowed" });
};
