/**
 * Generic parser for financial-app notifications (MyBCA, Gopay, DANA, OVO,
 * ShopeePay, etc). Deliberately source-agnostic — instead of a hand-built
 * regex per app, it looks for:
 *   1. an amount ("Rp"/"IDR" followed by a number)
 *   2. a direction (income vs expense) via Indonesian keyword matching
 *
 * This works because the sheet schema no longer needs structured
 * category/party fields — just type + amount + the raw text for reference.
 * If a real notification doesn't get picked up, check Vercel Logs for the
 * "Unparsed notification" warning and its raw text, then extend the keyword
 * lists below.
 */

// Top-ups / isi saldo are tracked as ordinary income on the wallet side.
// When it's self-funded (e.g. BCA -> GoPay), the bank side already records
// the matching expense, so Total Pengeluaran and Total Pemasukan both rise
// by the same amount but Selisih (the net) stays accurate — they cancel
// out. When it's someone else's transfer landing via a top-up, there's no
// expense counterpart at all, so recording it as income is simply correct.
// Either way, no exclusion needed.
const INCOME_KEYWORDS = [
  /\bpemasukan\b/i,
  /\bmenerima\b/i,
  /\bditerima\b/i,
  /\bmasuk\b/i,
  /\bsaldo\s*bertambah\b/i,
  /\bcashback\b/i,
  /\btop\s*up\b/i,
  /\bisi\s*saldo\b/i,
  /\bpengisian\s*saldo\b/i,
  /\bditambahkan\s*ke\b/i,
];

const EXPENSE_KEYWORDS = [
  /\bpengeluaran\b/i,
  /\bpembayaran\b/i,
  /\bmembayar\b/i,
  /\bpembelian\b/i,
  /\bterkirim\b/i,
  /\bmengirim\b/i,
  /\bberhasil\s*transfer\b/i,
  /\btransfer\s*keluar\b/i,
  /\bkeluar\b/i,
  /\bsaldo\s*berkurang\b/i,
  /\bdebit\b/i,
  /\bdikirim\b/i,
  /\bpenarikan\b/i,
];

function detectType(text) {
  if (INCOME_KEYWORDS.some((re) => re.test(text))) return "income";
  if (EXPENSE_KEYWORDS.some((re) => re.test(text))) return "expense";
  return null;
}

function extractAmount(text) {
  // "IDR 18,000.00" style (comma=thousands, dot=decimal) — MyBCA.
  let m = text.match(/IDR\s*([\d,]+\.\d{2})/i);
  if (m) return parseFloat(m[1].replace(/,/g, ""));

  // "Rp50.000" / "Rp 50.000,00" style (dot=thousands, comma=decimal) — most
  // Indonesian e-wallets.
  m = text.match(/Rp\.?\s*([\d.]+)(?:,\d{1,2})?/i);
  if (m) {
    const intPart = m[1].replace(/\./g, "");
    const amount = parseFloat(intPart);
    if (!Number.isNaN(amount)) return amount;
  }

  return null;
}

function parseNotification(sourceApp, rawText) {
  if (!rawText || typeof rawText !== "string") {
    return { ok: false, error: "empty or invalid notification text" };
  }

  const text = rawText.trim();
  const type = detectType(text);
  const amount = extractAmount(text);

  if (!type || amount === null) {
    const missing = [!type && "type", amount === null && "amount"].filter(Boolean).join(" & ");
    return { ok: false, error: `could not determine ${missing}`, raw: text };
  }

  return {
    ok: true,
    transaction: {
      type,
      amount,
      source: sourceApp || "unknown",
      raw: text,
    },
  };
}

module.exports = { parseNotification, extractAmount, detectType };
