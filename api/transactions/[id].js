const { requireAuth } = require("../../lib/auth");
const { updateTransaction, deleteTransaction } = require("../../lib/sheets");

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  const { id } = req.query;

  if (req.method === "PUT") {
    const { amount, source, raw } = req.body || {};
    const updates = {};
    if (amount !== undefined) updates.amount = Number(amount);
    if (source !== undefined) updates.source = source;
    if (raw !== undefined) updates.raw = raw;

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
