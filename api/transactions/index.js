const { requireAuth } = require("../../lib/auth");
const { listTransactions, appendTransaction, listCycleSheets, isCycleName } = require("../../lib/sheets");
const { checkSpendingAlert } = require("../../lib/alerts");
const { sanitizeText, parsePositiveAmount } = require("../../lib/secure");

const MAX_SOURCE_CHARS = 40;
const MAX_NOTE_CHARS = 500;

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  if (req.method === "GET") {
    // Only a real cycle name is honoured; anything else silently falls back to
    // the current cycle so a crafted value can't point at another tab.
    const requested = String(req.query.cycle || "");
    const cycle = isCycleName(requested) ? requested : undefined;

    const [transactions, cycles] = await Promise.all([listTransactions({ cycle }), listCycleSheets()]);

    return res.status(200).json({
      transactions,
      cycle: cycle || cycles[0],
      cycles,
    });
  }

  if (req.method === "POST") {
    const { type, amount, source, raw, date } = req.body || {};

    if (type !== "income" && type !== "expense") {
      return res.status(400).json({ error: "type harus 'income' atau 'expense'" });
    }

    const cleanAmount = parsePositiveAmount(amount);
    if (cleanAmount === null) {
      return res.status(400).json({ error: "jumlah harus angka positif yang wajar" });
    }

    // Optional backdating — e.g. entering a missed transaction with its real
    // timestamp, or building an isolated demo cycle for screenshots. Blank or
    // absent means "now", same as before.
    let customDate;
    if (date !== undefined && date !== "") {
      const parsed = new Date(date);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "tanggal tidak valid" });
      }
      customDate = parsed;
    }

    const saved = await appendTransaction({
      type,
      amount: cleanAmount,
      source: sanitizeText(source, MAX_SOURCE_CHARS) || "manual",
      raw: sanitizeText(raw, MAX_NOTE_CHARS),
      date: customDate,
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
