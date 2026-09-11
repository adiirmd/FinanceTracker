const { listTransactions, getRecapMarker, setRecapMarker } = require("../lib/sheets");
const { sendTelegramMessage } = require("../lib/telegram");
const { parseDateTimeWIB, startOfTodayWIB, startOfCycleWIB, wibNowWithGrace, cycleSheetName } = require("../lib/format");
const { safeEqual } = require("../lib/secure");

// Guards against sending the same recap twice — but only for genuinely
// near-simultaneous triggers (two overlapping schedulers, a retry, an
// accidental double-click on "test run"). A manual test earlier in the day
// and the real scheduled fire that evening are hours apart and both go
// through — this is NOT "once per calendar day", it's "not twice within an
// hour of each other".
const DEDUPE_WINDOW_MS = 60 * 60 * 1000;

function formatIDR(n) {
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}

module.exports = async (req, res) => {
  // When CRON_SECRET is set in the Vercel project, Vercel automatically sends
  // it as "Authorization: Bearer <CRON_SECRET>" on cron-triggered requests.
  // An external scheduler (cron-job.org etc.) is configured to send the same
  // header manually — the check itself doesn't care which one called it, and
  // that includes its manual "test run" button: from the server's side a
  // deliberate test looks identical to the real scheduled fire.
  const authHeader = String(req.headers.authorization || "");
  const expected = process.env.CRON_SECRET;
  if (!expected || !safeEqual(authHeader, `Bearer ${expected}`)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const period = req.query.period === "monthly" ? "monthly" : "daily";

  // A trigger meant to fire right at day's/cycle's end that actually lands a
  // few minutes into the next one should still summarize the period that
  // just finished, not the fresh, barely-started one.
  const referenceNow = wibNowWithGrace();
  const since = period === "monthly"
    ? startOfCycleWIB(referenceNow).getTime()
    : startOfTodayWIB(referenceNow).getTime();

  const sheetName = cycleSheetName(referenceNow);
  const markerKind = period === "monthly" ? "monthly" : "daily";

  const force = req.query.force === "true";
  if (!force) {
    const lastSentIso = await getRecapMarker(markerKind, sheetName);
    const lastSentMs = lastSentIso ? Date.parse(lastSentIso) : NaN;
    if (Number.isFinite(lastSentMs)) {
      const elapsedMs = Date.now() - lastSentMs;
      if (elapsedMs < DEDUPE_WINDOW_MS) {
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: "sent recently",
          period,
          minutesAgo: Math.round(elapsedMs / 60000),
        });
      }
    }
  }

  const all = await listTransactions({ cycle: sheetName });
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

  // Only recorded after a successful send — a failed Telegram call should be
  // retryable, not silently marked as done. Stores WHEN it was sent, not
  // which day it was for; the dedupe check above is purely time-based.
  await setRecapMarker(markerKind, sheetName, new Date().toISOString());

  return res.status(200).json({ ok: true, period, income, expense, count: inRange.length });
};