// Страница «Финансы»: ежедневный отчёт финансиста из чата Битрикс24.
(function () {
  "use strict";

  const P = typeof PAYLOAD !== "undefined" ? PAYLOAD : {};
  const F = P.finance || { snapshots: [] };
  const R = F.report;
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

  function tile(label, value, sub, key, cls = "") {
    return `<div class="fin-tile ${cls}"><span class="label">${label}</span>
      <div class="v">${value}</div>${spark(key)}${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
  }

  /* ---------- 01: деньги и долги ---------- */
  function overview() {
    const cash = R.cash.total;
    const due = R.payments[0] ? R.payments[0].total : 0;
    const loans = R.liabilities.filter((x) => /^кредит(?!ор)/i.test(x.label));
    const payables = R.liabilities.find((x) => /^кредитор/i.test(x.label)) || R.balances.find((x) => x.code === "3310");
    const old = R.debtors.rows.filter((x) => x.saleDate && daysBetween(x.saleDate, today) > 30);
    const oldSum = old.reduce((s, x) => s + x.amount, 0);
    const cf = R.cashFlow;
    const big = (n) => {
      const unit = (amt(n).match(/(млн|млрд|тыс)$/) || [""])[0];
      return `${unit ? amt(n).slice(0, -unit.length - 1) : amt(n)}<small> ${unit}${NB}₸</small>`;
    };

    const cashSub = cf
      ? `вчера ${money(cf.prev)}${cf.spent != null ? ` · потрачено ${money(cf.spent)}` : ""} · пришло ${money(R.incomingTotal)}`
      : `пришло за день ${money(R.incomingTotal)}`;
    const cover = due ? cash / due : 0;
    const dueSub = due
      ? (cash >= due ? `денег на счетах хватает` : `<span class="warn">на счетах ${Math.round(cover * 100)}% · не хватает ${money(due - cash)}</span>`)
      : "";
    const debtSub = `старше 30 дней ${money(oldSum)}${R.problemDebts ? ` · проблемные ${money(R.problemDebts.total)}` : ""}`;

    let s = `<section class="block" id="f-overview">${head("Деньги и долги", `на ${dayMonth(R.dataDate)}`)}
      <div class="fin-tiles">
        ${tile("Деньги на счетах", big(cash), cashSub, "cash")}
        ${tile(esc(R.payments[0] ? R.payments[0].label : "Календарь платежей"), big(due), dueSub, "paymentsDue")}
        ${tile("Дебиторка", big(R.debtors.total), debtSub, "debtors")}
        ${payables ? tile("Кредиторка", big(payables.total), "долги поставщикам", "payables") : ""}
        ${loans.length ? tile(esc(loans.map((x) => x.label).join(", ")), big(loans.reduce((s, x) => s + x.total, 0)), "остаток по графику", "loans") : ""}
        ${tile("Товар на складе", big(R.cash.inventory), "ТМЦ по компаниям", "inventory")}
      </div>`;
    if ((F.snapshots || []).length < 2) {
      s += `<p class="fin-note">Графики под цифрами появятся, когда в чате накопится несколько дней отчётов.</p>`;
    }
    return s + `</section>`;
  }

  /* ---------- 02: прибыль ---------- */
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
      <div class="fin-scroll"><div class="rows fin-pnl"><div class="r head"><span class="label">Компания</span><span class="label n">Выручка</span><span class="label n">Себестоимость</span><span class="label n">Расходы</span><span class="label n">Прибыль</span>${prev ? `<span class="label n">${esc(prevLabel)}, прибыль</span>` : ""}</div>`;
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

  /* ---------- 03: платежи ---------- */
  // Все списки свёрнуты, как просили: сверху итог, раскрывается по клику.
  function payList(list, isCalendar) {
    const rows = [...list.items].sort((a, b) => b.amount - a.amount);
    const word = isCalendar ? ["платёж", "платежа", "платежей"] : ["строка", "строки", "строк"];
    return `<details class="fin-more"><summary>${esc(list.label)} <span class="dim">${plural(rows.length, word)} · ${money(list.total)}</span></summary>
      <div class="rows fin-pay"><div class="r head"><span class="label">Кому</span><span class="label">За что</span><span class="label n">Сумма</span></div>
      ${rows.map((x) => `<div class="r body"><span class="nm" title="${esc(x.payee)}">${esc(short(x.payee, 90))}${x.tag ? ` <span class="partner-tag">${esc(x.tag)}</span>` : ""}</span><span class="dim">${esc(x.basis || "")}</span><span class="num">${esc(amt(x.amount))}</span></div>`).join("")}
      <div class="r body total"><span class="nm">Итого</span><span></span><span class="num">${esc(amt(list.total))}</span></div></div></details>`;
  }

  function payments() {
    if (!R.payments.length) return "";
    const [main, ...rest] = R.payments;
    let s = `<section class="block" id="f-payments">${head("Платежи", "как в календаре финансиста")}`;
    if (main.total) {
      const gap = main.total - R.cash.total;
      s += `<p class="lead">По календарю к оплате <b>${money(main.total)}</b>, на счетах <b>${money(R.cash.total)}</b>${gap > 0 ? ` — не хватает <b class="bad">${money(gap)}</b>` : " — денег хватает"}.</p>`;
    }
    s += payList(main, true) + rest.map((l) => payList(l, false)).join("");
    return s + `</section>`;
  }

  /* ---------- 04: дебиторы ---------- */
  let debtFilter = "";
  let debtAge = 0; // 0 = все, 30 = старше 30 дней, 60 = старше 60 дней
  let debtAll = false;
  const AGE_FILTERS = [
    { days: 0, label: "Все" },
    { days: 30, label: "Старше 30 дней" },
    { days: 60, label: "Старше 60 дней" }
  ];
  // Сортировка по клику на «Сумма» или «Прошло»: сначала от большего к меньшему, повторный клик — наоборот.
  let debtSort = { key: "amount", dir: -1 };
  function ageCls(days) {
    return days > 60 ? "bad" : days > 30 ? "warn" : "";
  }
  const debtDays = (x) => (x.saleDate && today ? daysBetween(x.saleDate, today) : null);
  function debtCompare(a, b) {
    if (debtSort.key === "days") {
      const da = debtDays(a), db = debtDays(b);
      // без даты реализации — всегда в конце
      if (da !== db) {
        if (da === null) return 1;
        if (db === null) return -1;
        return (da - db) * debtSort.dir;
      }
      return b.amount - a.amount;
    }
    return (a.amount - b.amount) * debtSort.dir;
  }
  // Фильтры по компании и возрасту — только для основного списка: кнопки стоят внутри него.
  function debtRows(list, limit, byCompany) {
    const rows = list.rows.filter((x) => {
      if (byCompany && debtFilter && x.company !== debtFilter) return false;
      if (byCompany && debtAge > 0) {
        const days = debtDays(x);
        if (days === null || days <= debtAge) return false;
      }
      return true;
    }).sort(debtCompare);
    const shown = limit ? rows.slice(0, limit) : rows;
    const html = shown.map((x) => {
      const days = debtDays(x);
      return `<div class="r body"><span class="nm" title="${esc(x.name)}">${esc(short(x.name, 80))}${x.note ? `<span class="fin-debt-note">${esc(x.note)}</span>` : ""}</span>
        <span class="dim">${esc(x.company)}</span><span class="num">${esc(amt(x.amount))}</span>
        <span class="num dim">${x.saleDate ? ddmm(x.saleDate) + (x.saleDate.slice(0, 4) !== today.slice(0, 4) ? "." + x.saleDate.slice(2, 4) : "") : "—"}</span>
        <span class="num ${days !== null ? ageCls(days) : ""}">${days !== null ? plural(days, ["день", "дня", "дней"]) : "—"}</span></div>`;
    }).join("");
    return { html, total: rows.length, sum: rows.reduce((s, x) => s + x.amount, 0) };
  }
  // Как сортировка на «Планах»: заголовок колонки с aria-sort, внутри кнопка, стрелки ↓ ↑ ↕.
  function sortBtn(key, label, what) {
    const on = debtSort.key === key;
    const ariaSort = on ? (debtSort.dir > 0 ? "ascending" : "descending") : "none";
    const arrow = on ? (debtSort.dir > 0 ? "↑" : "↓") : "↕";
    const next = on && debtSort.dir < 0 ? "от меньшего к большему" : "от большего к меньшему";
    return `<span class="label n" role="columnheader" aria-sort="${ariaSort}"><button type="button" class="fin-sort" data-sort="${key}" title="Сортировать ${what}: ${next}">${label} <span class="ar" aria-hidden="true">${arrow}</span></button></span>`;
  }
  const debtHead = () => `<div class="r head fin-sortable"><span class="label">Должник</span><span class="label">Компания</span>${sortBtn("amount", "Сумма", "по сумме")}<span class="label n">Реализация</span>${sortBtn("days", "Прошло", "по дням с реализации")}</div>`;

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
    s += `<div class="rows fin-debt">${debtHead()}${bodyHtml}</div>`;
    if (main.total > 12) {
      s += `<button type="button" class="btn fin-showall" id="debtAll">${debtAll ? "Свернуть" : `Показать все ${main.total} на ${money(main.sum)}`}</button>`;
    }
    return s;
  }
  const debtProblemHtml = () => `<div class="rows fin-debt">${debtHead()}${debtRows(R.problemDebts, 0).html}</div>`;

  // Как в «Платежах»: шапка с итогом, списки свёрнуты. Перерисовывается только содержимое,
  // поэтому раскрытый блок не закрывается от фильтра или сортировки.
  function debtorsBlock() {
    const D = R.debtors;
    const byCompany = D.companies.map((c, i) => `${esc(c)} ${money(D.totals[i])}`).join(" · ");
    let s = `${head("Дебиторы", `${plural(D.rows.length, ["долг", "долга", "долгов"])} · ${money(D.total)}`)}
      <p class="lead">${byCompany}. Возраст — сколько дней прошло с даты реализации на ${esc(ddmmyyyy(today))}: больше 30 — оранжевый, больше 60 — красный.</p>
      <details class="fin-more" id="debtMainBox"><summary>Список дебиторов <span class="dim">${plural(D.rows.length, ["долг", "долга", "долгов"])} · ${money(D.total)}</span></summary>
        <div id="debtMain">${debtMainHtml()}</div></details>`;
    if (R.problemDebts && R.problemDebts.rows.length) {
      const pd = R.problemDebts.rows;
      s += `<details class="fin-more" id="debtProblemBox"><summary>Проблемные долги <span class="dim">${plural(pd.length, ["долг", "долга", "долгов"])} · ${money(pd.reduce((a, x) => a + x.amount, 0))} · суды, исполнительные листы, списания</span></summary>
        <div id="debtProblem">${debtProblemHtml()}</div></details>`;
    }
    return s;
  }

  /* ---------- 05: деньги по банкам ---------- */
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

  /* ---------- 06: склад по материальным ведомостям 1С ---------- */
  // Листы «Мат вед …» из того же файла: компания — кнопкой, склады — свёрнутыми списками,
  // поиск по названию товара раскрывает склады, где он есть.
  const nfq = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
  let stockPick = "";
  let stockQuery = "";
  const stockList = () => [...(R.stock || [])].sort((a, b) => b.total.end - a.total.end);
  const qty = (n, unit) => (n ? `${nfq.format(n)}${unit ? NB + esc(unit) : ""}` : "—");
  const searchKey = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
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
      const gone = !x.endQty && !x.endSum;
      const q0 = (n) => `${nfq.format(n || 0)}${x.unit ? NB + esc(x.unit) : ""}`;
      const mob = `остаток ${nfq.format(x.startQty || 0)} → ${q0(x.endQty)}${x.inQty ? ` · приход ${nfq.format(x.inQty)}` : ""}${x.outQty ? ` · расход ${nfq.format(x.outQty)}` : ""}`;
      return `<div class="r body${gone ? " is-gone" : ""}" data-n="${esc(searchKey(x.name))}"><span class="nm" title="${esc(x.name)}">${esc(short(x.name, 110))}<span class="fin-stock-m">${mob}</span></span>
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
  // поиск применяется заново.
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
      ${chips}<div class="fin-stock-search"><input type="search" id="stockQ" class="plan-search-input" placeholder="Найти товар: ноутбук, монитор, RTX…" aria-label="Найти товар на складе" value="${esc(stockQuery)}" autocomplete="off"><span id="stockFound" class="dim" aria-live="polite"></span></div>
      <div id="stockBody">${stockBodyHtml()}</div></section>`;
  }

  // Поиск без перерисовки: прячем строки и склады, раскрываем склады с найденным,
  // а при пустом запросе закрываем то, что раскрыл поиск (раскрытое руками не трогаем).
  function applyStockSearch() {
    const body = document.getElementById("stockBody");
    const found = document.getElementById("stockFound");
    if (!body) return;
    const words = searchKey(stockQuery).split(" ").filter(Boolean);
    let hits = 0;
    for (const box of body.querySelectorAll("details.fin-wh")) {
      let boxHits = 0;
      for (const row of box.querySelectorAll(".r.body")) {
        const ok = !words.length || words.every((w) => row.dataset.n.includes(w));
        row.hidden = !ok;
        if (ok) boxHits++;
      }
      box.hidden = words.length > 0 && !boxHits;
      if (words.length && boxHits && !box.open) { box.open = true; box.dataset.auto = "1"; }
      if (!words.length && box.dataset.auto) { box.open = false; delete box.dataset.auto; }
      hits += words.length ? boxHits : 0;
    }
    if (found) found.textContent = words.length ? (hits ? `найдено: ${plural(hits, ["позиция", "позиции", "позиций"])}` : "ничего не найдено") : "";
    // на кнопках компаний — сколько найдено у каждой, чтобы не переключать вслепую
    for (const b of document.querySelectorAll("#stockChips button")) {
      const S = stockList().find((x) => x.company === b.dataset.c);
      if (!S) continue;
      const n = words.length ? S.warehouses.reduce((a, w) => a + w.items.filter((x) => words.every((wd) => searchKey(x.name).includes(wd))).length, 0) : null;
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
    blockNo = 0;
    if (!R) {
      el.innerHTML = `<section class="block"><p class="lead">${esc(F.error || "Финансового отчёта пока нет.")}</p>${F.notice ? `<div class="note-warn">${esc(F.notice)}</div>` : ""}</section>`;
      return;
    }
    const stale = today && daysBetween(R.dataDate, today) > 3;
    let s = "";
    if (F.notice) s += `<div class="note-warn">${esc(F.notice)}</div>`;
    if (stale) s += `<div class="note-warn">Отчёт старый: данные на ${ddmm(R.dataDate)}. Свежего файла в чате нет.</div>`;
    s += overview() + pnl() + payments();
    s += `<section class="block" id="f-debtors">${debtorsBlock()}</section>`;
    s += cashBlock() + stockBlock() + incomingBlock() + balanceBlock() + warningsBlock();
    el.innerHTML = s;
    if (stockQuery) applyStockSearch();
  }

  function rerenderDebtors() {
    const main = document.getElementById("debtMain");
    if (main) main.innerHTML = debtMainHtml();
    const problem = document.getElementById("debtProblem");
    if (problem) problem.innerHTML = debtProblemHtml();
  }

  el?.addEventListener("input", (e) => {
    if (e.target.id !== "stockQ") return;
    stockQuery = e.target.value;
    applyStockSearch();
  });

  el?.addEventListener("click", (e) => {
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
      debtSort = debtSort.key === key ? { key, dir: -debtSort.dir } : { key, dir: -1 };
      const box = sort.closest("#debtMain, #debtProblem");
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
      ind.style.left = link.offsetLeft + 14 + "px";
      ind.style.width = link.offsetWidth - 28 + "px";
    }
  }

  setLabels();
  render();
  addEventListener("resize", moveInd);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveInd);
  setTimeout(moveInd, 0);
})();
