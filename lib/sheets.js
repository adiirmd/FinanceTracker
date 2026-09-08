const { google } = require("googleapis");
const { formatDateTimeWIB, parseDateTimeWIB, parseAmount, cycleSheetName } = require("./format");
const { withRetry } = require("./retry");

// Column layout per monthly sheet (matches the user's own template):
//   B4:E4 "Pengeluaran" (merged) | G2:G5 SUMMARY | I4:L4 "Pemasukan" (merged)
//   B5:E5 Tanggal/Jumlah/Aplikasi/Notifikasi   I5:L5 same headers
//   data starts row 6, one block per transaction type
const BLOCKS = {
  expense: { cols: "B:E", startRow: 6 },
  income: { cols: "I:L", startRow: 6 },
};

const DATA_CAP_ROW = 1005; // formulas and range reads assume data never passes this row

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

/** Creates the monthly sheet (headers, summary formulas, formatting) if it doesn't exist yet. */
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

  const yellow = { red: 1, green: 0.949, blue: 0.6 };
  const green = { red: 0.714, green: 0.843, blue: 0.659 };
  const grid = (r1, r2, c1, c2) => ({ sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 });

  await withRetry(() =>
    sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          { mergeCells: { range: grid(3, 4, 1, 5), mergeType: "MERGE_ALL" } }, // B4:E4
          { mergeCells: { range: grid(3, 4, 8, 12), mergeType: "MERGE_ALL" } }, // I4:L4
          {
            repeatCell: {
              range: grid(3, 5, 1, 5), // B4:E5
              cell: { userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: "CENTER" } },
              fields: "userEnteredFormat(textFormat,horizontalAlignment)",
            },
          },
          {
            repeatCell: {
              range: grid(3, 5, 8, 12), // I4:L5
              cell: { userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: "CENTER" } },
              fields: "userEnteredFormat(textFormat,horizontalAlignment)",
            },
          },
          {
            repeatCell: {
              range: grid(1, 4, 6, 7), // G2:G4
              cell: { userEnteredFormat: { backgroundColor: yellow, textFormat: { bold: true } } },
              fields: "userEnteredFormat(backgroundColor,textFormat)",
            },
          },
          {
            repeatCell: {
              range: grid(4, 5, 6, 7), // G5
              cell: { userEnteredFormat: { backgroundColor: green, textFormat: { bold: true } } },
              fields: "userEnteredFormat(backgroundColor,textFormat)",
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, // E
              properties: { pixelSize: 220 },
              fields: "pixelSize",
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId, dimension: "COLUMNS", startIndex: 11, endIndex: 12 }, // L
              properties: { pixelSize: 220 },
              fields: "pixelSize",
            },
          },
          {
            repeatCell: {
              range: grid(5, DATA_CAP_ROW, 4, 5), // E6:E1005
              cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
              fields: "userEnteredFormat.wrapStrategy",
            },
          },
          {
            repeatCell: {
              range: grid(5, DATA_CAP_ROW, 11, 12), // L6:L1005
              cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
              fields: "userEnteredFormat.wrapStrategy",
            },
          },
        ],
      },
    })
  );

  await withRetry(() =>
    sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          { range: `${sheetName}!B4`, values: [["Pengeluaran"]] },
          { range: `${sheetName}!I4`, values: [["Pemasukan"]] },
          { range: `${sheetName}!B5:E5`, values: [["Tanggal", "Jumlah", "Aplikasi", "Notifikasi"]] },
          { range: `${sheetName}!I5:L5`, values: [["Tanggal", "Jumlah", "Aplikasi", "Notifikasi"]] },
          { range: `${sheetName}!G2`, values: [["SUMMARY"]] },
          { range: `${sheetName}!G3`, values: [[`="Total Pengeluaran: Rp"&TEXT(SUM(C6:C${DATA_CAP_ROW}),"#,##0")`]] },
          { range: `${sheetName}!G4`, values: [[`="Total Pemasukan: Rp"&TEXT(SUM(J6:J${DATA_CAP_ROW}),"#,##0")`]] },
          {
            range: `${sheetName}!G5`,
            values: [[
              `="Selisih: "&IF(SUM(J6:J${DATA_CAP_ROW})-SUM(C6:C${DATA_CAP_ROW})<0,"-","")&"Rp"&TEXT(ABS(SUM(J6:J${DATA_CAP_ROW})-SUM(C6:C${DATA_CAP_ROW})),"#,##0")`,
            ]],
          },
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
      // RAW, not USER_ENTERED: otherwise Sheets reinterprets the date string
      // as its own datetime type and the amount as currency, and reading them
      // back gives "Rp.11.000,00" / a serial number instead of what we wrote.
      valueInputOption: "RAW",
      requestBody: { values: [[tanggal, amount, source || "", raw || ""]] },
    })
  );

  return { id: makeId(sheetName, type, row), type, amount, source: source || "", raw: raw || "", date: tanggal };
}

async function listTransactionsForSheet(sheetsApi, spreadsheetId, sheetName) {
  let res;
  try {
    res = await withRetry(() =>
      sheetsApi.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: [`${sheetName}!B6:E${DATA_CAP_ROW}`, `${sheetName}!I6:L${DATA_CAP_ROW}`],
        valueRenderOption: "UNFORMATTED_VALUE",
      })
    );
  } catch (err) {
    if (isMissingSheetError(err)) return [];
    throw err;
  }

  const [expenseRange, incomeRange] = res.data.valueRanges;
  const out = [];

  // Older rows may have been coerced by Sheets into its own datetime/currency
  // types before writes switched to RAW, so normalize whatever comes back into
  // the one shape the API promises: a canonical WIB string and a plain number.
  const normalizeRow = (row, i, type) => {
    const parsedDate = parseDateTimeWIB(row[0]);
    return {
      id: makeId(sheetName, type, 6 + i),
      type,
      date: parsedDate ? formatDateTimeWIB(parsedDate) : String(row[0] || ""),
      amount: parseAmount(row[1]),
      source: row[2] || "",
      raw: row[3] || "",
    };
  };

  (expenseRange.values || []).forEach((row, i) => {
    if (row[0] === undefined || row[0] === "") return;
    out.push(normalizeRow(row, i, "expense"));
  });

  (incomeRange.values || []).forEach((row, i) => {
    if (row[0] === undefined || row[0] === "") return;
    out.push(normalizeRow(row, i, "income"));
  });

  return out;
}

/** Reads the current billing-cycle sheet plus `monthsBack` previous cycles and merges them, newest first. */
async function listTransactions({ monthsBack = 1 } = {}) {
  const sheetsApi = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const now = new Date();
  const cappedMonthsBack = Math.max(0, Math.min(monthsBack, 24)); // sanity cap

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

  return true;
}

module.exports = {
  appendTransaction,
  listTransactions,
  updateTransaction,
  deleteTransaction,
};
