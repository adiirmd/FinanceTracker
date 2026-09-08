const { requireAuth } = require("../../lib/auth");
const { listTransactions, appendTransaction } = require("../../lib/sheets");
const { checkSpendingAlert } = require("../../lib/alerts");

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  if (req.method === "GET") {
    const monthsBack = Number(req.query.monthsBack) || 1;
    const transactions = await listTransactions({ monthsBack });
    return res.status(200).json({ transactions, monthsBack });
  }

  if (req.method === "POST") {
    const { type, amount, source, raw } = req.body || {};

    if ((type !== "income" && type !== "expense") || !amount || Number.isNaN(Number(amount))) {
      return res.status(400).json({ error: "type must be 'income' or 'expense', amount must be a number" });
    }

    const saved = await appendTransaction({
      type,
      amount: Number(amount),
      source: source || "manual",
      raw: raw || "",
    });

    try {
      await checkSpendingAlert(saved);
    } catch (err) {
      console.error("Spending alert failed:", err.message);
    }

    return res.status(201).json({ transaction: saved });
  }

  return res.status(405).json({ error: "method not allowed" });
};
