const { google } = require("googleapis");
const { formatDateTimeWIB, parseDateTimeWIB, parseAmount, cycleSheetName } = require("./format");
const { withRetry } = require("./retry");

// Layout per cycle sheet:
//   row 2 : merged section titles  B2:E2 Pengeluaran | G2:J2 Pemasukan
//                                  L2:N2 Rekap Harian | P2:Q2 Rekap Bulanan
//   row 3 : column headers
//   row 4+: data
const BLOCKS = {
  expense: { cols: "B:E", startRow: 4 },
  income: { cols: "G:J", startRow: 4 },
};

const DAILY_RECAP = { cols: "L:N", startRow: 4 };
const MONTHLY_RECAP_CELLS = "P4:Q4";

const DATA_CAP_ROW = 1005;

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !key) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env vars");
  }
  return new google.auth.JWT({ email, key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
}

function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

function getSpreadsheetId() {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error("Missing GOOGLE_SHEET_ID env var");
  return id;
}

function makeId(sheetName, type, row) {
  return `${sheetName}|${type}|${row}`;
}

function parseCompositeId(id) {
  const [sheetName, type, rowStr] = String(id).split("|");
  return { sheetName, type, row: Number(rowStr) };
}

function isMissingSheetError(err) {
  const msg = (err && err.message) || "";
  return /Unable to parse range/.test(msg) || (err && err.code === 400);
}

async function getSheetIdByName(sheetsApi, spreadsheetId, sheetName) {
  const meta = await withRetry(() =>
    sheetsApi.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(sheetId,title))",
    })
  );
  const found = (meta.data.sheets || []).find((s) => s.properties.title === sheetName);
  return found ? found.properties.sheetId : null;
}

/** Creates the cycle sheet with the full layout if it doesn't exist yet. */
async function ensureMonthlySheet(sheetsApi, spreadsheetId, sheetName) {
  let sheetId = await getSheetIdByName(sheetsApi, spreadsheetId, sheetName);
  if (sheetId !== null) return sheetId;

  const addRes = await withRetry(() =>
    sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    })
  );
  sheetId = addRes.data.replies[0].addSheet.properties.sheetId;

  const black = { red: 0, green: 0, blue: 0 };
  const white = { red: 1, green: 1, blue: 1 };
  const red = { red: 1, green: 0, blue: 0 };
  const green = { red: 0, green: 1, blue: 0 };

  // Grid ranges are 0-indexed and end-exclusive: row 2 is index 1, column B is index 1.
  const grid = (r1, r2, c1, c2) => ({ sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 });
  const headerCell = (bg, fg) => ({
    userEnteredFormat: {
      backgroundColor: bg,
      textFormat: { bold: true, foregroundColor: fg },
      horizontalAlignment: "CENTER",
      verticalAlignment: "MIDDLE",
    },
  });
  const headerFields = "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)";

  await withRetry(() =>
    sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          // Section titles on row 2
          { mergeCells: { range: grid(1, 2, 1, 5), mergeType: "MERGE_ALL" } },   // B2:E2
          { mergeCells: { range: grid(1, 2, 6, 10), mergeType: "MERGE_ALL" } },  // G2:J2
          { mergeCells: { range: grid(1, 2, 11, 14), mergeType: "MERGE_ALL" } }, // L2:N2
          { mergeCells: { range: grid(1, 2, 15, 17), mergeType: "MERGE_ALL" } }, // P2:Q2

          // Rows 2-3 of every section: black background, white bold text
          { repeatCell: { range: grid(1, 3, 1, 5), cell: headerCell(black, white), fields: headerFields } },
          { repeatCell: { range: grid(1, 3, 6, 10), cell: headerCell(black, white), fields: headerFields } },
          { repeatCell: { range: grid(1, 3, 11, 14), cell: headerCell(black, white), fields: headerFields } },
          { repeatCell: { range: grid(1, 3, 15, 17), cell: headerCell(black, white), fields: headerFields } },

          // Recap column headers are colour-coded: red = keluar, green = masuk
          { repeatCell: { range: grid(2, 3, 12, 13), cell: headerCell(red, white), fields: headerFields } },   // M3
          { repeatCell: { range: grid(2, 3, 13, 14), cell: headerCell(green, black), fields: headerFields } }, // N3
          { repeatCell: { range: grid(2, 3, 15, 16), cell: headerCell(red, white), fields: headerFields } },   // P3
          { repeatCell: { range: grid(2, 3, 16, 17), cell: headerCell(green, black), fields: headerFields } }, // Q3

          // Notifikasi columns need room and wrapping
          { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, properties: { pixelSize: 200 }, fields: "pixelSize" } },
          { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 10 }, properties: { pixelSize: 200 }, fields: "pixelSize" } },
          { repeatCell: { range: grid(3, DATA_CAP_ROW, 4, 5), cell: { userEnteredFormat: { wrapStrategy: "WRAP" } }, fields: "userEnteredFormat.wrapStrategy" } },
          { repeatCell: { range: grid(3, DATA_CAP_ROW, 9, 10), cell: { userEnteredFormat: { wrapStrategy: "WRAP" } }, fields: "userEnteredFormat.wrapStrategy" } },

          // Tanggal columns are a touch wider than default
          { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },
          { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 6, endIndex: 7 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },
          { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 11, endIndex: 12 }, properties: { pixelSize: 110 }, fields: "pixelSize" } },
        ],
      },
    })
  );

  await withRetry(() =>
    sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `${sheetName}!B2`, values: [["Pengeluaran"]] },
          { range: `${sheetName}!G2`, values: [["Pemasukan"]] },
          { range: `${sheetName}!L2`, values: [["Rekap Harian"]] },
          { range: `${sheetName}!P2`, values: [["Rekap Bulanan"]] },
          { range: `${sheetName}!B3:E3`, values: [["Tanggal", "Jumlah", "Aplikasi", "Notifikasi"]] },
          { range: `${sheetName}!G3:J3`, values: [["Tanggal", "Jumlah", "Aplikasi", "Notifikasi"]] },
          { range: `${sheetName}!L3:N3`, values: [["Tanggal", "Pengeluaran", "Pemasukan"]] },
          { range: `${sheetName}!P3:Q3`, values: [["Pengeluaran", "Pemasukan"]] },
        ],
      },
    })
  );

  return sheetId;
}

/** Finds the first empty row in a block's Tanggal column (fills gaps left by deletes). */
async function findNextRow(sheetsApi, spreadsheetId, sheetName, block) {
  const startCol = block.cols.split(":")[0];
  const res = await withRetry(() =>
    sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!${startCol}${block.startRow}:${startCol}${DATA_CAP_ROW}`,
    })
  );
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0]) return block.startRow + i;
  }
  return block.startRow + rows.length;
}

function readBlockRows(valueRange, sheetName, type, startRow) {
  const out = [];
  (valueRange.values || []).forEach((row, i) => {
    if (row[0] === undefined || row[0] === "") return;
    const parsedDate = parseDateTimeWIB(row[0]);
    out.push({
      id: makeId(sheetName, type, startRow + i),
      type,
      date: parsedDate ? formatDateTimeWIB(parsedDate) : String(row[0] || ""),
      amount: parseAmount(row[1]),
      source: row[2] || "",
      raw: row[3] || "",
    });
  });
  return out;
}

async function listTransactionsForSheet(sheetsApi, spreadsheetId, sheetName) {
  let res;
  try {
    res = await withRetry(() =>
      sheetsApi.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: [
          `${sheetName}!B${BLOCKS.expense.startRow}:E${DATA_CAP_ROW}`,
          `${sheetName}!G${BLOCKS.income.startRow}:J${DATA_CAP_ROW}`,
        ],
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    );
  } catch (err) {
    if (isMissingSheetError(err)) return [];
    throw err;
  }

  const [expenseRange, incomeRange] = res.data.valueRanges;
  return [
    ...readBlockRows(expenseRange, sheetName, "expense", BLOCKS.expense.startRow),
    ...readBlockRows(incomeRange, sheetName, "income", BLOCKS.income.startRow),
  ];
}

/**
 * Groups a sheet's transactions into per-day totals plus a whole-cycle total.
 * Pure so it can be unit-tested without touching the API.
 */
function computeRecap(transactions) {
  const byDay = new Map();
  let totalExpense = 0;
  let totalIncome = 0;

  for (const t of transactions) {
    const parsed = parseDateTimeWIB(t.date);
    if (!parsed) continue;
    const dayKey = formatDateTimeWIB(parsed).slice(0, 11); // "08 Sep 2026"

    if (!byDay.has(dayKey)) byDay.set(dayKey, { sortKey: 0, expense: 0, income: 0 });
    const entry = byDay.get(dayKey);
    // Sort on the day itself, not the first transaction seen for it.
    entry.sortKey = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());

    if (t.type === "expense") {
      entry.expense += t.amount;
      totalExpense += t.amount;
    } else {
      entry.income += t.amount;
      totalIncome += t.amount;
    }
  }

  const daily = [...byDay.entries()]
    .sort((a, b) => a[1].sortKey - b[1].sortKey)
    .map(([day, v]) => [day, v.expense, v.income]);

  return { daily, totalExpense, totalIncome };
}

/**
 * Recomputes the Rekap Harian and Rekap Bulanan blocks from the sheet's own
 * rows. Values (not formulas) are written so the numbers can be verified
 * offline and don't depend on spreadsheet formula behaviour.
 */
async function refreshRecap(sheetsApi, spreadsheetId, sheetName) {
  const transactions = await listTransactionsForSheet(sheetsApi, spreadsheetId, sheetName);
  const { daily, totalExpense, totalIncome } = computeRecap(transactions);

  // Clear first: a deleted transaction can leave the recap shorter than before.
  await withRetry(() =>
    sheetsApi.spreadsheets.values.clear({
      spreadsheetId,
      range: `${sheetName}!L${DAILY_RECAP.startRow}:N${DATA_CAP_ROW}`,
    })
  );

  const data = [{ range: `${sheetName}!${MONTHLY_RECAP_CELLS}`, values: [[totalExpense, totalIncome]] }];
  if (daily.length) {
    data.push({
      range: `${sheetName}!L${DAILY_RECAP.startRow}:N${DAILY_RECAP.startRow + daily.length - 1}`,
      values: daily,
    });
  }

  await withRetry(() =>
    sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "RAW", data },
    })
  );
}

async function appendTransaction({ type, amount, source, raw, date }) {
  const block = BLOCKS[type];
  if (!block) throw new Error(`unknown transaction type: ${type}`);

  const sheetsApi = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const when = date ? new Date(date) : new Date();
  const sheetName = cycleSheetName(when);
  const tanggal = formatDateTimeWIB(when);

  await ensureMonthlySheet(sheetsApi, spreadsheetId, sheetName);
  const row = await findNextRow(sheetsApi, spreadsheetId, sheetName, block);

  const [startCol, endCol] = block.cols.split(":");
  await withRetry(() =>
    sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!${startCol}${row}:${endCol}${row}`,
      // RAW, not USER_ENTERED: otherwise Sheets reinterprets the date string as
      // its own datetime type and the amount as currency, and reading them back
      // gives "Rp.11.000,00" / a serial number instead of what we wrote.
      valueInputOption: "RAW",
      requestBody: { values: [[tanggal, amount, source || "", raw || ""]] },
    })
  );

  // The recap is derived data; a failure here must not lose the transaction.
  try {
    await refreshRecap(sheetsApi, spreadsheetId, sheetName);
  } catch (err) {
    console.error("Recap refresh failed:", err.message);
  }

  return { id: makeId(sheetName, type, row), type, amount, source: source || "", raw: raw || "", date: tanggal };
}

/** Reads the current cycle sheet plus `monthsBack` previous cycles, newest first. */
async function listTransactions({ monthsBack = 1 } = {}) {
  const sheetsApi = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const now = new Date();
  const cappedMonthsBack = Math.max(0, Math.min(monthsBack, 24));

  const sheetNames = [];
  for (let i = 0; i <= cappedMonthsBack; i++) {
    sheetNames.push(cycleSheetName(now, i));
  }

  const perSheet = await Promise.all(
    sheetNames.map((name) => listTransactionsForSheet(sheetsApi, spreadsheetId, name))
  );
  const all = perSheet.flat();

  all.sort((a, b) => {
    const da = parseDateTimeWIB(a.date);
    const db = parseDateTimeWIB(b.date);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });

  return all;
}

async function updateTransaction(id, updates) {
  const { sheetName, type, row } = parseCompositeId(id);
  const block = BLOCKS[type];
  if (!block || !row) return null;

  const sheetsApi = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const [startCol, endCol] = block.cols.split(":");
  const range = `${sheetName}!${startCol}${row}:${endCol}${row}`;

  const existingRes = await withRetry(() =>
    sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const existing = (existingRes.data.values && existingRes.data.values[0]) || ["", "", "", ""];
  const [rawTanggal, jumlah, sumber, notifikasi] = existing;

  // Rewrite the date in canonical form so a legacy coerced row heals the
  // moment it's edited, instead of staying a Sheets serial forever.
  const parsedDate = parseDateTimeWIB(rawTanggal);
  const tanggal = parsedDate ? formatDateTimeWIB(parsedDate) : String(rawTanggal || "");

  const merged = [
    tanggal,
    updates.amount !== undefined ? updates.amount : parseAmount(jumlah),
    updates.source !== undefined ? updates.source : sumber,
    updates.raw !== undefined ? updates.raw : notifikasi,
  ];

  await withRetry(() =>
    sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [merged] },
    })
  );

  try {
    await refreshRecap(sheetsApi, spreadsheetId, sheetName);
  } catch (err) {
    console.error("Recap refresh failed:", err.message);
  }

  return { id, type, date: tanggal, amount: parseAmount(merged[1]), source: merged[2] || "", raw: merged[3] || "" };
}

async function deleteTransaction(id) {
  const { sheetName, type, row } = parseCompositeId(id);
  const block = BLOCKS[type];
  if (!block || !row) return false;

  const sheetsApi = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const [startCol, endCol] = block.cols.split(":");

  await withRetry(() =>
    sheetsApi.spreadsheets.values.clear({
      spreadsheetId,
      range: `${sheetName}!${startCol}${row}:${endCol}${row}`,
    })
  );

  try {
    await refreshRecap(sheetsApi, spreadsheetId, sheetName);
  } catch (err) {
    console.error("Recap refresh failed:", err.message);
  }

  return true;
}

module.exports = {
  appendTransaction,
  listTransactions,
  updateTransaction,
  deleteTransaction,
  computeRecap,
};
