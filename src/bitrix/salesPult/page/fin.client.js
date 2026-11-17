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
  const today = (P.asOfDate || "").slice(0, 10);

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
  function payList(list, open) {
    const rows = [...list.items].sort((a, b) => b.amount - a.amount);
    const body = `<div class="rows fin-pay"><div class="r head"><span class="label">Кому</span><span class="label">За что</span><span class="label n">Сумма</span></div>
      ${rows.map((x) => `<div class="r body"><span class="nm" title="${esc(x.payee)}">${esc(short(x.payee, 90))}${x.tag ? ` <span class="partner-tag">${esc(x.tag)}</span>` : ""}</span><span class="dim">${esc(x.basis || "")}</span><span class="num">${esc(amt(x.amount))}</span></div>`).join("")}
      <div class="r body total"><span class="nm">Итого</span><span></span><span class="num">${esc(amt(list.total))}</span></div></div>`;
    if (open) return `<h3 class="fin-sub">${esc(list.label)} <span class="dim">${plural(rows.length, ["платёж", "платежа", "платежей"])} · ${money(list.total)}</span></h3>${body}`;
    return `<details class="fin-more"><summary>${esc(list.label)} <span class="dim">${plural(rows.length, ["строка", "строки", "строк"])} · ${money(list.total)}</span></summary>${body}</details>`;
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
  let debtAll = false;
  function ageCls(days) {
    return days > 60 ? "bad" : days > 30 ? "warn" : "";
  }
  function debtRows(list, limit) {
    const rows = list.rows.filter((x) => !debtFilter || x.company === debtFilter).sort((a, b) => b.amount - a.amount);
    const shown = limit ? rows.slice(0, limit) : rows;
    const html = shown.map((x) => {
      const days = x.saleDate ? daysBetween(x.saleDate, today) : null;
      return `<div class="r body"><span class="nm" title="${esc(x.name)}">${esc(short(x.name, 80))}${x.note ? `<span class="fin-debt-note">${esc(x.note)}</span>` : ""}</span>
        <span class="dim">${esc(x.company)}</span><span class="num">${esc(amt(x.amount))}</span>
        <span class="num dim">${x.saleDate ? ddmm(x.saleDate) + (x.saleDate.slice(0, 4) !== today.slice(0, 4) ? "." + x.saleDate.slice(2, 4) : "") : "—"}</span>
        <span class="num ${days !== null ? ageCls(days) : ""}">${days !== null ? plural(days, ["день", "дня", "дней"]) : "—"}</span></div>`;
    }).join("");
    return { html, total: rows.length, sum: rows.reduce((s, x) => s + x.amount, 0) };
  }
  const debtHead = `<div class="r head"><span class="label">Должник</span><span class="label">Компания</span><span class="label n">Сумма</span><span class="label n">Реализация</span><span class="label n">Прошло</span></div>`;

  function debtorsBlock() {
    const D = R.debtors;
    const chips = D.companies.length > 1
      ? `<div class="chips" id="debtChips" role="group" aria-label="Компания">${["", ...D.companies].map((c) => `<button type="button" data-c="${esc(c)}" aria-pressed="${String(c === debtFilter)}">${c ? esc(c) : "Все"}</button>`).join("")}</div>`
      : "";
    const main = debtRows(D, debtAll ? 0 : 12);
    const byCompany = D.companies.map((c, i) => `${esc(c)} ${money(D.totals[i])}`).join(" · ");
    let s = `${head("Дебиторы", `${plural(D.rows.length, ["долг", "долга", "долгов"])} · ${money(D.total)}`)}
      <p class="lead">${byCompany}. Цвет — сколько дней прошло с реализации: больше 30 — жёлтый, больше 60 — красный.</p>
      ${chips}<div class="rows fin-debt">${debtHead}${main.html}</div>`;
    if (main.total > 12) {
      s += `<button type="button" class="btn fin-showall" id="debtAll">${debtAll ? "Свернуть" : `Показать все ${main.total} на ${money(main.sum)}`}</button>`;
    }
    if (R.problemDebts && R.problemDebts.rows.length) {
      const pd = debtRows(R.problemDebts, 0);
      s += `<h3 class="fin-sub">Проблемные долги <span class="dim">${plural(pd.total, ["долг", "долга", "долгов"])} · ${money(pd.sum)} · суды, исполнительные листы, списания</span></h3>
        <div class="rows fin-debt">${debtHead}${pd.html}</div>`;
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

  /* ---------- 06: поступления ---------- */
  function incomingBlock() {
    let s = `<section class="block" id="f-incoming">${head("Поступления за день", money(R.incomingTotal))}`;
    if (!R.incoming.length) return s + `<p class="lead">Поступлений в отчёте нет.</p></section>`;
    s += `<div class="rows fin-in"><div class="r head"><span class="label">От кого</span><span class="label">Кому</span><span class="label n">Сумма</span></div>
      ${[...R.incoming].sort((a, b) => b.amount - a.amount).map((x) => `<div class="r body"><span class="nm" title="${esc(x.payer)}">${esc(short(x.payer, 90))}</span><span class="dim">${esc(x.company)}</span><span class="num">${esc(full(x.amount))}</span></div>`).join("")}</div>`;
    return s + `</section>`;
  }

  /* ---------- 07: счета и курсы ---------- */
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
    s += cashBlock() + incomingBlock() + balanceBlock() + warningsBlock();
    el.innerHTML = s;
  }

  function rerenderDebtors() {
    const box = document.getElementById("f-debtors");
    if (!box) return;
    const keep = blockNo;
    blockNo = Number(box.querySelector(".idx")?.textContent || "1") - 1;
    box.innerHTML = debtorsBlock();
    blockNo = keep;
  }

  el?.addEventListener("click", (e) => {
    const chip = e.target.closest("#debtChips button");
    if (chip) {
      debtFilter = chip.dataset.c || "";
      rerenderDebtors();
      return;
    }
    if (e.target.closest("#debtAll")) {
      debtAll = !debtAll;
      rerenderDebtors();
      if (!debtAll) document.getElementById("f-debtors")?.scrollIntoView({ block: "start" });
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
