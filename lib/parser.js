/**
 * Generic parser for financial app notifications (MyBCA, Gopay, DANA, OVO,
 * ShopeePay, etc). Deliberately source agnostic instead of a hand-built
 * regex per app, it looks for:
 *   1. an amount ("Rp"/"IDR" followed by a number)
 *   2. a direction (income vs expense) via Indonesian keyword matching
 */
// prettier-ignore
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
  /\bbayar\b/i,
  /\bpembelian\b/i,
  /\bterkirim\b/i,
  /\bdikirim\b/i,
  /\bmengirim\b/i,
  /\bkirim\b/i,
  /\bditransfer\b/i,
  /\bberhasil\s*transfer\b/i,
  /\btransfer\s*keluar\b/i,
  /\bkeluar\b/i,
  /\bsaldo\s*berkurang\b/i,
  /\bdipotong\b/i,
  /\bditarik\b/i,
  /\bdebit\b/i,
  /\bpenarikan\b/i,
];

function detectType(text) {
  if (INCOME_KEYWORDS.some((re) => re.test(text))) return "income";
  if (EXPENSE_KEYWORDS.some((re) => re.test(text))) return "expense";
  return null;
}

function extractAmount(text) {
  // "IDR 18,000.00" style (comma=thousands, dot=decimal), used by MyBCA.
  let m = text.match(/IDR\s*([\d,]+\.\d{2})/i);
  if (m) return parseFloat(m[1].replace(/,/g, ""));

  // "Rp50.000" / "Rp 50.000,00" style (dot=thousands, comma=decimal), used by most
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
