// ---------------------------------------------------------------------------
// Auth token lives here and ONLY here: a plain JS variable. It is never put in
// a cookie, localStorage, or sessionStorage, so reloading the page or opening
// the link again destroys it and forces a fresh login. That's also why login
// and dashboard are one page — a navigation would wipe it mid-flow.
// ---------------------------------------------------------------------------
let authToken = null;

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");
const passwordInput = document.getElementById("password");
const togglePassword = document.getElementById("toggle-password");

const ledgerBody = document.getElementById("ledger-body");
const sumIncomeEl = document.getElementById("sum-income");
const sumExpenseEl = document.getElementById("sum-expense");
const periodSelect = document.getElementById("filter-period");
const typeSelect = document.getElementById("filter-type");
const sourceSelect = document.getElementById("filter-source");
const sortSelect = document.getElementById("filter-sort");
const searchBox = document.getElementById("search-box");
const exportBtn = document.getElementById("export-btn");
const loadmoreBtn = document.getElementById("loadmore-btn");
const addBtn = document.getElementById("add-btn");
const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitle = document.getElementById("modal-title");
const modalClose = document.getElementById("modal-close");
const modalCancel = document.getElementById("modal-cancel");
const modalSubmit = document.getElementById("modal-submit");
const txForm = document.getElementById("tx-form");
const txTypeField = document.getElementById("tx-type");
const chartPeriodLabel = document.getElementById("chart-period-label");
const themeToggle = document.getElementById("theme-toggle");
const themeToggleLogin = document.getElementById("theme-toggle-login");

let allTransactions = [];
let chartInstance = null;
let monthsBack = 1;
let editingId = null;
const MAX_MONTHS_BACK = 12;

const MONTHS_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const MONTHS_ID_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function formatIDR(n) {
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}

// Backend returns dates as "08 Sep 2026 07:55:37" (already WIB, display-ready).
// Tolerates 1-digit day/hour in case an older row was reformatted by Sheets.
function parseWIBDateTime(str) {
  if (typeof str !== "string") return null;
  const m = str.trim().match(/^(\d{1,2}) (\w{3}) (\d{4})[ ,]+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mon, yyyy, hh, mi, ss] = m;
  const monthIdx = MONTHS_ID_SHORT.indexOf(mon);
  if (monthIdx === -1) return null;
  const wibAsUTC = Date.UTC(Number(yyyy), monthIdx, Number(dd), Number(hh), Number(mi), Number(ss));
  return new Date(wibAsUTC - WIB_OFFSET_MS);
}

/** The 28th-to-27th billing cycle containing "now", in local device time. */
function getCurrentCycleRange() {
  const now = new Date();
  const day = now.getDate();
  let start, end;
  if (day >= 28) {
    start = new Date(now.getFullYear(), now.getMonth(), 28);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 27);
  } else {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 28);
    end = new Date(now.getFullYear(), now.getMonth(), 27);
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/** All API traffic goes through here so the bearer token is never forgotten. */
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (options.body) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { ...options, headers });

  // Token expired or invalid: drop straight back to the login form.
  if (res.status === 401) {
    handleSessionLost();
    throw new Error("unauthorized");
  }
  return res;
}

function handleSessionLost() {
  authToken = null;
  allTransactions = [];
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  appView.hidden = true;
  loginView.hidden = false;
  loginError.textContent = "Sesi berakhir. Silakan masuk lagi.";
  passwordInput.value = "";
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  loginSubmit.disabled = true;
  loginSubmit.textContent = "Memproses...";

  const form = new FormData(e.target);

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      loginError.textContent = data.error || "Gagal masuk";
      return;
    }

    authToken = data.token;
    loginForm.reset();
    loginView.hidden = true;
    appView.hidden = false;
    loadTransactions();
  } catch (err) {
    loginError.textContent = `Gagal konek ke server: ${err.message}`;
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = "Masuk";
  }
});

togglePassword.addEventListener("click", () => {
  const eyeOpen = togglePassword.querySelector(".eye-open");
  const eyeOff = togglePassword.querySelector(".eye-off");
  const willShow = passwordInput.type === "password";

  passwordInput.type = willShow ? "text" : "password";
  if (eyeOpen) eyeOpen.hidden = willShow;
  if (eyeOff) eyeOff.hidden = !willShow;

  const label = willShow ? "Sembunyikan kata sandi" : "Tampilkan kata sandi";
  togglePassword.title = label;
  togglePassword.setAttribute("aria-label", label);
});

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadTransactions() {
  ledgerBody.innerHTML = '<tr><td colspan="6" class="empty-cell">memuat...</td></tr>';

  let res;
  try {
    res = await api(`/api/transactions?monthsBack=${monthsBack}`);
  } catch (err) {
    if (err.message === "unauthorized") return; // already back at the login form
    ledgerBody.innerHTML = `<tr><td colspan="6" class="empty-cell">Gagal konek ke server: ${escapeHtml(err.message)}</td></tr>`;
    return;
  }

  if (!res.ok) {
    let detail = res.status;
    try {
      const errBody = await res.json();
      if (errBody.error) detail = errBody.error;
    } catch {
      // response wasn't JSON, keep the status code
    }
    ledgerBody.innerHTML = `<tr><td colspan="6" class="empty-cell">Gagal memuat (${escapeHtml(String(detail))}) — cek Vercel Logs</td></tr>`;
    return;
  }

  const data = await res.json();
  allTransactions = data.transactions || [];
  populateSourceOptions();
  renderChart();
  applyAndRender();
  updateLoadMoreButton();
}

function updateLoadMoreButton() {
  if (monthsBack >= MAX_MONTHS_BACK) {
    loadmoreBtn.disabled = true;
    loadmoreBtn.textContent = "Batas riwayat tercapai";
  } else {
    loadmoreBtn.disabled = false;
    loadmoreBtn.textContent = "Muat siklus sebelumnya";
  }
}

function populateSourceOptions() {
  const current = sourceSelect.value;
  const sources = [...new Set(allTransactions.map((t) => t.source).filter(Boolean))].sort();

  sourceSelect.innerHTML = '<option value="all">Semua aplikasi</option>' + sources.map((s) => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join("");

  if (sources.includes(current)) sourceSelect.value = current;
}

function periodStart(period) {
  const now = new Date();
  if (period === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (period === "week") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  if (period === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return null;
}

function getFilteredSorted() {
  const period = periodSelect.value;
  const type = typeSelect.value;
  const source = sourceSelect.value;
  const sort = sortSelect.value;
  const search = searchBox.value.trim().toLowerCase();

  const start = periodStart(period);

  const list = allTransactions.filter((t) => {
    const d = parseWIBDateTime(t.date);
    if (start && (!d || d < start)) return false;
    if (type !== "all" && t.type !== type) return false;
    if (source !== "all" && t.source !== source) return false;
    if (search) {
      const haystack = `${t.source || ""} ${t.raw || ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  list.sort((a, b) => {
    const da = parseWIBDateTime(a.date);
    const db = parseWIBDateTime(b.date);
    const diff = (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
    return sort === "oldest" ? diff : -diff;
  });

  return list;
}

function applyAndRender() {
  const filtered = getFilteredSorted();

  const income = filtered.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expense = filtered.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  sumIncomeEl.textContent = formatIDR(income);
  sumExpenseEl.textContent = formatIDR(expense);

  ledgerBody.innerHTML = "";

  if (!allTransactions.length) {
    ledgerBody.innerHTML = '<tr><td colspan="6" class="empty-cell">Belum ada transaksi</td></tr>';
    return;
  }
  if (!filtered.length) {
    ledgerBody.innerHTML = '<tr><td colspan="6" class="empty-cell">Gak ada transaksi buat filter ini</td></tr>';
    return;
  }

  for (const t of filtered) {
    ledgerBody.appendChild(renderRow(t));
  }
}

function renderRow(t) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td data-label="Tanggal">${escapeHtml(t.date)}</td>
    <td data-label="Jenis"><span class="pill ${t.type}">${t.type === "income" ? "Pemasukan" : "Pengeluaran"}</span></td>
    <td data-label="Aplikasi">${escapeHtml(t.source || "-")}</td>
    <td data-label="Jumlah" class="amount ${t.type}">${t.type === "income" ? "+" : "-"}${formatIDR(t.amount)}</td>
    <td data-label="Keterangan">${escapeHtml(t.raw || "-")}</td>
    <td data-label="Aksi">
      <div class="actions-cell">
        <button class="icon-btn edit" data-action="edit" title="Edit" type="button">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 20h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="icon-btn delete" data-action="delete" title="Hapus" type="button">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M3 6h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </td>
  `;
  tr.querySelector('[data-action="edit"]').addEventListener("click", () => openModal("edit", t));
  tr.querySelector('[data-action="delete"]').addEventListener("click", () => deleteTransaction(t.id));
  return tr;
}

function describeActiveFilters() {
  const label = (sel) => sel.options[sel.selectedIndex].text;
  const parts = [label(periodSelect), label(typeSelect), label(sourceSelect)];
  const search = searchBox.value.trim();
  if (search) parts.push(`pencarian "${search}"`);
  return parts.join(", ");
}

function exportPDF() {
  const rows = getFilteredSorted();
  if (!rows.length) {
    alert("Gak ada data buat di-export (cek filter-nya)");
    return;
  }

  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert("Library PDF gagal dimuat. Cek koneksi internet lalu refresh halaman.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;

  const income = rows.filter((t) => t.type === "income");
  const expense = rows.filter((t) => t.type === "expense");
  const totalIncome = income.reduce((s, t) => s + t.amount, 0);
  const totalExpense = expense.reduce((s, t) => s + t.amount, 0);

  const avg = (list, total) => (list.length ? total / list.length : 0);
  const biggest = (list) => list.reduce((max, t) => (t.amount > max ? t.amount : max), 0);

  // State the window these numbers describe, so the report is never read as
  // "everything" when a filter was active.
  const withDates = rows
    .map((t) => ({ t, d: parseWIBDateTime(t.date) }))
    .filter((x) => x.d)
    .sort((a, b) => a.d - b.d);
  const spanText = withDates.length ? `${withDates[0].t.date} s/d ${withDates[withDates.length - 1].t.date}` : "-";

  const now = new Date();
  const generatedAt = `${String(now.getDate()).padStart(2, "0")} ${MONTHS_ID_SHORT[now.getMonth()]} ${now.getFullYear()} ` + `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  // ---- Header ----
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Laporan Keuangan", margin, 50);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`Dibuat: ${generatedAt}`, margin, 66);
  doc.text(`Rentang data: ${spanText}`, margin, 78);
  doc.text(`Filter aktif: ${describeActiveFilters()}`, margin, 90);
  doc.setTextColor(20);

  // ---- Ringkasan ----
  doc.autoTable({
    startY: 108,
    head: [["Ringkasan", "Pemasukan", "Pengeluaran"]],
    body: [
      ["Total", formatIDR(totalIncome), formatIDR(totalExpense)],
      ["Jumlah transaksi", String(income.length), String(expense.length)],
      ["Rata-rata per transaksi", formatIDR(avg(income, totalIncome)), formatIDR(avg(expense, totalExpense))],
      ["Transaksi terbesar", formatIDR(biggest(income)), formatIDR(biggest(expense))],
    ],
    theme: "grid",
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: "bold" },
    styles: { font: "helvetica", fontSize: 9, cellPadding: 6 },
    columnStyles: {
      0: { cellWidth: 160, fontStyle: "bold" },
      1: { halign: "right", textColor: [5, 150, 105] },
      2: { halign: "right", textColor: [220, 38, 38] },
    },
    margin: { left: margin, right: margin },
  });

  // ---- Per aplikasi ----
  const apps = {};
  for (const t of rows) {
    const key = t.source || "(tanpa nama)";
    if (!apps[key]) apps[key] = { incomeCount: 0, incomeTotal: 0, expenseCount: 0, expenseTotal: 0 };
    if (t.type === "income") {
      apps[key].incomeCount++;
      apps[key].incomeTotal += t.amount;
    } else {
      apps[key].expenseCount++;
      apps[key].expenseTotal += t.amount;
    }
  }

  const appRows = Object.entries(apps)
    .sort((a, b) => b[1].expenseTotal + b[1].incomeTotal - (a[1].expenseTotal + a[1].incomeTotal))
    .map(([name, st]) => {
      const sharePct = totalExpense > 0 ? (st.expenseTotal / totalExpense) * 100 : 0;
      return [name, `${st.incomeCount}x`, formatIDR(st.incomeTotal), `${st.expenseCount}x`, formatIDR(st.expenseTotal), `${sharePct.toFixed(1)}%`];
    });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Rincian per Aplikasi", margin, doc.lastAutoTable.finalY + 26);

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 34,
    head: [["Aplikasi", "Masuk", "Total Masuk", "Keluar", "Total Keluar", "% Pengeluaran"]],
    body: appRows.length ? appRows : [["-", "-", "-", "-", "-", "-"]],
    theme: "grid",
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: "bold" },
    styles: { font: "helvetica", fontSize: 9, cellPadding: 5 },
    columnStyles: {
      1: { halign: "center" },
      2: { halign: "right", textColor: [5, 150, 105] },
      3: { halign: "center" },
      4: { halign: "right", textColor: [220, 38, 38] },
      5: { halign: "right" },
    },
    margin: { left: margin, right: margin },
  });

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(110);
  doc.text('"% Pengeluaran" = porsi aplikasi tsb terhadap total pengeluaran pada rentang ini.', margin, doc.lastAutoTable.finalY + 14);
  doc.setTextColor(20);

  // ---- Pengeluaran terbesar ----
  const topExpenses = expense
    .slice()
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);
  if (topExpenses.length) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("5 Pengeluaran Terbesar", margin, doc.lastAutoTable.finalY + 38);

    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 46,
      head: [["Tanggal", "Aplikasi", "Jumlah", "Keterangan"]],
      body: topExpenses.map((t) => [t.date, t.source || "-", formatIDR(t.amount), t.raw || "-"]),
      theme: "grid",
      headStyles: { fillColor: [220, 38, 38], textColor: 255, fontStyle: "bold" },
      styles: { font: "helvetica", fontSize: 8, cellPadding: 5, overflow: "linebreak" },
      columnStyles: {
        0: { cellWidth: 105 },
        1: { cellWidth: 70 },
        2: { cellWidth: 75, halign: "right" },
      },
      margin: { left: margin, right: margin },
    });
  }

  // ---- Detail semua transaksi ----
  doc.addPage();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Detail Semua Transaksi", margin, 50);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text(`${rows.length} transaksi, urut dari yang terbaru.`, margin, 64);
  doc.setTextColor(20);

  doc.autoTable({
    startY: 76,
    head: [["Tanggal", "Jenis", "Aplikasi", "Jumlah", "Keterangan"]],
    body: rows.map((t) => [t.date, t.type === "income" ? "Pemasukan" : "Pengeluaran", t.source || "-", (t.type === "income" ? "+" : "-") + formatIDR(t.amount), t.raw || "-"]),
    theme: "striped",
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: "bold" },
    styles: { font: "helvetica", fontSize: 8, cellPadding: 4, overflow: "linebreak" },
    columnStyles: {
      0: { cellWidth: 100 },
      1: { cellWidth: 62 },
      2: { cellWidth: 62 },
      3: { cellWidth: 72, halign: "right" },
    },
    // Colour the amount by direction so the sheet stays scannable.
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 3) {
        const isIncome = String(data.cell.raw).startsWith("+");
        data.cell.styles.textColor = isIncome ? [5, 150, 105] : [220, 38, 38];
      }
    },
    margin: { left: margin, right: margin },
  });

  // ---- Page numbers ----
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(130);
    doc.text(`Halaman ${i} dari ${pageCount}`, pageWidth - margin, doc.internal.pageSize.getHeight() - 20, { align: "right" });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(`laporan-keuangan-${stamp}.pdf`);
}

function renderChart() {
  const { start, end } = getCurrentCycleRange();
  const labels = [];
  const incomeByDay = [];
  const expenseByDay = [];

  const cursor = new Date(start);
  while (cursor <= end) {
    const dayStart = new Date(cursor);
    const dayEnd = new Date(cursor);
    dayEnd.setDate(dayEnd.getDate() + 1);

    labels.push(String(cursor.getDate()));

    const dayTx = allTransactions.filter((t) => {
      const d = parseWIBDateTime(t.date);
      return d && d >= dayStart && d < dayEnd;
    });
    incomeByDay.push(dayTx.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0));
    expenseByDay.push(dayTx.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0));

    cursor.setDate(cursor.getDate() + 1);
  }

  chartPeriodLabel.textContent = `${MONTHS_ID[end.getMonth()]} ${end.getFullYear()}`;

  // Pull colors from the active theme's CSS variables so the chart repaints
  // correctly when the user flips between light and dark.
  const styles = getComputedStyle(document.documentElement);
  const tickColor = styles.getPropertyValue("--muted").trim() || "#6b7280";
  const gridColor = styles.getPropertyValue("--grid").trim() || "#e5e7eb";

  const ctx = document.getElementById("trend-chart");
  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Pemasukan",
          data: incomeByDay,
          borderColor: "#38bdf8",
          backgroundColor: "rgba(56,189,248,0.15)",
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: "Pengeluaran",
          data: expenseByDay,
          borderColor: "#fb923c",
          backgroundColor: "rgba(251,146,60,0.15)",
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: { color: tickColor, usePointStyle: true, boxWidth: 8, padding: 16 },
        },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${formatIDR(item.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: tickColor, maxRotation: 0, autoSkip: true } },
        y: { grid: { color: gridColor }, ticks: { color: tickColor, callback: (v) => formatIDR(v) } },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Modal (add / edit)
// ---------------------------------------------------------------------------
function openModal(mode, t) {
  editingId = mode === "edit" ? t.id : null;
  modalTitle.textContent = mode === "edit" ? "Edit Transaksi" : "Tambah Transaksi";
  txForm.reset();

  if (mode === "edit") {
    txForm.type.value = t.type;
    txForm.amount.value = t.amount;
    txForm.source.value = t.source || "";
    txForm.raw.value = t.raw || "";
    txTypeField.disabled = true;
    txTypeField.title = "Jenis gak bisa diubah saat edit — hapus & buat baru kalau perlu ganti jenis";
  } else {
    txTypeField.disabled = false;
    txTypeField.title = "";
  }

  modalBackdrop.hidden = false;
  document.getElementById("tx-amount").focus();
}

function closeModal() {
  modalBackdrop.hidden = true;
  editingId = null;
}

txForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = {
    type: form.get("type"),
    amount: Number(form.get("amount")),
    source: form.get("source") || "manual",
    raw: form.get("raw"),
  };

  modalSubmit.disabled = true;
  modalSubmit.textContent = "Menyimpan...";

  try {
    const url = editingId ? `/api/transactions/${encodeURIComponent(editingId)}` : "/api/transactions";
    const method = editingId ? "PUT" : "POST";

    const res = await api(url, { method, body: JSON.stringify(body) });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      alert(`Gagal menyimpan: ${errBody.error || res.status}`);
      return;
    }

    closeModal();
    loadTransactions();
  } catch (err) {
    if (err.message === "unauthorized") return;
    alert(`Gagal konek ke server: ${err.message}`);
  } finally {
    modalSubmit.disabled = false;
    modalSubmit.textContent = "Simpan";
  }
});

async function deleteTransaction(id) {
  if (!confirm("Hapus transaksi ini?")) return;
  try {
    await api(`/api/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
    loadTransactions();
  } catch (err) {
    if (err.message === "unauthorized") return;
    alert(`Gagal menghapus: ${err.message}`);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str ?? "").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function syncThemeIcons() {
  const isDark = document.documentElement.dataset.theme === "dark";
  for (const btn of [themeToggle, themeToggleLogin]) {
    if (!btn) continue;
    const sun = btn.querySelector(".icon-sun");
    const moon = btn.querySelector(".icon-moon");
    if (sun) sun.hidden = isDark;
    if (moon) moon.hidden = !isDark;
    btn.title = isDark ? "Mode terang" : "Mode gelap";
    btn.setAttribute("aria-label", btn.title);
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch {
    // private mode / storage disabled — the theme still applies for this session
  }
  syncThemeIcons();
  if (chartInstance) renderChart();
}

for (const btn of [themeToggle, themeToggleLogin]) {
  if (btn) btn.addEventListener("click", toggleTheme);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
addBtn.addEventListener("click", () => openModal("add"));
modalClose.addEventListener("click", closeModal);
modalCancel.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalBackdrop.hidden) closeModal();
});

document.getElementById("logout-btn").addEventListener("click", () => {
  // Nothing to call server-side: dropping the token IS the logout.
  authToken = null;
  allTransactions = [];
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  appView.hidden = true;
  loginView.hidden = false;
  loginError.textContent = "";
  passwordInput.value = "";
});

for (const el of [periodSelect, typeSelect, sourceSelect, sortSelect]) {
  el.addEventListener("change", applyAndRender);
}
searchBox.addEventListener("input", applyAndRender);
exportBtn.addEventListener("click", exportPDF);
loadmoreBtn.addEventListener("click", () => {
  monthsBack = Math.min(monthsBack + 1, MAX_MONTHS_BACK);
  loadTransactions();
});

syncThemeIcons();
document.getElementById("username").focus();
