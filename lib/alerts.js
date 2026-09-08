const { listTransactions } = require("./sheets");
const { sendTelegramMessage } = require("./telegram");
const { parseDateTimeWIB, startOfTodayWIB } = require("./format");

const STEP = 50000; // alert every Rp50.000 of daily spending
const SHOUT_FROM = 150000; // at and above this, the alert switches to all caps

function formatRupiah(n) {
  return "Rp." + Math.round(n).toLocaleString("id-ID");
}

/**
 * Sends a Telegram alert when today's spending crosses a Rp50.000 boundary.
 *
 * There's no database to remember "already alerted at 50k today", so this
 * derives it instead: today's total AFTER this transaction minus the
 * transaction's own amount gives the total BEFORE it. If those two totals sit
 * in different 50k brackets, this transaction is the one that crossed the
 * line — so the alert fires exactly once per threshold, with nothing stored.
 *
 * A single large expense can jump several brackets at once (Rp0 -> Rp120.000
 * clears both 50k and 100k); only the highest one is announced, so one
 * transaction never produces a burst of messages.
 */
async function checkSpendingAlert(justAdded) {
  if (!justAdded || justAdded.type !== "expense") return { alerted: false };

  const amount = Number(justAdded.amount) || 0;
  if (amount <= 0) return { alerted: false };

  const all = await listTransactions({ monthsBack: 0 });
  const since = startOfTodayWIB().getTime();

  const totalAfter = all
    .filter((t) => t.type === "expense")
    .filter((t) => {
      const d = parseDateTimeWIB(t.date);
      return d && d.getTime() >= since;
    })
    .reduce((sum, t) => sum + t.amount, 0);

  const totalBefore = totalAfter - amount;

  const bracketAfter = Math.floor(totalAfter / STEP);
  const bracketBefore = Math.floor(Math.max(totalBefore, 0) / STEP);

  if (bracketAfter <= bracketBefore || bracketAfter < 1) {
    return { alerted: false, totalAfter };
  }

  const threshold = bracketAfter * STEP;
  const message = threshold >= SHOUT_FROM
    ? `⚠️ <b>PENGELUARAN HARI INI SUDAH MENCAPAI ${formatRupiah(threshold).toUpperCase()}!</b>`
    : `Pengeluaran hari ini sudah mencapai ${formatRupiah(threshold)}`;

  await sendTelegramMessage(message);
  return { alerted: true, threshold, totalAfter };
}

module.exports = { checkSpendingAlert, STEP, SHOUT_FROM };
