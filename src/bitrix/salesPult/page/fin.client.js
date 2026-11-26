// Страница «Финансы»: ежедневный отчёт финансиста из чата Битрикс24.
(function () {
  "use strict";

  const P = typeof PAYLOAD !== "undefined" ? PAYLOAD : {};
  const F = P.finance || { snapshots: [] };
  const R = F.report;
  const I = INSIGHTS;
  const el = document.getElementById("tab-fin");

  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = (n) => (n < 0 ? "−" : "");
  const NB = String.fromCharCode(160);
  /** Число для таблиц: «12,3 млн», «250 тыс», «57». */
  function amt(n) {
    const a = Math.abs(n || 0);
    if (a >= 1e9) return `${sign(n)}${nf1.format(a / 1e9)}${NB}млрд`;
    if (a >= 1e6) return `${sign(n)}${nf1.format(a / 1e6)}${NB}млн`;
    if (a >= 1e3) return `${sign(n)}${nf0.format(Math.round(a / 1e3))}${NB}тыс`;
    return `${sign(n)}${nf0.format(Math.round(a))}`;
  }
  const money = (n) => `${amt(n)}${NB}₸`;
  const full = (n) => `${sign(n)}${nf0.format(Math.round(Math.abs(n || 0)))}${NB}₸`;
  /** Меньше половины тенге — пусто, а не «0». */
  const has = (n) => Math.abs(n || 0) >= 0.5;
  const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "—");
  const ddmmyyyy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "—");
  const dayMonth = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS_GEN[Number(iso.slice(5, 7)) - 1]}`;
  const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  const plural = (n, f) => {
    const a = Math.abs(n) % 100, b = a % 10;
    return `${nf0.format(n)} ${a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b > 1 && b < 5 ? f[1] : f[2]}`;
  };
  const short = (s, n) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  const almaty = (iso) => {
    const ms = Date.parse(iso || "");
    if (Number.isNaN(ms)) return "";
    const d = new Date(ms + 5 * 3600000).toISOString();
    return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)}`;
  };
  let blockNo = 0;
  const idx = () => String(++blockNo).padStart(2, "0");
  const head = (title, meta = "") => `<div class="block-head"><h2><span class="idx">${idx()}</span>${title}</h2><span class="meta">${meta}</span></div>`;
  const today = (P.asOfDate || (R && R.dataDate) || "").slice(0, 10);

  function setLabels() {
    const dateLabel = document.getElementById("dateLabel");
    const srcLabel = document.getElementById("srcLabel");
    const liveText = document.getElementById("liveText");
    if (liveText && P.generatedAt) liveText.textContent = P.generatedAt;
    if (!R) return;
    if (dateLabel) dateLabel.textContent = `Данные на ${ddmm(R.dataDate)}${R.periodLabel ? ` · период ${R.periodLabel}` : ""}`;
    if (srcLabel && F.file) srcLabel.textContent = `${F.file.name} · загружен ${almaty(F.file.uploadedAt)}`;
    const foot = document.getElementById("footSource");
    if (foot && F.file) foot.textContent = `Источник: «${F.file.name}» из чата «Финансовый отчет» Битрикс24, загружен ${almaty(F.file.uploadedAt)}`;
  }

  /* ---------- история: маленький график под цифрой ---------- */
  function spark(key) {
    const pts = (F.snapshots || []).filter((s) => typeof s[key] === "number");
    if (pts.length < 2) return "";
    const vals = pts.map((s) => s[key]);
    const min = Math.min(...vals), max = Math.max(...vals);
    const w = 120, h = 26, span = max - min || 1;
    const xy = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`);
    const first = pts[0].dataDate, last = pts[pts.length - 1].dataDate;
    return `<svg class="fin-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="С ${ddmm(first)} по ${ddmm(last)}: от ${esc(money(min))} до ${esc(money(max))}"><polyline points="${xy.join(" ")}" /></svg>`;
  }

  function tileDeltas(key) {
    const { prevDay, week } = I.deltas[key];
    const direction = key === "cash" ? 1 : key === "inventory" ? 0 : -1;
    const delta = (entry, period) => {
      const impact = entry.change * direction;
      return `<span>за ${period} <b class="${impact > 0 ? "good" : impact < 0 ? "bad" : ""}">${entry.change > 0 ? "+" : ""}${money(entry.change)}</b></span>`;
    };
    const values = [
      prevDay && delta(prevDay, prevDay.days === 1 ? "день" : `${prevDay.days} дн.`),
      week && week.days !== prevDay?.days && delta(week, `${week.days} дн.`)
    ].filter(Boolean);
    return values.length ? `<div class="fin-deltas">${values.join("")}</div>` : "";
  }

  const copyButton = (key, label) => `<button type="button" class="btn" data-fin-copy="${key}">${label}</button><span class="fin-copy-status" role="status"></span>`;

  function taxPosition() {
    const gap = I.cashGap;
    return `С учётом КПН к оплате <b>${money(I.totalWithTax)}</b> · ${gap < 0 ? `не хватает <b class="bad">${money(-gap)}</b>` : `запас <b>${money(gap)}</b>`}`;
  }

  function tile(label, value, sub, key, cls = "") {
    return `<div class="fin-tile ${cls}"><span class="label">${label}</span>
      <div class="v">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}${tileDeltas(key)}${spark(key)}</div>`;
  }

  /* ---------- 01: деньги и долги ---------- */
  function overview() {
    const cash = R.cash.total;
    const due = R.payments[0] ? R.payments[0].total : 0;
    const loans = R.liabilities.filter((x) => /^кредит(?!ор)/i.test(x.label));
    const payables = R.liabilities.find((x) => /^кредитор/i.test(x.label)) || R.balances.find((x) => x.code === "3310");
    const cf = R.cashFlow;
    const big = (n) => {
      const unit = (amt(n).match(/(млн|млрд|тыс)$/) || [""])[0];
      return `${unit ? amt(n).slice(0, -unit.length - 1) : amt(n)}<small> ${unit}${NB}₸</small>`;
    };

    const cashSub = cf
      ? `вчера ${money(cf.prev)}${cf.spent != null ? ` · потрачено ${money(cf.spent)}` : ""} · пришло ${money(R.incomingTotal)}`
      : `пришло за день ${money(R.incomingTotal)}`;
    const cover = due ? cash / due : 0;
    const calendarSub = due
      ? (cash >= due ? `денег на счетах хватает` : `<span class="warn">на счетах ${Math.round(cover * 100)}% · не хватает ${money(due - cash)}</span>`)
      : "";
    const dueSub = calendarSub + (R.tax ? `<span class="fin-tax-position">${taxPosition()}</span>` : "");
    const byPay = I.debt.byPayment;
    const debtSub = byPay
      ? `${byPay.overdue.count ? `<span class="bad">просрочено ${money(byPay.overdue.total)} (${byPay.overdue.count})</span>` : "просроченных нет"}<br>непросрочено ${money(byPay.current.total)}${R.problemDebts ? `<br>проблемные ${money(R.problemDebts.total)}` : ""}`
      : `старше 30 дней ${money(I.debt.over30.total)}${I.debt.over60.count ? `<br><span class="bad">старше 60 дней ${money(I.debt.over60.total)}</span>` : ""}${R.problemDebts ? `<br>проблемные ${money(R.problemDebts.total)}` : ""}`;
    const stockSub = I.stock.count ? `без расхода ${money(I.stock.total)} (${I.stock.count} поз.)` : "ТМЦ по компаниям";

    let s = `<section class="block" id="f-overview">${head("Деньги и долги", `на ${dayMonth(R.dataDate)}`)}
      <div class="fin-tiles">
        ${tile("Деньги на счетах", big(cash), cashSub, "cash")}
        ${tile(esc(R.payments[0] ? R.payments[0].label : "Календарь платежей"), big(due), dueSub, "paymentsDue", cash < due ? "is-bad" : "")}
        ${tile("Дебиторка", big(R.debtors.total), debtSub, "debtors")}
        ${tile("Кредиторка", payables ? big(payables.total) : "—", payables ? "долги поставщикам" : "", "payables")}
        ${tile(loans.length ? esc(loans.map((x) => x.label).join(", ")) : "Кредиты", loans.length ? big(loans.reduce((s, x) => s + x.total, 0)) : "—", loans.length ? "остаток по графику" : "", "loans")}
        ${tile("Товар на складе", big(R.cash.inventory), stockSub, "inventory")}
      </div>
      <nav class="fin-jumps" aria-label="Быстрый переход">
        <a class="btn" href="#f-debtors">${byPay ? "Просрочка" : "Дебиторы &gt;60д"}</a>
        ${R.payments.length || R.tax ? '<a class="btn" href="#f-payments">Платежи</a>' : ""}
        ${R.stock?.length ? `<a class="btn" href="${I.stock.count ? "#stockFocus" : "#f-stock"}">Склад без расхода</a>` : ""}
        ${R.pnl.current ? '<a class="btn" href="#f-pnl">Прибыль</a>' : ""}
        ${ST ? '<a class="btn" href="#f-opiu">ОПиУ</a>' : ""}
      </nav>`;
    if ((F.snapshots || []).length < 2) {
      s += `<p class="fin-note">Графики под цифрами появятся, когда в чате накопится несколько дней отчётов.</p>`;
    }
    return s + `</section>`;
  }

  /* ---------- 05: прибыль ---------- */
  function pnl() {
    const cur = R.pnl.current, prev = R.pnl.previous;
    if (!cur) return "";
    const curStart = `${cur.date.slice(0, 8)}01`;
    const curLabel = `1–${Number(cur.date.slice(8, 10))} ${MONTHS_GEN[Number(cur.date.slice(5, 7)) - 1]}`;
    const prevLabel = prev ? MONTHS[Number(prev.date.slice(5, 7)) - 1] : "";
    const rows = R.companies.map((name, i) => ({
      name, rev: cur.revenue.values[i], cost: cur.cost.values[i], exp: cur.expenses.values[i], profit: cur.profit.values[i],
      prevProfit: prev ? prev.profit.values[i] : null
    })).filter((x) => x.rev || x.cost || x.exp || x.profit || x.prevProfit);
    const cell = (n, cls = "") => `<span class="num ${cls}">${has(n) ? esc(amt(n)) : "—"}</span>`;
    const pcls = (n) => (n < 0 ? "bad" : "");
    const margin = cur.revenue.total ? Math.round((cur.profit.total / cur.revenue.total) * 100) : null;
    let s = `<section class="block" id="f-pnl">${head(`Прибыль: ${curLabel}`, `по счетам бухгалтерии · ${esc(curStart.slice(0, 4))}`)}
      <p class="lead">Выручка <b>${money(cur.revenue.total)}</b>, прибыль <b class="${pcls(cur.profit.total)}">${money(cur.profit.total)}</b>${margin !== null ? ` (${margin}% выручки)` : ""}.${prev ? ` За ${prevLabel} целиком прибыль была ${money(prev.profit.total)} при выручке ${money(prev.revenue.total)}.` : ""}</p>
      <div class="fin-scroll"><div class="rows fin-pnl${prev ? "" : " no-prev"}"><div class="r head"><span class="label">Компания</span><span class="label n">Выручка</span><span class="label n">Себестоимость</span><span class="label n">Расходы</span><span class="label n">Прибыль</span>${prev ? `<span class="label n">${esc(prevLabel)}, прибыль</span>` : ""}</div>`;
    for (const x of rows) {
      s += `<div class="r body"><span class="nm" data-l="Компания">${esc(x.name)}</span>${cell(x.rev)}${cell(x.cost)}${cell(x.exp)}${cell(x.profit, pcls(x.profit))}${prev ? cell(x.prevProfit, pcls(x.prevProfit)) : ""}</div>`;
    }
    s += `<div class="r body total"><span class="nm">Итого</span>${cell(cur.revenue.total)}${cell(cur.cost.total)}${cell(cur.expenses.total)}${cell(cur.profit.total, pcls(cur.profit.total))}${prev ? cell(prev.profit.total, pcls(prev.profit.total)) : ""}</div></div></div>`;
    if (R.tax) {
      const parts = R.companies.map((n, i) => (R.tax.values[i] ? `${esc(n)} ${money(R.tax.values[i])}` : "")).filter(Boolean).join(" · ");
      s += `<p class="fin-note">${esc(R.tax.label)} к оплате (оценка на ${ddmm(R.tax.date)}): <b>${money(R.tax.total)}</b>${parts ? ` — ${parts}` : ""}.</p>`;
    }
    return s + `</section>`;
  }

  /* ---------- ОПиУ из книги ФО: статьи по периодам, расшифровка по клику ---------- */
  // Книга ФО приходит в тот же чат (листы «ОПиУ» и «Расш. ОПиУ»). Статья со стрелкой — кнопка:
  // раскрывает свои строки расшифровки под собой, самые крупные за последний период сверху.
  // Период — «по годам» (как видно в файле) или месяцы одного года.
  const ST = F.statement;
  const MON_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const OPIU_LIMIT = 15;
  const ROW_WORDS = ["строка", "строки", "строк"];
  let opiuMode = "years";
  const opiuOpen = new Set();
  const opiuAll = new Set();
  const opiuQuery = new Map();

  function opiuColumns() {
    const all = ST.periods.map((p, i) => ({ ...p, i }));
    if (opiuMode === "years") {
      const years = all.filter((p) => p.kind === "year");
      return years.length ? years : all.filter((p) => p.kind === "month").slice(-12);
    }
    return all.filter((p) => String(p.year) === opiuMode);
  }
  const monthOf = (p) => Number(p.key.slice(5, 7)) - 1;
  const opiuTitle = (p) => (p.kind === "year" ? p.label || String(p.year) : opiuMode === "years" ? `${MON_SHORT[monthOf(p)]} ${p.year}` : MON_SHORT[monthOf(p)]);
  const opiuTitleFull = (p) => (p.kind === "year" ? p.label || String(p.year) : `${MONTHS[monthOf(p)]} ${p.year}`);

  /** Строка расшифровки за колонку: месяц как есть, год — сумма его месяцев. */
  function bdValue(row, col) {
    if (col.kind === "month") return row.months[col.key] || 0;
    let sum = 0;
    for (const key in row.months) if (key.slice(0, 4) === col.key) sum += row.months[key];
    return sum;
  }

  function opiuCell(line, v) {
    if (v == null || (line.kind !== "ratio" && !has(v))) return `<td class="num dim">—</td>`;
    if (line.kind === "ratio") return `<td class="num">${Math.round(v * 100)}%</td>`;
    return `<td class="num${line.kind === "subtotal" && v < 0 ? " bad" : ""}" title="${esc(full(v))}">${esc(amt(v))}</td>`;
  }

  function opiuLead() {
    const years = ST.periods.map((p, i) => ({ ...p, i })).filter((p) => p.kind === "year");
    const last = years[years.length - 1];
    const rev = ST.lines.find((l) => l.code === "010") || ST.lines.find((l) => l.kind === "item");
    const profit = ["300", "200", "100"].map((c) => ST.lines.find((l) => l.code === c)).find(Boolean)
      || [...ST.lines].reverse().find((l) => l.kind === "subtotal");
    const r = last && rev ? rev.values[last.i] : null;
    if (r == null) return "";
    const p = profit ? profit.values[last.i] : null;
    const share = p != null && r ? ` (${Math.round((p / r) * 100)}% выручки)` : "";
    return `<p class="lead">${esc(opiuTitleFull(last))}: выручка <b>${money(r)}</b>${p != null ? `, прибыль <b class="${p < 0 ? "bad" : ""}">${money(p)}</b>${share}` : ""}. Статьи со стрелкой раскрываются строками с листа «Расш. ОПиУ».</p>`;
  }

  function opiuBdData(i, cols) {
    const words = searchKey(opiuQuery.get(i) || "").split(" ").filter(Boolean);
    const rows = ST.lines[i].breakdown.rows
      .map((r) => ({ r, vals: cols.map((c) => bdValue(r, c)) }))
      .filter((x) => x.vals.some(has));
    const lastOf = (x) => x.vals[x.vals.length - 1];
    const absSum = (x) => x.vals.reduce((a, v) => a + Math.abs(v), 0);
    rows.sort((a, b) => lastOf(b) - lastOf(a) || absSum(b) - absSum(a) || collator.compare(a.r.label, b.r.label));
    const matched = words.length ? rows.filter((x) => { const k = searchKey(x.r.label); return words.every((w) => k.includes(w)); }) : rows;
    return { rows, matched, searching: words.length > 0 };
  }

  function opiuFoundText(d) {
    return d.searching ? (d.matched.length ? `найдено: ${plural(d.matched.length, ROW_WORDS)}` : "ничего не найдено") : "";
  }

  function opiuBdRowsHtml(i, cols, d) {
    const span = cols.length + 1;
    const shown = d.searching || opiuAll.has(i) ? d.matched : d.matched.slice(0, OPIU_LIMIT);
    let s = shown.map((x) => `<tr class="bd-row"><th scope="row"><span class="fin-opiu-name fin-opiu-bd-l" title="${esc(x.r.label)}">${esc(x.r.label)}</span></th>${x.vals.map((v) => (has(v) ? `<td class="num" title="${esc(full(v))}">${esc(amt(v))}</td>` : `<td class="num dim">—</td>`)).join("")}</tr>`).join("");
    if (!d.searching && d.matched.length > OPIU_LIMIT) {
      s += `<tr class="bd-foot"><td colspan="${span}"><button type="button" class="btn fin-opiu-all" data-opiu-all="${i}">${opiuAll.has(i) ? `Свернуть до ${OPIU_LIMIT}` : `Показать все ${nf0.format(d.matched.length)}`}</button></td></tr>`;
    }
    return s;
  }

  function opiuBdHtml(i, cols) {
    const line = ST.lines[i];
    const d = opiuBdData(i, cols);
    const last = cols[cols.length - 1];
    const search = d.rows.length > OPIU_LIMIT
      ? `<span class="fin-opiu-search"><input type="search" class="plan-search-input fin-opiu-q" data-opiu-q="${i}" aria-label="Найти в расшифровке «${esc(line.label)}»" placeholder="Найти строку: покупатель, договор…" value="${esc(opiuQuery.get(i) || "")}" autocomplete="off"><span class="dim" data-opiu-found="${i}" aria-live="polite">${opiuFoundText(d)}</span></span>`
      : "";
    const meta = d.rows.length
      ? `${plural(d.rows.length, ROW_WORDS)}${last ? ` · сначала крупные за ${esc(opiuTitleFull(last))}` : ""}`
      : "за эти периоды строк с суммами нет";
    return `<tr class="bd-head"><td colspan="${cols.length + 1}"><div class="fin-opiu-bd-bar"><span>${esc(line.breakdown.title)} · ${meta}</span>${search}</div></td></tr>${opiuBdRowsHtml(i, cols, d)}`;
  }

  function opiuTableHtml() {
    const cols = opiuColumns();
    let s = `<table class="fin-opiu"><thead><tr><th scope="col">Статья</th>${cols.map((c) => `<th scope="col" class="num">${esc(opiuTitle(c))}</th>`).join("")}</tr></thead>`;
    ST.lines.forEach((line, i) => {
      const bd = line.breakdown && line.breakdown.rows.length ? line.breakdown : null;
      const code = line.code ? ` <span class="dim">${esc(line.code)}</span>` : "";
      const name = bd
        ? `<button type="button" class="fin-opiu-name fin-opiu-toggle" data-line="${i}" aria-expanded="${String(opiuOpen.has(i))}" aria-controls="opiu-bd-${i}"><span>${esc(line.label)}${code}</span></button>`
        : `<span class="fin-opiu-name">${esc(line.label)}${code}</span>`;
      s += `<tbody class="fin-opiu-line" data-line="${i}"><tr class="is-${esc(line.kind)}"><th scope="row">${name}</th>${cols.map((c) => opiuCell(line, line.values[c.i])).join("")}</tr></tbody>`;
      if (bd) s += `<tbody class="fin-opiu-bd" id="opiu-bd-${i}" data-line="${i}"${opiuOpen.has(i) ? "" : " hidden"}>${opiuBdHtml(i, cols)}</tbody>`;
    });
    return s + `</table>`;
  }

  /** Перерисовать строки одной расшифровки (поиск, «показать все»): строка с поиском остаётся, фокус не теряется. */
  function rerenderOpiuRows(i) {
    const body = document.getElementById(`opiu-bd-${i}`);
    if (!body) return;
    const cols = opiuColumns();
    const d = opiuBdData(i, cols);
    for (const tr of body.querySelectorAll("tr.bd-row, tr.bd-foot")) tr.remove();
    body.insertAdjacentHTML("beforeend", opiuBdRowsHtml(i, cols, d));
    const found = body.querySelector(`[data-opiu-found="${i}"]`);
    if (found) found.textContent = opiuFoundText(d);
  }

  /** Последние периоды справа: на узком экране сразу показываем их, а не самые старые. */
  function scrollOpiuToLatest() {
    const wrap = document.getElementById("opiuTable");
    if (wrap) wrap.scrollLeft = wrap.scrollWidth;
  }

  function opiuBlock() {
    if (!ST && !F.statementNotice) return "";
    const meta = ST ? [ST.company, ST.unit].filter(Boolean).map(esc).join(" · ") : "";
    let s = `<section class="block" id="f-opiu">${head("ОПиУ", meta || "отчёт о прибылях и убытках")}`;
    if (F.statementNotice) s += `<div class="note-warn">${esc(F.statementNotice)}</div>`;
    if (!ST) return s + `</section>`;
    s += opiuLead();
    if (ST.warnings && ST.warnings.length) s += `<div class="note-warn">Сверка расшифровки: ${ST.warnings.map(esc).join("; ")}.</div>`;
    const years = [...new Set(ST.periods.filter((p) => p.kind === "month").map((p) => p.year))].sort();
    const btn = (v, label) => `<button type="button" data-opiu-period="${v}" aria-pressed="${String(opiuMode === String(v))}">${label}</button>`;
    s += `<div class="chips" id="opiuPeriods" role="group" aria-label="Период ОПиУ">${btn("years", "По годам")}${years.map((y) => btn(y, y)).join("")}</div>`;
    s += `<div class="fin-opiu-wrap" id="opiuTable">${opiuTableHtml()}</div>`;
    if (F.statementFile) s += `<p class="fin-note fin-opiu-src">Книга ФО: ${esc(F.statementFile.name)} · загружена ${almaty(F.statementFile.uploadedAt)} · из чата «Финансовый отчет»</p>`;
    return s + `</section>`;
  }

  /* ---------- 03: платежи ---------- */
  // Все списки свёрнуты, как просили: сверху итог, раскрывается по клику.
  const paymentRows = (list, index) => list.items.map((item, i) => ({ ...item, hint: I.paymentHints?.[index]?.[i] ?? null }))
    .sort((a, b) => b.amount - a.amount);

  function payList(list, index) {
    const rows = paymentRows(list, index);
    const dueBadge = (hint) => hint
      ? ` <span class="fin-due${hint.isSoon ? " warn" : ""}">до ${ddmm(hint.date)} · ${hint.days} дн.</span>`
      : "";
    const word = index === 0 ? ["платёж", "платежа", "платежей"] : ["строка", "строки", "строк"];
    return `<details class="fin-more"><summary>${esc(list.label)} <span class="dim">${plural(rows.length, word)} · ${money(list.total)}</span></summary>
      <div class="rows fin-pay"><div class="r head"><span class="label">Кому</span><span class="label">За что</span><span class="label n">Сумма</span></div>
      ${rows.map((x) => `<div class="r body"><span class="nm" title="${esc(x.payee)}">${esc(short(x.payee, 90))}${x.tag ? ` <span class="partner-tag">${esc(x.tag)}</span>` : ""}${dueBadge(x.hint)}</span><span class="dim">${esc(x.basis || "")}</span><span class="num">${esc(amt(x.amount))}</span></div>`).join("")}
      <div class="r body total"><span class="nm">Итого</span><span></span><span class="num">${esc(amt(list.total))}</span></div></div></details>`;
  }

  function payments() {
    if (!R.payments.length && !R.tax) return "";
    const main = R.payments[0];
    let s = `<section class="block" id="f-payments">${head("Платежи", "как в календаре финансиста")}`;
    if (main || R.tax?.total > 0) {
      const gap = (main?.total ?? 0) - R.cash.total;
      const calendar = main ? `По календарю к оплате <b>${money(main.total)}</b>, на счетах <b>${money(R.cash.total)}</b>${gap > 0 ? ` — не хватает <b class="bad">${money(gap)}</b>` : " — денег хватает"}.` : "";
      s += `<p class="lead">${calendar}${R.tax?.total > 0 ? ` <span class="fin-tax-position">${taxPosition()}.</span>` : ""}</p>`;
    }
    s += R.payments.map(payList).join("");
    s += `<div class="fin-actions">${R.tax ? `<span>КПН к оплате <b>${money(R.tax.total)}</b></span>` : ""}${copyButton("payments", "Скопировать календарь")}</div>`;
    return s + `</section>`;
  }

  /* ---------- 02: дебиторы ---------- */
  let debtFilter = "";
  let debtAge = 0; // 0 = все, 30 = старше 30 дней, 60 = старше 60 дней
  let debtAll = false;
  const debtGroups = {
    overdue: { company: "", all: false },
    current: { company: "", all: false }
  };
  const AGE_FILTERS = [
    { days: 0, label: "Все" },
    { days: 30, label: "Старше 30 дней" },
    { days: 60, label: "Старше 60 дней" }
  ];
  // Сортировка по клику на заголовок: сначала от большего к меньшему (у «№ иска» — от А до Я),
  // повторный клик — наоборот. Строки без значения всегда в конце.
  let debtSort = { key: "amount", dir: -1 };
  function ageCls(days) {
    return days > 60 ? "bad" : days > 30 ? "warn" : "";
  }
  const debtDays = (x) => (x.saleDate && today ? daysBetween(x.saleDate, today) : null);
  /** Дней до даты оплаты на дату сборки; меньше нуля — просрочено. */
  const payDays = (x) => (x.paymentDate && today ? daysBetween(today, x.paymentDate) : null);
  const isOverdueDebtor = (x) => {
    const n = payDays(x);
    return n !== null && n < 0;
  };
  const dayValue = (iso) => (iso ? Date.parse(iso) : null);
  const debtCollator = new Intl.Collator("ru", { sensitivity: "base", numeric: true });
  const DEBT_SORTS = {
    amount: { get: (x) => x.amount },
    days: { get: debtDays },
    payDate: { get: (x) => dayValue(x.paymentDate) },
    toPay: { get: payDays },
    claimDate: { get: (x) => dayValue(x.claimDate) },
    claimNo: { get: (x) => x.claimNumber || null, text: true }
  };
  const firstDir = (key) => (DEBT_SORTS[key] && DEBT_SORTS[key].text ? 1 : -1);
  function debtCompare(a, b) {
    const s = DEBT_SORTS[debtSort.key] || DEBT_SORTS.amount;
    const va = s.get(a), vb = s.get(b);
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      const c = s.text ? debtCollator.compare(va, vb) : va - vb;
      if (c) return c * debtSort.dir;
    }
    return b.amount - a.amount;
  }
  // Необязательные колонки — те, что есть в файле (list.columns). «До оплаты» считается от
  // «Даты оплаты», поэтому без неё не показывается.
  function debtExtras(list) {
    const cols = (list && list.columns) || [];
    const out = [];
    if (cols.includes("paymentDate")) out.push("payDate");
    if (cols.includes("paymentDate") && cols.includes("daysToPay")) out.push("toPay");
    if (cols.includes("claimDate")) out.push("claimDate");
    if (cols.includes("claimNumber")) out.push("claimNo");
    return out;
  }
  const EXTRA_WIDTH = { payDate: "82px", toPay: "88px", claimDate: "84px", claimNo: "minmax(90px, 1.2fr)" };
  // Ширины колонок из файла — переменной на таблице: сетку задаёт fin.css, и на телефоне её
  // можно перестроить без !important.
  const debtExtraWidths = (extras) => extras.map((k) => EXTRA_WIDTH[k]).join(" ");
  /** Дата для таблицы: «05.12», год — если не текущий. */
  const shortDate = (iso) => (iso ? ddmm(iso) + (iso.slice(0, 4) !== today.slice(0, 4) ? "." + iso.slice(2, 4) : "") : "—");
  function payDaysText(n) {
    if (n === null) return "—";
    if (n === 0) return "сегодня";
    return n < 0 ? `−${plural(-n, ["день", "дня", "дней"])}` : plural(n, ["день", "дня", "дней"]);
  }
  const payDaysTitle = (n) => (n === null ? "" : n < 0 ? `просрочено на ${plural(-n, ["день", "дня", "дней"])}` : n === 0 ? "оплата сегодня" : `до оплаты ${plural(n, ["день", "дня", "дней"])}`);
  function extraCell(key, x) {
    if (key === "payDate") return `<span class="num dim">${shortDate(x.paymentDate)}</span>`;
    if (key === "toPay") {
      const n = payDays(x);
      return `<span class="num ${n !== null && n < 0 ? "bad" : ""}"${n !== null ? ` title="${esc(payDaysTitle(n))}"` : ""}>${payDaysText(n)}</span>`;
    }
    if (key === "claimDate") return `<span class="num dim">${shortDate(x.claimDate)}</span>`;
    return `<span class="fin-debt-claim"${x.claimNumber ? ` title="${esc(x.claimNumber)}"` : ""}>${x.claimNumber ? esc(short(x.claimNumber, 60)) : "—"}</span>`;
  }
  /** На телефоне колонок нет: дата оплаты и иск — строкой под названием. */
  function debtMobileLine(x, extras) {
    const parts = [];
    if (extras.includes("payDate") && x.paymentDate) {
      const n = payDays(x);
      parts.push(`оплата ${esc(shortDate(x.paymentDate))}${n !== null && extras.includes("toPay") ? ` · <span class="${n < 0 ? "bad" : ""}">${esc(payDaysTitle(n))}</span>` : ""}`);
    }
    if (x.claimDate || x.claimNumber) parts.push(`иск${x.claimDate ? " " + esc(shortDate(x.claimDate)) : ""}${x.claimNumber ? " · " + esc(short(x.claimNumber, 60)) : ""}`);
    return parts.length ? `<span class="fin-debt-m">${parts.join(" · ")}</span>` : "";
  }
  function debtRowHtml(x, extras) {
    const days = debtDays(x);
    return `<div class="r body"><span class="nm" title="${esc(x.name)}">${esc(short(x.name, 80))}${x.note ? `<span class="fin-debt-note">${esc(x.note)}</span>` : ""}${debtMobileLine(x, extras)}</span>
      <span class="dim">${esc(x.company)}</span><span class="num">${esc(amt(x.amount))}</span>
      <span class="num dim">${shortDate(x.saleDate)}</span>
      <span class="num ${days !== null ? ageCls(days) : ""}">${days !== null ? plural(days, ["день", "дня", "дней"]) : "—"}</span>${extras.map((k) => extraCell(k, x)).join("")}</div>`;
  }
  function debtTotalRow(list, count, totalSum) {
    const extras = debtExtras(list);
    return `<div class="r total"><span class="nm">Итого</span><span class="dim">${plural(count, ["долг", "долга", "долгов"])}</span><span class="num">${esc(amt(totalSum))}</span><span></span><span></span>${extras.map(() => "<span></span>").join("")}</div>`;
  }
  // Фильтры по компании и возрасту — только для основного списка: кнопки стоят внутри него.
  function debtRows(list, limit, byCompany) {
    const extras = debtExtras(list);
    const rows = list.rows.filter((x) => {
      if (byCompany && debtFilter && x.company !== debtFilter) return false;
      if (byCompany && debtAge > 0) {
        const days = debtDays(x);
        if (days === null || days <= debtAge) return false;
      }
      return true;
    }).sort(debtCompare);
    const shown = limit ? rows.slice(0, limit) : rows;
    const html = shown.map((x) => debtRowHtml(x, extras)).join("");
    return { html, total: rows.length, sum: rows.reduce((s, x) => s + x.amount, 0) };
  }
  function debtGroupRows(list, kind, limit) {
    const state = debtGroups[kind];
    const extras = debtExtras(list);
    const inGroup = list.rows.filter((x) => (kind === "overdue" ? isOverdueDebtor(x) : !isOverdueDebtor(x)));
    const rows = inGroup.filter((x) => !state.company || x.company === state.company).sort(debtCompare);
    const shown = limit ? rows.slice(0, limit) : rows;
    const html = shown.map((x) => debtRowHtml(x, extras)).join("");
    return { html, total: rows.length, sum: rows.reduce((s, x) => s + x.amount, 0), groupTotal: inGroup.length, inGroup };
  }
  // Как сортировка на «Планах»: заголовок колонки с aria-sort, внутри кнопка, стрелки ↓ ↑ ↕.
  function sortBtn(key, label, what, full) {
    const on = debtSort.key === key;
    const ariaSort = on ? (debtSort.dir > 0 ? "ascending" : "descending") : "none";
    const arrow = on ? (debtSort.dir > 0 ? "↑" : "↓") : "↕";
    const nextDir = on ? -debtSort.dir : firstDir(key);
    const next = DEBT_SORTS[key].text ? (nextDir > 0 ? "от А до Я" : "от Я до А") : nextDir < 0 ? "от большего к меньшему" : "от меньшего к большему";
    const cls = DEBT_SORTS[key].text ? "label" : "label n";
    return `<span class="${cls}" role="columnheader" aria-sort="${ariaSort}"><button type="button" class="fin-sort" data-sort="${key}" title="${full ? esc(full) + ". " : ""}Сортировать ${what}: ${next}">${label} <span class="ar" aria-hidden="true">${arrow}</span></button></span>`;
  }
  const EXTRA_HEAD = {
    payDate: ["Оплата", "по дате оплаты", "Дата оплаты"],
    toPay: ["До оплаты", "по дням до оплаты", "Дней до оплаты; минус — просрочено"],
    claimDate: ["Иск подан", "по дате подачи иска", "Дата подачи иска"],
    claimNo: ["№ иска", "по номеру иска", "Номер иска"]
  };
  const debtHead = (list) => {
    const extras = debtExtras(list);
    return `<div class="r head fin-sortable"><span class="label">Должник</span><span class="label">Компания</span>${sortBtn("amount", "Сумма", "по сумме")}<span class="label n">Реализация</span>${sortBtn("days", "Прошло", "по дням с реализации")}${extras.map((k) => sortBtn(k, EXTRA_HEAD[k][0], EXTRA_HEAD[k][1], EXTRA_HEAD[k][2])).join("")}</div>`;
  };
  /** Таблица с колонками из файла шире экрана ноутбука не бывает, но на узком окне прокручивается. */
  const debtTable = (list, inner) => {
    const extras = debtExtras(list);
    return extras.length
      ? `<div class="fin-scroll"><div class="rows fin-debt wide" style="--debt-extra: ${debtExtraWidths(extras)}">${inner}</div></div>`
      : `<div class="rows fin-debt">${inner}</div>`;
  };

  function debtMainHtml() {
    const D = R.debtors;
    const companyGroup = D.companies.length > 1
      ? `<div class="fin-debt-filter-group"><span class="label">Компания</span><div class="chips" id="debtChips" role="group" aria-label="Компания">${["", ...D.companies].map((c) => `<button type="button" data-c="${esc(c)}" aria-pressed="${String(c === debtFilter)}">${c ? esc(c) : "Все"}</button>`).join("")}</div></div>`
      : "";
    const ageGroup = `<div class="fin-debt-filter-group"><span class="label">Возраст</span><div class="chips" id="debtAgeChips" role="group" aria-label="Возраст с даты реализации">${AGE_FILTERS.map((f) => `<button type="button" data-age="${f.days}" aria-pressed="${String(f.days === debtAge)}">${esc(f.label)}</button>`).join("")}</div></div>`;
    const main = debtRows(D, debtAll ? 0 : 12, true);
    const asOfText = today ? `Отсчёт возраста с даты реализации на ${esc(ddmmyyyy(today))}` : "Возраст с даты реализации";
    const filterSummary = (debtFilter || debtAge > 0) ? ` · по фильтру: ${plural(main.total, ["долг", "долга", "долгов"])} на ${money(main.sum)}` : "";
    const bodyHtml = main.html || `<div class="fin-debt-empty">По выбранным фильтрам долгов нет.</div>`;
    let s = `<div class="fin-debt-filters">${companyGroup}${ageGroup}</div>`;
    s += `<div class="fin-debt-meta">${asOfText}${filterSummary}</div>`;
    s += debtTable(D, `${debtHead(D)}${bodyHtml}`);
    if (main.total > 12) {
      s += `<button type="button" class="btn fin-showall" id="debtAll">${debtAll ? "Свернуть" : `Показать все ${main.total} на ${money(main.sum)}`}</button>`;
    }
    return s;
  }
  function debtGroupHtml(kind) {
    const D = R.debtors;
    const state = debtGroups[kind];
    const res = debtGroupRows(D, kind, state.all ? 0 : 12);
    if (!res.groupTotal) {
      return `<div class="fin-debt-empty">${kind === "overdue" ? "Просроченных долгов нет." : "Непросроченных долгов нет."}</div>`;
    }
    const companies = D.companies.filter((c) => res.inGroup.some((x) => x.company === c));
    const companyGroup = companies.length > 1
      ? `<div class="fin-debt-filters"><div class="fin-debt-filter-group"><span class="label">Компания</span><div class="chips" role="group" aria-label="Компания">${["", ...companies].map((c) => `<button type="button" data-debt-group="${kind}" data-c="${esc(c)}" aria-pressed="${String(c === state.company)}">${c ? esc(c) : "Все"}</button>`).join("")}</div></div></div>`
      : "";
    const undated = kind === "current" ? res.inGroup.filter((x) => !x.paymentDate && (!state.company || x.company === state.company)) : [];
    const undatedSum = undated.reduce((s, x) => s + x.amount, 0);
    const baseMeta = kind === "overdue"
      ? `Срок оплаты прошёл до ${esc(ddmmyyyy(today))}`
      : `Срок оплаты от ${esc(ddmmyyyy(today))}`;
    const undatedMeta = undated.length ? ` · без даты оплаты: ${undated.length} на ${money(undatedSum)}` : "";
    const filterMeta = state.company ? ` · по фильтру: ${plural(res.total, ["долг", "долга", "долгов"])} на ${money(res.sum)}` : "";
    const bodyHtml = res.html
      ? `${res.html}${debtTotalRow(D, res.total, res.sum)}`
      : `<div class="fin-debt-empty">По выбранной компании долгов нет.</div>`;
    let s = `${companyGroup}<div class="fin-debt-meta">${baseMeta}${undatedMeta}${filterMeta}</div>`;
    s += debtTable(D, `${debtHead(D)}${bodyHtml}`);
    if (res.total > 12) {
      s += `<button type="button" class="btn fin-showall" data-debt-all="${kind}">${state.all ? "Свернуть" : `Показать все ${res.total} на ${money(res.sum)}`}</button>`;
    }
    return s;
  }
  const debtProblemHtml = () => debtTable(R.problemDebts, `${debtHead(R.problemDebts)}${debtRows(R.problemDebts, 0).html}`);

  function debtFocus() {
    const byPay = I.debt.byPayment;
    const summary = ({ count, total }) => `${plural(count, ["долг", "долга", "долгов"])} · ${money(total)}`;
    if (byPay) {
      const { overdue, current } = byPay;
      const rows = overdue.top5.map((x) => `<li><span><strong>${esc(x.name)}</strong><span class="fin-focus-meta">${esc(x.company)} · оплата ${ddmmyyyy(x.paymentDate)}</span></span>
        <span class="fin-focus-value">${money(x.amount)}<span class="fin-focus-meta bad">−${plural(x.overdueDays, ["день", "дня", "дней"])}</span></span></li>`).join("");
      return `<div class="fin-debt-focus">
        <h3>Дебиторы по сроку оплаты</h3>
        <p class="lead fin-focus-meta">На ${ddmmyyyy(today)}${debtExtras(R.debtors).includes("toPay") ? " · «До оплаты» — дней до даты оплаты, с минусом и красным — просрочено" : ""}</p>
        <div class="fin-age-summary"><span>Просроченная <b class="${overdue.count ? "bad" : ""}">${summary(overdue)}</b></span><span>Непросроченная <b>${summary(current)}</b></span></div>
        ${rows ? `<ol class="fin-focus-list" aria-label="Топ-5 просроченных должников">${rows}</ol>
          <div class="fin-actions"><button type="button" class="btn" data-debt-open="overdue">Открыть просроченные (${overdue.count})</button>${copyButton("debt", "Скопировать для чата")}</div>`
          : `<p class="fin-note">Просроченных долгов на ${ddmmyyyy(today)} нет.</p>`}
        </div>`;
    }
    const { over30, over60, top5 } = I.debt;
    const age = over60.count ? 60 : 30;
    const rows = top5.map((x) => `<li><span><strong>${esc(x.name)}</strong><span class="fin-focus-meta">${esc(x.company)} · ${ddmmyyyy(x.saleDate)}</span></span>
      <span class="fin-focus-value">${money(x.amount)}<span class="fin-focus-meta ${ageCls(x.days)}">${x.days} дн.</span></span></li>`).join("");
    return `<div class="fin-debt-focus">
      <h3>Долги с даты реализации</h3>
      <p class="lead fin-focus-meta">Возраст на ${ddmmyyyy(today)}${debtExtras(R.debtors).includes("toPay") ? " · «До оплаты» — дней до даты оплаты, с минусом и красным — просрочено" : ""}</p>
      <div class="fin-age-summary"><span>Старше 30 дней <b>${summary(over30)}</b></span><span>Старше 60 дней <b class="${over60.count ? "bad" : ""}">${summary(over60)}</b></span></div>
      ${rows ? `<ol class="fin-focus-list" aria-label="Топ-5 должников старше 30 дней">${rows}</ol>
        <div class="fin-actions"><button type="button" class="btn" data-debt-focus="${age}">Показать всех старше ${age} дн.</button>${copyButton("debt", "Скопировать для чата")}</div>` : ""}
      </div>`;
  }

  // Как в «Платежах»: шапка с итогом, списки свёрнуты. Перерисовывается только содержимое,
  // поэтому раскрытый блок не закрывается от фильтра или сортировки.
  function debtorsBlock() {
    const D = R.debtors;
    const byPay = I.debt.byPayment;
    const byCompany = D.companies.map((c, i) => `${esc(c)} ${money(D.totals[i])}`).join(" · ");
    const companyList = (xs) => xs.map((x) => `${esc(x.company)} ${money(x.total)}`).join(" · ");
    let s = `${head("Дебиторы", `${plural(D.rows.length, ["долг", "долга", "долгов"])} · ${money(D.total)}`)}
      ${debtFocus()}
      ${byCompany ? `<p class="fin-note">${byCompany}.</p>` : ""}`;
    if (byPay) {
      const { overdue, current } = byPay;
      const overMeta = overdue.count
        ? `<span class="bad">${plural(overdue.count, ["долг", "долга", "долгов"])} · ${money(overdue.total)}</span>${overdue.byCompany.length > 1 ? ` · ${companyList(overdue.byCompany)}` : ""}`
        : `нет · 0${NB}₸`;
      const curMeta = current.count
        ? `${plural(current.count, ["долг", "долга", "долгов"])} · ${money(current.total)}${current.byCompany.length > 1 ? ` · ${companyList(current.byCompany)}` : ""}`
        : `нет · 0${NB}₸`;
      s += `<details class="fin-more" id="debtOverdueBox"><summary>Просроченная задолженность <span class="dim">${overMeta}</span></summary>
          <div id="debtOverdue">${debtGroupHtml("overdue")}</div></details>
        <details class="fin-more" id="debtCurrentBox"><summary>Непросроченная задолженность <span class="dim">${curMeta}</span></summary>
          <div id="debtCurrent">${debtGroupHtml("current")}</div></details>`;
    } else {
      s += `<details class="fin-more" id="debtMainBox"><summary>Список дебиторов <span class="dim">${plural(D.rows.length, ["долг", "долга", "долгов"])} · ${money(D.total)}</span></summary>
        <div id="debtMain">${debtMainHtml()}</div></details>`;
    }
    if (R.problemDebts && R.problemDebts.rows.length) {
      const pd = R.problemDebts.rows;
      s += `<details class="fin-more" id="debtProblemBox"><summary>Проблемные долги <span class="dim">${plural(pd.length, ["долг", "долга", "долгов"])} · ${money(pd.reduce((a, x) => a + x.amount, 0))} · суды, исполнительные листы, списания</span></summary>
        <div id="debtProblem">${debtProblemHtml()}</div></details>`;
    }
    return s;
  }

  /* ---------- 06: деньги по банкам ---------- */
  function cashBlock() {
    const C = R.cash;
    const used = C.banks.map((_, i) => i).filter((i) => has(C.byBank[i]) || C.rows.some((r) => has(r.byBank[i])));
    const tpl = `grid-template-columns: minmax(120px, 1.3fr) repeat(${used.length + 2}, minmax(0, 1fr));`;
    const cell = (n) => `<span class="num">${has(n) ? esc(amt(n)) : "—"}</span>`;
    let s = `<section class="block" id="f-cash">${head("Деньги по банкам", `всего ${money(C.total)} · ТМЦ ${money(C.inventory)}`)}
      <div class="fin-scroll"><div class="rows fin-cash"><div class="r head" style="${tpl}"><span class="label">Компания</span>${used.map((i) => `<span class="label n">${esc(C.banks[i])}</span>`).join("")}<span class="label n">Всего</span><span class="label n">ТМЦ</span></div>`;
    for (const r of C.rows) {
      s += `<div class="r body" style="${tpl}"><span class="nm">${esc(r.company)}</span>${used.map((i) => cell(r.byBank[i])).join("")}${cell(r.total)}${cell(r.inventory)}</div>`;
    }
    s += `<div class="r body total" style="${tpl}"><span class="nm">Итого</span>${used.map((i) => cell(C.byBank[i])).join("")}${cell(C.total)}${cell(C.inventory)}</div></div></div>`;
    if (R.cashFlow) {
      const cf = R.cashFlow;
      s += `<p class="fin-note">Остаток ${cf.prevDate ? `на ${ddmm(cf.prevDate)}` : "вчера"}: ${full(cf.prev)} → сейчас ${full(cf.today)}.${cf.withoutIncoming != null ? ` Без поступлений было бы ${full(cf.withoutIncoming)}.` : ""}${cf.spent != null ? ` Потрачено ${full(cf.spent)}.` : ""}</p>`;
    }
    return s + `</section>`;
  }

  /* ---------- 04: склад по материальным ведомостям 1С ---------- */
  // Листы «Мат вед …» из того же файла: компания — кнопкой, склады — свёрнутыми списками,
  // поиск по названию товара раскрывает склады, где он есть.
  const nfq = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
  let stockPick = "";
  let stockQuery = "";
  let stockMode = "all";
  const stockList = () => [...(R.stock || [])].sort((a, b) => b.total.end - a.total.end);
  const qty = (n, unit) => (n ? `${nfq.format(n)}${unit ? NB + esc(unit) : ""}` : "—");
  const searchKey = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const stockGone = (item) => !item.endQty && !item.endSum;
  // Спрос открытых лотов Радара и планов по строке склада: ключ позиции и спрос считает сервер (stock/availability.ts).
  const demandByKey = new Map((Array.isArray(P.stockDemand) ? P.stockDemand : []).map((d) => [d.key, d]));
  const DEMAND_TITLE = "Открытые лоты Радара (подать сегодня и обсуждение) и открытые планы того же вида и диагонали; план, по которому есть лот, — один раз.";
  function demandText(x) {
    const d = x.stockKey ? demandByKey.get(x.stockKey) : null;
    if (!d || !(d.lots > 0)) return "";
    return `спрос: ${plural(d.lots, ["лот", "лота", "лотов"])} на ${nfq.format(d.qty)} шт${d.approxLots ? ` · из них ${nf0.format(d.approxLots)} без диагонали в названии` : ""}`;
  }
  const demandHtml = (x) => {
    const text = demandText(x);
    return text ? `<span class="fin-focus-meta fin-stock-demand" title="${esc(DEMAND_TITLE)}">${esc(text)}</span>` : "";
  };
  const stockStagnant = (moves, item) => moves === true && item.startQty > 0 && !(item.outQty > 0) && item.endSum > 0;
  const matchesStock = (words, name, stagnant, gone) =>
    (stockMode !== "stagnant" || stagnant) && (stockMode !== "present" || !gone) && words.every((word) => name.includes(word));

  function stockSums(x, moves) {
    return `на начало ${money(x.start)}${moves ? ` · приход ${money(x.in || 0)} · расход ${money(x.out || 0)}` : ""} · на конец <b>${money(x.end)}</b>`;
  }

  // Сортировка по любому столбцу: числа — сначала от большего, название — от А до Я, повторный
  // клик — наоборот. Одна на все склады и обе компании; по умолчанию — сумма на конец.
  let stockSort = { key: "endSum", dir: -1 };
  const STOCK_COLS = [
    { key: "name", label: "Товар", what: "по названию" },
    { key: "startQty", label: "На начало", what: "по остатку на начало" },
    { key: "inQty", label: "Приход", what: "по приходу", moves: true },
    { key: "outQty", label: "Расход", what: "по расходу", moves: true },
    { key: "endQty", label: "На конец", what: "по остатку на конец" },
    { key: "endSum", label: "Сумма", what: "по сумме на конец" }
  ];
  const collator = new Intl.Collator("ru", { sensitivity: "base", numeric: true });
  // у компании без прихода и расхода сортировка по ним показывается как по сумме
  const stockSortFor = (moves) => (!moves && (stockSort.key === "inQty" || stockSort.key === "outQty") ? { key: "endSum", dir: -1 } : stockSort);
  function stockCompare(sort) {
    return (a, b) => {
      const byName = collator.compare(a.name, b.name);
      if (sort.key === "name") return byName * sort.dir;
      return ((a[sort.key] || 0) - (b[sort.key] || 0)) * sort.dir || b.endSum - a.endSum || byName;
    };
  }
  function stockSortBtn(c, sort) {
    const on = sort.key === c.key;
    const ariaSort = on ? (sort.dir > 0 ? "ascending" : "descending") : "none";
    const arrow = on ? (sort.dir > 0 ? "↑" : "↓") : "↕";
    const nextDir = on ? -sort.dir : c.key === "name" ? 1 : -1;
    const next = c.key === "name" ? (nextDir > 0 ? "от А до Я" : "от Я до А") : nextDir < 0 ? "от большего к меньшему" : "от меньшего к большему";
    return `<span class="label${c.key === "name" ? "" : " n"}" role="columnheader" aria-sort="${ariaSort}"><button type="button" class="fin-sort" data-stock-sort="${c.key}" title="Сортировать ${c.what}: ${next}">${c.label} <span class="ar" aria-hidden="true">${arrow}</span></button></span>`;
  }
  const stockWarehouses = (S) => [...S.warehouses].sort((a, b) => b.sums.end - a.sums.end || b.sums.start - a.sums.start);
  function stockTableHtml(w, moves) {
    const sort = stockSortFor(moves);
    const headRow = `<div class="r head fin-sortable">${STOCK_COLS.filter((c) => moves || !c.moves).map((c) => stockSortBtn(c, sort)).join("")}</div>`;
    const rows = [...w.items].sort(stockCompare(sort)).map((x) => {
      const gone = stockGone(x);
      const stagnant = stockStagnant(moves, x);
      const q0 = (n) => `${nfq.format(n || 0)}${x.unit ? NB + esc(x.unit) : ""}`;
      const mob = `остаток ${nfq.format(x.startQty || 0)} → ${q0(x.endQty)}${x.inQty ? ` · приход ${nfq.format(x.inQty)}` : ""}${x.outQty ? ` · расход ${nfq.format(x.outQty)}` : ""}${stagnant ? " · без расхода" : ""}`;
      return `<div class="r body${gone ? " is-gone" : ""}${stagnant ? " is-stagnant" : ""}" data-n="${esc(searchKey(x.name))}"><span class="nm" title="${esc(x.name)}">${esc(short(x.name, 110))}<span class="fin-stock-m">${mob}</span></span>
          <span class="num dim">${qty(x.startQty, x.unit)}</span>${moves ? `<span class="num dim">${qty(x.inQty)}</span><span class="num dim">${qty(x.outQty)}</span>` : ""}<span class="num">${qty(x.endQty, x.unit)}</span><span class="num">${has(x.endSum) ? esc(amt(x.endSum)) : "—"}</span></div>`;
    }).join("");
    return headRow + rows;
  }

  function stockBodyHtml() {
    const S = stockList().find((x) => x.company === stockPick);
    if (!S) return "";
    const moves = S.hasMoves;
    let s = `<p class="fin-note">${esc(S.company)}: ${stockSums(S.total, moves)}.${moves ? "" : " Прихода и расхода в выгрузке этой компании нет."}</p>`;
    s += stockWarehouses(S).map((w, i) => `<details class="fin-more fin-wh" data-wh="${i}"><summary>${esc(w.name)} <span class="dim">${plural(w.items.length, ["позиция", "позиции", "позиций"])} · ${money(w.sums.end)}</span></summary>
        <p class="fin-note">${stockSums(w.sums, moves)}</p><div class="rows fin-stock${moves ? " moves" : ""}">${stockTableHtml(w, moves)}</div></details>`).join("");
    return s;
  }

  // Сортировка перерисовывает только таблицы внутри складов: раскрытые склады остаются раскрытыми,
  // поиск и фильтр режима применяются заново.
  function resortStock() {
    const S = stockList().find((x) => x.company === stockPick);
    if (!S) return;
    const whs = stockWarehouses(S);
    for (const box of document.querySelectorAll("#stockBody details.fin-wh")) {
      const w = whs[Number(box.dataset.wh)];
      const table = box.querySelector(".fin-stock");
      if (w && table) table.innerHTML = stockTableHtml(w, S.hasMoves);
    }
    applyStockSearch();
  }

  function stockFocus() {
    const { count, total, top5 } = I.stock;
    if (!count) return "";
    return `<div class="fin-stock-stagnant" id="stockFocus">
      <h3>Без расхода за период · ${money(total)}</h3>
      <div class="fin-focus-meta">${plural(count, ["позиция", "позиции", "позиций"])}</div>
      <ol class="fin-focus-list" aria-label="Топ-5 позиций без расхода">${top5.map((x) => `<li>
        <span><strong>${esc(x.name)}</strong><span class="fin-focus-meta">${esc(x.company)} · ${esc(x.warehouse)} · ${qty(x.endQty, x.unit)}</span>${demandHtml(x)}</span>
        <span class="fin-focus-value">${money(x.endSum)}</span></li>`).join("")}</ol>
      <div class="fin-actions">${copyButton("stock", "Скопировать для ОП")}</div>
    </div>`;
  }

  function stockBlock() {
    const list = stockList();
    if (!list.length) return "";
    if (!list.some((x) => x.company === stockPick)) stockPick = list[0].company;
    const period = list[0].period ? ` за ${esc(list[0].period.toLowerCase())}` : "";
    const chips = list.length > 1
      ? `<div class="chips" id="stockChips" role="group" aria-label="Компания">${list.map((x) => `<button type="button" data-c="${esc(x.company)}" aria-pressed="${String(x.company === stockPick)}">${esc(x.company)}</button>`).join("")}</div>`
      : "";
    return `<section class="block" id="f-stock">${head("Склад", `материальная ведомость 1С${period}`)}
      <p class="lead">Остаток на конец периода: ${list.map((x) => `${esc(x.company)} <b>${money(x.total.end)}</b>`).join(" · ")}. Склады свёрнуты, поиск раскрывает те, где есть товар.</p>
      ${stockFocus()}
      ${I.stock.mismatch ? `<p class="note-warn">Сверка с листом «Ежед.»: по ведомостям ${full(I.stock.statementTotal)}, ТМЦ ${full(R.cash.inventory)}. Разница ${full(Math.abs(I.stock.diff))}.</p>` : ""}
      ${chips}<div class="chips" id="stockModeChips" role="group" aria-label="Позиции склада">
        <button type="button" data-mode="all" aria-pressed="true">Все</button>
        <button type="button" data-mode="stagnant" aria-pressed="false">Без расхода</button>
        <button type="button" data-mode="present" aria-pressed="false">Скрыть выбывшие</button>
      </div>
      <div class="fin-stock-search"><input type="search" id="stockQ" class="plan-search-input" placeholder="Найти товар: ноутбук, монитор, RTX…" aria-label="Найти товар на складе" value="${esc(stockQuery)}" autocomplete="off"><span id="stockFound" class="dim" aria-live="polite"></span></div>
      <div id="stockBody">${stockBodyHtml()}</div></section>`;
  }

  // Поиск без перерисовки: прячем строки и склады, раскрываем склады с найденным,
  // а при пустом запросе закрываем то, что раскрыл поиск (раскрытое руками не трогаем).
  function applyStockSearch() {
    const body = document.getElementById("stockBody");
    const found = document.getElementById("stockFound");
    if (!body) return;
    const words = searchKey(stockQuery).split(" ").filter(Boolean);
    const filtered = words.length > 0 || stockMode !== "all";
    let hits = 0;
    for (const box of body.querySelectorAll("details.fin-wh")) {
      let boxHits = 0;
      for (const row of box.querySelectorAll(".r.body")) {
        const ok = matchesStock(words, row.dataset.n, row.classList.contains("is-stagnant"), row.classList.contains("is-gone"));
        row.hidden = !ok;
        if (ok) boxHits++;
      }
      box.hidden = filtered && !boxHits;
      if (filtered && boxHits && !box.open) { box.open = true; box.dataset.auto = "1"; }
      if (!filtered && box.dataset.auto) { box.open = false; delete box.dataset.auto; }
      hits += boxHits;
    }
    if (found) found.textContent = filtered ? (hits ? `найдено: ${plural(hits, ["позиция", "позиции", "позиций"])}` : "ничего не найдено") : "";
    // на кнопках компаний — сколько найдено у каждой, чтобы не переключать вслепую
    for (const b of document.querySelectorAll("#stockChips button")) {
      const S = stockList().find((x) => x.company === b.dataset.c);
      if (!S) continue;
      const n = filtered ? S.warehouses.reduce((a, w) => a + w.items.filter((x) =>
        matchesStock(words, searchKey(x.name), stockStagnant(S.hasMoves, x), stockGone(x))).length, 0) : null;
      b.textContent = n === null ? S.company : `${S.company} · ${n}`;
    }
  }

  /* ---------- 07: поступления ---------- */
  function incomingBlock() {
    let s = `<section class="block" id="f-incoming">${head("Поступления за день", money(R.incomingTotal))}`;
    if (!R.incoming.length) return s + `<p class="lead">Поступлений в отчёте нет.</p></section>`;
    s += `<div class="rows fin-in"><div class="r head"><span class="label">От кого</span><span class="label">Кому</span><span class="label n">Сумма</span></div>
      ${[...R.incoming].sort((a, b) => b.amount - a.amount).map((x) => `<div class="r body"><span class="nm" title="${esc(x.payer)}">${esc(short(x.payer, 90))}</span><span class="dim">${esc(x.company)}</span><span class="num">${esc(full(x.amount))}</span></div>`).join("")}</div>`;
    return s + `</section>`;
  }

  /* ---------- 08: счета и курсы ---------- */
  function balanceBlock() {
    const lines = R.balances.filter((x) => x.total);
    if (!lines.length && !R.rates.length) return "";
    let s = `<section class="block" id="f-balance">${head("Счета на конец дня", `данные на ${ddmm(R.dataDate)}`)}`;
    if (lines.length) {
      s += `<div class="rows fin-bal"><div class="r head"><span class="label">Счёт</span><span class="label">По компаниям</span><span class="label n">Всего</span></div>
        ${lines.map((x) => `<div class="r body"><span class="nm">${esc(x.label)} <span class="dim">${esc(x.code)}</span></span><span class="dim">${R.companies.map((c, i) => (x.values[i] ? `${esc(c)} ${esc(amt(x.values[i]))}` : "")).filter(Boolean).join(" · ")}</span><span class="num">${esc(amt(x.total))}</span></div>`).join("")}</div>`;
    }
    if (R.rates.length) {
      s += `<p class="fin-note">${R.rates.map((x) => `${esc(x.label)}: ${nf2.format(x.value)}`).join(" · ")}</p>`;
    }
    return s + `</section>`;
  }

  function warningsBlock() {
    if (!R.warnings || !R.warnings.length) return "";
    return `<section class="block" id="f-warnings"><div class="note-warn">Сверка итогов в файле: ${R.warnings.map(esc).join("; ")}.</div></section>`;
  }

  function render() {
    if (!el) return;
    if (!R) {
      // без ежедневного отчёта ОПиУ из книги ФО всё равно показываем
      blockNo = 0;
      el.innerHTML = `<section class="block"><p class="lead">${esc(F.error || "Финансового отчёта пока нет.")}</p>${F.notice ? `<div class="note-warn">${esc(F.notice)}</div>` : ""}</section>${opiuBlock()}`;
      scrollOpiuToLatest();
      return;
    }
    blockNo = 0;
    const stale = today && daysBetween(R.dataDate, today) > 3;
    let s = "";
    if (F.notice) s += `<div class="note-warn">${esc(F.notice)}</div>`;
    if (stale) s += `<div class="note-warn">Отчёт старый: данные на ${ddmm(R.dataDate)}. Свежего файла в чате нет.</div>`;
    s += warningsBlock() + overview();
    s += `<section class="block" id="f-debtors">${debtorsBlock()}</section>`;
    s += payments() + stockBlock() + pnl() + opiuBlock() + cashBlock() + incomingBlock() + balanceBlock();
    el.innerHTML = s;
    scrollOpiuToLatest();
    if (stockQuery) applyStockSearch();
  }

  function rerenderDebtors() {
    const main = document.getElementById("debtMain");
    if (main) main.innerHTML = debtMainHtml();
    const overdue = document.getElementById("debtOverdue");
    if (overdue) overdue.innerHTML = debtGroupHtml("overdue");
    const current = document.getElementById("debtCurrent");
    if (current) current.innerHTML = debtGroupHtml("current");
    const problem = document.getElementById("debtProblem");
    if (problem) problem.innerHTML = debtProblemHtml();
  }

  el?.addEventListener("input", (e) => {
    const opiuQ = e.target.closest?.("[data-opiu-q]");
    if (opiuQ) {
      const i = Number(opiuQ.dataset.opiuQ);
      opiuQuery.set(i, opiuQ.value);
      rerenderOpiuRows(i);
      return;
    }
    if (e.target.id !== "stockQ") return;
    stockQuery = e.target.value;
    applyStockSearch();
  });

  function copyText(key) {
    if (key === "debt") {
      const byPay = I.debt.byPayment;
      if (byPay) {
        if (!byPay.overdue.count) return `Просроченных долгов на ${ddmmyyyy(today)} нет.`;
        return [`Просроченная задолженность · ${full(byPay.overdue.total)} (${plural(byPay.overdue.count, ["долг", "долга", "долгов"])}) · на ${ddmmyyyy(today)}`,
          ...byPay.overdue.top10.map((x, i) => `${i + 1}. ${x.name} · ${x.company} · ${full(x.amount)} · оплата ${ddmmyyyy(x.paymentDate)} · просрочено ${x.overdueDays} дн.`)].join("\n");
      }
      return [`Должники старше 30 дней с даты реализации · на ${ddmmyyyy(today)}`,
        ...I.debt.top10.map((x, i) => `${i + 1}. ${x.name} · ${x.company} · ${full(x.amount)} · реализация ${ddmmyyyy(x.saleDate)} · ${x.days} дн.`)].join("\n");
    }
    if (key === "stock") {
      return [`Без расхода за период · ${full(I.stock.total)} (${I.stock.count} поз.)`,
        ...I.stock.top5.map((x, i) => `${i + 1}. ${x.name} · ${x.company} · ${x.warehouse} · ${nfq.format(x.endQty)}${x.unit ? " " + x.unit : ""} · ${full(x.endSum)}${[demandText(x)].filter(Boolean).map((t) => ` · ${t}`).join("")}`)].join("\n");
    }
    const main = R.payments[0];
    return [`Календарь платежей · на ${ddmmyyyy(today)}`,
      ...(main ? paymentRows(main, 0).map((x) => [x.payee, full(x.amount), x.basis, x.hint && `до ${ddmmyyyy(x.hint.date)}`].filter(Boolean).join(" · ")) : []),
      `По календарю ${full(main?.total ?? 0)} · на счетах ${full(R.cash.total)}`,
      ...(R.tax ? [`КПН ${full(R.tax.total)} · всего к оплате ${full(I.totalWithTax)}`,
        I.cashGap < 0 ? `Не хватает ${full(-I.cashGap)}` : `Запас ${full(I.cashGap)}`] : [])
    ].join("\n");
  }

  async function copyFinance(button) {
    const status = button.nextElementSibling;
    const content = copyText(button.dataset.finCopy);
    try {
      await navigator.clipboard.writeText(content);
      status.textContent = "Скопировано";
    } catch {
      // Для локального файла и браузеров без Clipboard API.
      const field = document.createElement("textarea");
      field.value = content;
      field.readOnly = true;
      field.className = "fin-copy-field";
      field.setAttribute("aria-label", "Текст для копирования");
      button.parentElement.append(field);
      field.select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch { /* Текст остаётся доступен для ручного копирования. */ }
      if (copied) {
        field.remove();
        button.focus();
      } else {
        field.classList.add("is-visible");
      }
      status.textContent = copied ? "Скопировано" : "Выделенный текст можно скопировать вручную";
    }
  }

  el?.addEventListener("click", (e) => {
    const opiuToggle = e.target.closest(".fin-opiu-toggle");
    if (opiuToggle) {
      const i = Number(opiuToggle.dataset.line);
      const open = !opiuOpen.has(i);
      if (open) opiuOpen.add(i); else opiuOpen.delete(i);
      opiuToggle.setAttribute("aria-expanded", String(open));
      const body = document.getElementById(`opiu-bd-${i}`);
      if (body) body.hidden = !open;
      return;
    }
    const opiuAllBtn = e.target.closest("[data-opiu-all]");
    if (opiuAllBtn) {
      const i = Number(opiuAllBtn.dataset.opiuAll);
      if (opiuAll.has(i)) opiuAll.delete(i); else opiuAll.add(i);
      rerenderOpiuRows(i);
      document.querySelector(`#opiu-bd-${i} [data-opiu-all]`)?.focus();
      return;
    }
    const opiuPeriod = e.target.closest("[data-opiu-period]");
    if (opiuPeriod) {
      opiuMode = opiuPeriod.dataset.opiuPeriod;
      for (const b of opiuPeriod.parentElement.children) b.setAttribute("aria-pressed", String(b === opiuPeriod));
      const table = document.getElementById("opiuTable");
      if (table) table.innerHTML = opiuTableHtml();
      scrollOpiuToLatest();
      return;
    }
    const copy = e.target.closest("[data-fin-copy]");
    if (copy) {
      copy.parentElement.querySelector(".fin-copy-field")?.remove();
      copyFinance(copy);
      return;
    }
    const debtOpen = e.target.closest("[data-debt-open]");
    if (debtOpen) {
      const kind = debtOpen.dataset.debtOpen;
      if (debtGroups[kind]) {
        debtGroups[kind].company = "";
        debtGroups[kind].all = true;
        const boxId = kind === "overdue" ? "debtOverdueBox" : "debtCurrentBox";
        const box = document.getElementById(boxId);
        if (box) box.open = true;
        rerenderDebtors();
        box?.scrollIntoView({ block: "start" });
        (box?.querySelector(`[data-debt-group="${kind}"][data-c=""]`) || box?.querySelector("summary"))?.focus({ preventScroll: true });
      }
      return;
    }
    const groupChip = e.target.closest("[data-debt-group]");
    if (groupChip) {
      const kind = groupChip.dataset.debtGroup;
      const c = groupChip.dataset.c || "";
      if (debtGroups[kind]) {
        debtGroups[kind].company = c;
        rerenderDebtors();
        [...document.querySelectorAll(`[data-debt-group="${kind}"]`)].find((b) => (b.dataset.c || "") === c)?.focus();
      }
      return;
    }
    const groupAll = e.target.closest("[data-debt-all]");
    if (groupAll) {
      const kind = groupAll.dataset.debtAll;
      if (debtGroups[kind]) {
        debtGroups[kind].all = !debtGroups[kind].all;
        rerenderDebtors();
        const boxId = kind === "overdue" ? "debtOverdueBox" : "debtCurrentBox";
        if (!debtGroups[kind].all) document.getElementById(boxId)?.scrollIntoView({ block: "start" });
        document.querySelector(`[data-debt-all="${kind}"]`)?.focus();
      }
      return;
    }
    const debtAction = e.target.closest("[data-debt-focus]");
    if (debtAction) {
      debtAge = Number(debtAction.dataset.debtFocus);
      debtFilter = "";
      debtAll = true;
      const box = document.getElementById("debtMainBox");
      if (box) box.open = true;
      rerenderDebtors();
      box?.scrollIntoView({ block: "start" });
      box?.querySelector(`[data-age="${debtAge}"]`)?.focus({ preventScroll: true });
      return;
    }
    const mode = e.target.closest("#stockModeChips button");
    if (mode) {
      stockMode = mode.dataset.mode;
      for (const b of mode.parentElement.children) b.setAttribute("aria-pressed", String(b === mode));
      applyStockSearch();
      return;
    }
    const stockChip = e.target.closest("#stockChips button");
    if (stockChip) {
      stockPick = stockChip.dataset.c || "";
      for (const b of document.querySelectorAll("#stockChips button")) b.setAttribute("aria-pressed", String(b === stockChip));
      const body = document.getElementById("stockBody");
      if (body) body.innerHTML = stockBodyHtml();
      applyStockSearch();
      return;
    }
    const chip = e.target.closest("#debtChips button");
    if (chip) {
      const c = chip.dataset.c || "";
      debtFilter = c;
      rerenderDebtors();
      [...document.querySelectorAll("#debtChips button")].find((b) => (b.dataset.c || "") === c)?.focus();
      return;
    }
    const ageChip = e.target.closest("#debtAgeChips button");
    if (ageChip) {
      const age = Number(ageChip.dataset.age || "0") || 0;
      debtAge = age;
      rerenderDebtors();
      document.querySelector(`#debtAgeChips button[data-age="${age}"]`)?.focus();
      return;
    }
    const stockSortEl = e.target.closest("[data-stock-sort]");
    if (stockSortEl) {
      const key = stockSortEl.dataset.stockSort;
      const box = stockSortEl.closest("details.fin-wh");
      // переключаем от того, что сейчас видно (у компании без прихода видна сортировка по сумме)
      const shown = stockList().find((x) => x.company === stockPick);
      const cur = stockSortFor(shown ? shown.hasMoves : true);
      stockSort = cur.key === key ? { key, dir: -cur.dir } : { key, dir: key === "name" ? 1 : -1 };
      resortStock();
      box?.querySelector(`[data-stock-sort="${key}"]`)?.focus();
      return;
    }
    const sort = e.target.closest(".fin-sort");
    if (sort) {
      const key = sort.dataset.sort;
      debtSort = debtSort.key === key ? { key, dir: -debtSort.dir } : { key, dir: firstDir(key) };
      const box = sort.closest("#debtMain, #debtOverdue, #debtCurrent, #debtProblem");
      rerenderDebtors();
      // кнопку перерисовали — фокус возвращаем на новую, чтобы клавиатура не теряла место
      box?.querySelector(`.fin-sort[data-sort="${key}"]`)?.focus();
      return;
    }
    if (e.target.closest("#debtAll")) {
      debtAll = !debtAll;
      rerenderDebtors();
      if (!debtAll) document.getElementById("debtMainBox")?.scrollIntoView({ block: "start" });
      document.getElementById("debtAll")?.focus();
    }
  });

  function moveInd() {
    const ind = document.querySelector(".sections .ind");
    const link = document.querySelector(".sections a[aria-current='page']");
    if (ind && link) {
      const css = getComputedStyle(link);
      const left = parseFloat(css.paddingLeft);
      const right = parseFloat(css.paddingRight);
      ind.style.left = link.offsetLeft + left + "px";
      ind.style.width = link.offsetWidth - left - right + "px";
    }
  }

  setLabels();
  render();
  const bar = document.querySelector(".bar");
  const dateline = document.querySelector(".dateline");
  function measureHeader() {
    if (bar) document.documentElement.style.setProperty("--bar-height", bar.getBoundingClientRect().height + "px");
    if (dateline) document.documentElement.style.setProperty("--fin-date-height", dateline.getBoundingClientRect().height + "px");
    moveInd();
  }
  measureHeader();
  if (typeof ResizeObserver !== "undefined") {
    const headerObserver = new ResizeObserver(measureHeader);
    if (bar) headerObserver.observe(bar);
    if (dateline) headerObserver.observe(dateline);
  }
  addEventListener("resize", moveInd);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveInd);
  setTimeout(moveInd, 0);
})();
