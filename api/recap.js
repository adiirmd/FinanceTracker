const { listTransactions } = require("../lib/sheets");
const { sendTelegramMessage } = require("../lib/telegram");
const { parseDateTimeWIB, startOfTodayWIB, startOfCycleWIB } = require("../lib/format");
const { safeEqual } = require("../lib/secure");

function formatIDR(n) {
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}

module.exports = async (req, res) => {
  // When CRON_SECRET is set in the Vercel project, Vercel automatically sends
  // it as "Authorization: Bearer <CRON_SECRET>" on cron-triggered requests.
  const authHeader = String(req.headers.authorization || "");
  const expected = process.env.CRON_SECRET;
  if (!expected || !safeEqual(authHeader, `Bearer ${expected}`)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // "monthly" covers the 28th-to-27th billing cycle, matching the sheet tabs;
  // anything else is today only.
  const period = req.query.period === "monthly" ? "monthly" : "daily";
  const since = period === "monthly"
    ? startOfCycleWIB().getTime()
    : startOfTodayWIB().getTime();

  // The current cycle sheet holds everything either period needs.
  const all = await listTransactions();
  const inRange = all.filter((t) => {
    const d = parseDateTimeWIB(t.date);
    return d && d.getTime() >= since;
  });

  const income = inRange.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expense = inRange.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);

  const bySource = {};
  for (const t of inRange.filter((t) => t.type === "expense")) {
    bySource[t.source || "?"] = (bySource[t.source || "?"] || 0) + t.amount;
  }
  const topSources = Object.entries(bySource)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const heading = period === "monthly" ? "🗓️ Rekap Bulanan" : "📅 Rekap Harian";

  const lines = [
    `<b>${heading}</b>`,
    "",
    `Pemasukan: ${formatIDR(income)}`,
    `Pengeluaran: ${formatIDR(expense)}`,
    `Jumlah transaksi: ${inRange.length}`,
  ];

  if (topSources.length) {
    lines.push("", "<b>Top aplikasi pengeluaran:</b>");
    for (const [src, amt] of topSources) {
      lines.push(`• ${src}: ${formatIDR(amt)}`);
    }
  }

  await sendTelegramMessage(lines.join("\n"));
  return res.status(200).json({ ok: true, period, income, expense, count: inRange.length });
};
