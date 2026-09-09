const MONTHS_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const MONTHS_ID_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, "0");
}

function toWIBParts(date) {
  const wib = new Date(date.getTime() + WIB_OFFSET_MS);
  return {
    year: wib.getUTCFullYear(),
    month: wib.getUTCMonth(), // 0-indexed
    day: wib.getUTCDate(),
    hours: wib.getUTCHours(),
    minutes: wib.getUTCMinutes(),
    seconds: wib.getUTCSeconds(),
  };
}

/** "03 Sep 2026 16:44:26" — display format, WIB. */
function formatDateTimeWIB(date) {
  const p = toWIBParts(date);
  return `${pad(p.day)} ${MONTHS_ID_SHORT[p.month]} ${p.year} ${pad(p.hours)}:${pad(p.minutes)}:${pad(p.seconds)}`;
}

/**
 * Parses a Tanggal cell back into a real UTC Date instant. Handles three
 * shapes, because Google Sheets may have coerced older rows into its own
 * datetime type before we switched to RAW writes:
 *   1. our own "08 Sep 2026 07:55:37"
 *   2. the same but re-rendered by Sheets with a 1-digit hour ("8 Sep 2026 7:55:37")
 *   3. a Sheets serial number (days since 1899-12-30), which is what an
 *      UNFORMATTED_VALUE read returns for a coerced datetime cell
 * In every case the stored wall-clock time is WIB.
 */
function parseDateTimeWIB(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Sheets serial -> ms, read as WIB wall-clock, then shifted to a real instant.
    const asUTC = (value - 25569) * 86400000;
    return new Date(Math.round(asUTC) - WIB_OFFSET_MS);
  }

  if (typeof value !== "string") return null;

  const m = value.trim().match(/^(\d{1,2}) (\w{3}) (\d{4})[ ,]+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mon, yyyy, hh, mi, ss] = m;
  const monthIdx = MONTHS_ID_SHORT.indexOf(mon);
  if (monthIdx === -1) return null;
  const wibAsUTC = Date.UTC(Number(yyyy), monthIdx, Number(dd), Number(hh), Number(mi), Number(ss));
  return new Date(wibAsUTC - WIB_OFFSET_MS);
}

/**
 * Parses a Jumlah cell into a plain number. An UNFORMATTED_VALUE read gives
 * a real number, but older rows that Sheets coerced into currency can still
 * come back as "Rp.11.000,00" — dots as thousands separators, comma as the
 * decimal — so strip the formatting rather than trusting parseFloat.
 */
function parseAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;

  const cleaned = value.replace(/[^\d,.-]/g, "").trim();
  if (!cleaned) return 0;

  // "11.000,00" (id-ID) vs "11000.00" (plain): the last separator present
  // decides which character is the decimal point.
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }

  const n = parseFloat(normalized);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * "September-2026" — the sheet/tab name for a 28-day-anchored billing cycle
 * (28 Aug – 27 Sep is "September-2026"; the cycle rolls over to the next
 * name starting the 28th). monthsOffset steps back N whole cycles from the
 * cycle `date` falls into — used to enumerate recent sheets to read.
 */
function cycleSheetName(date, monthsOffset = 0) {
  const p = toWIBParts(date);
  let year = p.year;
  let month = p.month; // 0-indexed
  if (p.day >= 28) month += 1; // day 28+ already belongs to next cycle's sheet
  month -= monthsOffset;
  while (month < 0) {
    month += 12;
    year -= 1;
  }
  while (month > 11) {
    month -= 12;
    year += 1;
  }
  return `${MONTHS_ID[month]}-${year}`;
}

/**
 * Start of the billing cycle containing `date`: the 28th at 00:00 WIB, of
 * this month if we're already on/after the 28th, otherwise of last month.
 * Returned as a real UTC instant so it can be compared with parsed dates.
 */
function startOfCycleWIB(date = new Date()) {
  const p = toWIBParts(date);
  let year = p.year;
  let month = p.month; // 0-indexed
  if (p.day < 28) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return new Date(Date.UTC(year, month, 28, 0, 0, 0) - WIB_OFFSET_MS);
}

/** Midnight WIB (00:00 UTC+7) of the given day, as a real UTC instant. */
function startOfTodayWIB(date = new Date()) {
  const shifted = new Date(date.getTime() + WIB_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - WIB_OFFSET_MS);
}

/**
 * "Now", except if we're within `graceMinutes` of WIB midnight, pretend it's
 * just before midnight instead. A "recap at day's end" job is meant to
 * summarize the day/cycle that just finished — if the trigger actually lands
 * a few minutes into the new day (a slightly-late external cron, a retry,
 * etc.), feeding this into startOfTodayWIB/startOfCycleWIB instead of a bare
 * `new Date()` keeps it resolving to the period that just ended rather than
 * the fresh, nearly-empty one that just started.
 */
function wibNowWithGrace(graceMinutes = 10) {
  const now = new Date();
  const p = toWIBParts(now);
  const minutesIntoDay = p.hours * 60 + p.minutes;
  if (minutesIntoDay < graceMinutes) {
    return new Date(now.getTime() - (minutesIntoDay + 1) * 60 * 1000);
  }
  return now;
}

module.exports = {
  formatDateTimeWIB,
  parseDateTimeWIB,
  parseAmount,
  cycleSheetName,
  startOfCycleWIB,
  startOfTodayWIB,
  wibNowWithGrace,
  MONTHS_ID,
  MONTHS_ID_SHORT,
};
