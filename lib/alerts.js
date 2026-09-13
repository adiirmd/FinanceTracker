const { listTransactions } = require("./sheets");
const { sendTelegramMessage } = require("./telegram");
const { parseDateTimeWIB, startOfTodayWIB, cycleSheetName } = require("./format");

const STEP = 50000; // alert every Rp50.000 of daily spending
const SHOUT_FROM = 150000; // at and above this, the alert switches to all caps
const MAX_ALERTS_PER_CALL = 6; // safety cap if one entry jumps an absurd number of brackets (e.g. a data-entry typo)
const DAY_MS = 24 * 60 * 60 * 1000;

function formatRupiah(n) {
  return "Rp." + Math.round(n).toLocaleString("id-ID");
}

function alertMessage(threshold) {
  return threshold >= SHOUT_FROM ? `⚠️ <b>PENGELUARAN HARI INI SUDAH MENCAPAI ${formatRupiah(threshold).toUpperCase()}!</b>` : `Pengeluaran hari ini sudah mencapai ${formatRupiah(threshold)}`;
}

/**
 * Sends a Telegram alert for every Rp50.000 boundary crossed on the day THIS
 * transaction belongs to — not necessarily today. A manual entry can be
 * backdated (a missed transaction, or demo data for screenshots), and in
 * that case "today's real spending" is the wrong thing to check: it would
 * fire an alert driven by unrelated same-day real transactions that have
 * nothing to do with the backdated entry just added.
 *
 * There's no database to remember "already alerted at 50k that day", so this
 * derives it instead: that day's total AFTER this transaction minus the
 * transaction's own amount gives the total BEFORE it. If those two totals sit
 * in different 50k brackets, this transaction crossed one or more lines — so
 * every bracket in between gets its own message, in order, with nothing
 * stored. A single large expense that jumps straight from Rp0 to Rp120.000
 * still rings both the 50k and the 100k bell, not just the highest one.
 */
async function checkSpendingAlert(justAdded) {
  if (!justAdded || justAdded.type !== "expense") return { alerted: false };

  const amount = Number(justAdded.amount) || 0;
  if (amount <= 0) return { alerted: false };

  const txDate = parseDateTimeWIB(justAdded.date);
  if (!txDate) return { alerted: false };

  // The day and cycle the transaction actually belongs to — not "now".
  const sheetName = cycleSheetName(txDate);
  const dayStart = startOfTodayWIB(txDate).getTime();
  const dayEnd = dayStart + DAY_MS;

  const all = await listTransactions({ cycle: sheetName });

  const totalAfter = all
    .filter((t) => t.type === "expense")
    .filter((t) => {
      const d = parseDateTimeWIB(t.date);
      return d && d.getTime() >= dayStart && d.getTime() < dayEnd;
    })
    .reduce((sum, t) => sum + t.amount, 0);

  const totalBefore = totalAfter - amount;

  const bracketAfter = Math.floor(totalAfter / STEP);
  const bracketBefore = Math.floor(Math.max(totalBefore, 0) / STEP);

  if (bracketAfter <= bracketBefore || bracketAfter < 1) {
    return { alerted: false, totalAfter };
  }

  const firstBracket = Math.max(bracketBefore + 1, 1);
  const lastBracket = Math.min(bracketAfter, firstBracket + MAX_ALERTS_PER_CALL - 1);

  const thresholds = [];
  for (let b = firstBracket; b <= lastBracket; b++) {
    thresholds.push(b * STEP);
  }

  // Sent in order (lowest first) so the Telegram history reads naturally,
  // like watching the total climb rather than jumping around.
  for (const threshold of thresholds) {
    await sendTelegramMessage(alertMessage(threshold));
  }

  return { alerted: true, thresholds, totalAfter };
}

module.exports = { checkSpendingAlert, STEP, SHOUT_FROM };
