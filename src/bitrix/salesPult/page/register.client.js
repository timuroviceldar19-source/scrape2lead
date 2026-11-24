// Client-side rendering for "Реестр ОП" tab
(function () {
  "use strict";

  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmt = (n) => nf0.format(Math.round(n || 0));
  const mln = (n) => nf1.format((n || 0) / 1e6);
  const money = (n) => `${mln(n)} млн ₸`;
  const pct = (x) => `${Math.round((x || 0) * 100)}%`;
  const plural = (n, f) => {
    const a = Math.abs(n) % 100, b = a % 10;
    const w = a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b > 1 && b < 5 ? f[1] : f[2];
    return `${fmt(n)} ${w}`;
  };
  const ddmm = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  const initials = (n) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const head = (idx, title, meta = "") => `<div class="block-head"><h2><span class="idx">${idx}</span>${title}</h2><span class="meta">${meta}</span></div>`;
  const bar = (w, cls = "", tick) => `<div class="hbar"><span class="${cls}" data-w="${Math.max(0, Math.min(100, w)).toFixed(1)}"></span>${tick != null ? `<i style="left:${Math.min(100, tick)}%"></i>` : ""}</div>`;

  const formatMonthLabel = (ym) => {
    if (!ym || !ym.includes("-")) return ym || "";
    const [y, m] = ym.split("-");
    const name = MONTHS[Number(m) - 1] || m;
    return `${name[0].toUpperCase() + name.slice(1)} ${y}`;
  };

  const formatAlmatyTimeStr = (iso) => {
    if (!iso) return "";
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return String(iso).slice(0, 16).replace("T", " ");
    const d = new Date(ms + 5 * 3600000);
    return d.toISOString().slice(0, 10) + " " + d.toISOString().slice(11, 16);
  };

  const validMonth = (m) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  window.__registerMonths = (R) => [...new Set([
    R?.month, ...Object.keys(R?.history?.monthViews || {}), ...(R?.history?.months || []).map(m => m.month)
  ].filter(validMonth))].sort().reverse();

  window.__registerViewForMonth = (R, month) => {
    if (!validMonth(month) || month === R?.month) return R;
    const views = R?.history?.monthViews;
    let view = views && Object.prototype.hasOwnProperty.call(views, month) ? views[month] : null;
    if (!view) {
      const m = R?.history?.months?.find(m => m.month === month);
      if (!m) return R;
      const missing = m.missingCrm || [];
      let sale = 0;
      view = {
        month, file: m.fileName, asOf: `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()}`,
        total: { sale: m.sale, val: m.val, hasVal: m.hasVal, margin: m.margin, contracts: m.contracts,
          plan: m.plan, bonusMop: 0, bonusRop: 0, b2bSale: 0, b2bPlan: 0 },
        daily: [...(m.dailyContracts || [])].sort((a, b) => a.date.localeCompare(b.date)).map(d => ({ d: d.date, sale: sale += d.amount })),
        managers: m.byManager.map(manager => {
          const own = missing.filter(c => c.manager === manager.name);
          return { ...manager, bonus: 0, rows: [], missCount: own.length, missSum: own.reduce((s, c) => s + c.sale, 0) };
        }),
        missing, crmExtra: m.crmExtra || 0, rows: [], mix: [], channels: [], groups: [], legacySummary: true
      };
    }
    return { ...view, history: R.history, historyError: R.historyError };
  };

  const tenge = (amount) => `${fmt(amount)} ₸`;
  const egzUrl = (c) => {
    const id = String(c.id ?? "").trim();
    return id ? `https://procurement.gov.kz/ru/egzcontract/cpublic/show/${encodeURIComponent(id)}` : "";
  };

  // Старые срезы не содержат risks. Правила должны совпадать с register/risks.ts.
  function risksFromRows(rows, hasVal) {
    const belowCost = [], lowMargin = [], portalMismatch = [];
    for (const r of rows) {
      const val = hasVal ? r.val : null;
      const margin = val != null && r.sale > 0 ? val / r.sale : null;
      const row = { ...r, val, margin };
      const costLoss = r.cost > 0 && r.sale > 0 && r.cost > r.sale ? r.cost - r.sale : 0;
      const loss = Math.max(costLoss, val != null && val < 0 ? -val : 0);
      if (loss > 0) belowCost.push({ ...row, loss });
      if (r.partner !== true && margin !== null && margin >= 0 && margin < 0.10) lowMargin.push(row);
      const difference = r.portal - r.sale;
      if (r.portal > 0 && r.sale > 0 && Math.abs(difference) > Math.max(10_000, r.sale * 0.01)
        && Math.abs(r.portal / r.sale - 1.12) > 0.015) {
        portalMismatch.push({ ...row, difference });
      }
    }
    return {
      belowCost: { count: belowCost.length, loss: belowCost.reduce((sum, r) => sum + r.loss, 0),
        rows: belowCost.sort((a, b) => b.loss - a.loss) },
      lowMargin: { count: lowMargin.length, sale: lowMargin.reduce((sum, r) => sum + r.sale, 0),
        rows: lowMargin.sort((a, b) => b.sale - a.sale) },
      portalMismatch: { count: portalMismatch.length, difference: portalMismatch.reduce((sum, r) => sum + Math.abs(r.difference), 0),
        rows: portalMismatch.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)) }
    };
  }

  async function copyForChat(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // На некоторых страницах браузер разрешает только копирование выделенного текста.
      }
    }
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    const focused = document.activeElement;
    document.body.append(input);
    input.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      input.remove();
      focused?.focus({ preventScroll: true });
    }
  }

  window.__renderRegisterTab = function (R, el, reconciliation, portal, latestMonth = window.__registerMonths(R)[0]) {
    if (!el) return;
    if (!R || R.error) {
      el.innerHTML = `<section class="block"><p class="lead">${esc(R?.error || "Реестр не подключён: нет данных")}</p></section>`;
      return;
    }

  const T = R.total;
  const PS = R.partner;
  // Вариант для менеджера: в R только его строки, итоги — его, бонуса РОП и B2B-плана отдела нет.
  const VIEWER = typeof PAYLOAD !== "undefined" && PAYLOAD && PAYLOAD.viewer && PAYLOAD.viewer.kind === "manager" ? PAYLOAD.viewer : null;
  const M = Number(R.month.slice(5, 7));
  // Номера блоков идут подряд: блок партнёрских продаж есть не в каждом месяце.
  let blockNo = 0;
  const idx = () => String(++blockNo).padStart(2, "0");
  const SHORT_CH = {
    "Электронный магазин": "эл. магазин",
    "Запрос ценовых предложений": "ЗЦП",
    "Из одного источника": "из 1 источника",
    "Открытый конкурс": "конкурс",
    "B2B, вне портала": "B2B"
  };

  const missingRows = Array.isArray(R.missing) ? R.missing : null;
  const hasMissingSection = missingRows !== null;
  const missingCount = hasMissingSection ? missingRows.length : 0;
  const missSum = hasMissingSection ? missingRows.reduce((a, x) => a + x.sale, 0) : 0;

  const hasReconciliationSection = Boolean(reconciliation);
  const closedDeals = reconciliation?.closedNotInRegister ?? [];
  const duplicates = reconciliation?.possibleDuplicates ?? [];
  const recCount = closedDeals.length + duplicates.length;
  const dealUrl = (d) => `${String(portal || "").replace(/\/+$/, "")}/crm/deal/details/${encodeURIComponent(d.dealId)}/`;
  const pm = VIEWER ? null : R.history?.portalMissing;
  const missingContracts = pm?.missingContracts ?? [];
  const missPortalSum = missingContracts.reduce((sum, c) => sum + (c.amountWithVat || 0), 0);
  const risks = R.risks ?? risksFromRows(R.rows, T.hasVal ?? R.rows.some(r => r.val != null));
  const copyTexts = [];

  function copyButton(title, lines) {
    const id = copyTexts.push([`${title} · ${formatMonthLabel(R.month)}`, ...lines].join("\n")) - 1;
    return `<div class="reg-copy"><button type="button" class="btn-toggle-portal" data-copy="${id}">Скопировать для чата</button><span role="status"></span></div>`;
  }

  function riskDetails(title, summary, rows, columns, copy = false) {
    const labels = columns.map(([label]) => label);
    const values = rows.map(row => columns.map(([, value]) => value(row)));
    return `<details class="reg-risk-detail"><summary><strong>${esc(title)}</strong><span>${summary}</span></summary>
      ${copy ? copyButton(title, values.map(cells => cells.map((value, i) => `${labels[i]}: ${value}`).join(" · "))) : ""}
      <div class="rows reg-risk-rows" style="--risk-columns:${labels.length}">
        <div class="r head">${labels.map(label => `<span class="label" data-l="${label}">${label}</span>`).join("")}</div>
        ${values.map(cells => `<div class="r">${cells.map((value, i) => `<span data-l="${labels[i]}">${esc(value)}</span>`).join("")}</div>`).join("")}
      </div></details>`;
  }

  const crmLinks = [];
  if (hasMissingSection && missingCount > 0) {
    crmLinks.push(`<a class="crm-miss-link" href="#r-missing">нет в CRM: ${plural(missingCount, ["договор", "договора", "договоров"])} на ${money(missSum)}</a>`);
  }
  if (hasReconciliationSection && recCount > 0) {
    crmLinks.push(`<a class="crm-miss-link" href="#r-reconciliation">в CRM «Выигран», нет в реестре: ${plural(recCount, ["сделка", "сделки", "сделок"])}</a>`);
  }
  const crmSummaryHtml = crmLinks.length ? ` Расхождения с CRM: ${crmLinks.join(" · ")}.` : "";

  const planPct = T.plan ? T.sale / T.plan : 0;
  const over = T.sale - T.plan;
  const top = R.managers[0] ?? { name: "—", sale: 0 };

  let s = `<section class="block reveal" id="r-month">${head(idx(), `${MONTHS[M - 1][0].toUpperCase() + MONTHS[M - 1].slice(1)}: ${VIEWER ? "ваша выручка" : "выручка отдела"}`, `файл «${esc(R.file)}» · суммы без НДС`)}
    <div class="hero"><div>
      <span class="label">Продано с 1 ${["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"][M - 1]}</span>
      <div class="hero-num"><span class="big">${mln(T.sale).split(",")[0]}</span><span class="of">/ ${mln(T.plan).split(",")[0]}</span></div>
      <div class="hero-amt">млн ₸ · ${pct(planPct)} плана <span class="muted">· ${plural(T.contracts, ["договор", "договора", "договоров"])}</span></div>
      <div class="readout">
        <div><span class="label">Вал</span><div class="v">${T.hasVal && T.val !== null ? `${mln(T.val)}<small> млн · ${pct(T.sale ? T.val / T.sale : 0)}</small>` : `<span class="dim">нет в файле</span>`}</div></div>
        <div><span class="label">Бонус МОП</span><div class="v">${mln(T.bonusMop)}<small> млн</small></div></div>
        ${VIEWER ? "" : `<div><span class="label">Бонус РОП</span><div class="v">${nf0.format(Math.round(T.bonusRop / 1000))}<small> тыс</small></div></div>`}
      </div>
      <p class="verdict">${VIEWER
        ? (over >= 0 ? `Ваш план перевыполнен на <b>${money(over)}</b>.` : `До вашего плана <b>${money(-over)}</b>.`)
        : `${over >= 0 ? `План отдела перевыполнен на <b>${money(over)}</b>.` : `До плана отдела <b>${money(-over)}</b>.`} Больше всех продал ${esc(top.name)}: ${money(top.sale)}. B2B: ${money(T.b2bSale)} из ${money(T.b2bPlan)}.`}${PS ? ` Партнёрские продажи <b>${money(PS.sale)}</b> в эти суммы не входят, они <a href="#r-partner">отдельным блоком ниже</a>.` : ""}${crmSummaryHtml}</p>
    </div><div class="chart-wrap" id="regChart"></div></div></section>`;

  const dealColumns = [
    ["Дата", r => r.date], ["Менеджер", r => r.manager], ["Заказчик", r => r.customer],
    ["Товар", r => r.product], ["Продажа", r => tenge(r.sale)]
  ];
  const marginColumns = [
    ["Вал", r => r.val == null ? "—" : tenge(r.val)],
    ["Маржа", r => r.margin === null ? "—" : r.margin < 0.10 && r.margin >= 0.0995 ? "< 10%" : `${nf1.format(r.margin * 100)}%`]
  ];
  const { belowCost, lowMargin, portalMismatch } = risks;
  const riskCards = [
    belowCost.count && riskDetails("Убыточные продажи", `${belowCost.count} · убыток ${tenge(belowCost.loss)}`,
      belowCost.rows, [...dealColumns, ...marginColumns, ["Убыток", r => tenge(r.loss)]], true),
    lowMargin.count && riskDetails("Низкая маржа < 10%", `${lowMargin.count} · выручка ${tenge(lowMargin.sale)}`,
      lowMargin.rows, [...dealColumns, ...marginColumns], true),
    portalMismatch.count && riskDetails("Расхождение продажи с порталом", `${portalMismatch.count} · отклонения на ${tenge(portalMismatch.difference)}`,
      portalMismatch.rows, [...dealColumns, ["Портал", r => tenge(r.portal)], ["Портал − продажа", r => tenge(r.difference)]])
  ].filter(Boolean);
  const accountingLinks = [
    missingCount && ["#r-missing", "В ОП есть, в CRM нет", `${missingCount} · ${tenge(missSum)}`],
    recCount && ["#r-reconciliation", "В CRM «Выигран», в ОП нет",
      [
        closedDeals.length && `${closedDeals.length} · ${tenge(closedDeals.reduce((sum, d) => sum + d.amount, 0))}`,
        duplicates.length && `Возможные дубли: ${duplicates.length}`
      ].filter(Boolean).join(" · ")],
    missingContracts.length && ["#r-portal", "На портале есть, в ОП нет", `${missingContracts.length} · ${tenge(missPortalSum)} с НДС`]
  ].filter(Boolean);

  if (riskCards.length || accountingLinks.length) {
    s += `<section class="block" id="r-risks">${head(idx(), "Риски маржи и учёта")}
      <div class="reg-risk-cards">${riskCards.join("")}
      ${accountingLinks.map(([href, title, value]) => `<a class="reg-risk-link" href="${href}"><strong>${title}</strong><span>${value}</span></a>`).join("")}</div>
    </section>`;
  }

  // Менеджеры
  s += `<section class="block reveal">${head(idx(), "Менеджеры", "выручка против плана в деньгах · вал · бонус")}<div class="mgr rows">
    <div class="r head"><span class="label" data-l="Менеджер">Менеджер</span><span class="label" data-l="Выручка / план">Выручка / план</span><span class="label" data-l="Вал · маржа">Вал · маржа</span><span class="label" data-l="Бонус">Бонус</span><span class="label" data-l="Дог.">Дог.</span><span class="label" data-l="Сверка с CRM">Сверка с CRM</span><span data-l="" aria-hidden="true"></span></div>`;
  for (const m of R.managers) {
    const p = m.plan ? m.sale / m.plan : 0;
    const cls = !m.plan ? "ink" : p >= 1 ? "good" : p >= 0.8 ? "warn" : "bad";
    const valText = m.val !== null ? `${mln(m.val)} <span class="dim">млн · ${pct(m.margin)}</span>` : `<span class="dim">нет в файле</span>`;
    s += `<div class="r body" role="button" tabindex="0" aria-expanded="false" data-m="${esc(m.name)}">
      <div data-l="Менеджер" class="who"><span class="mono-av">${initials(m.name)}</span><div><div class="nm">${esc(m.name)}</div><div class="rl">${m.plan ? `план ${mln(m.plan)} млн` : "без плана"}</div></div></div>
      <div data-l="Выручка / план"><div class="top"><span class="num">${mln(m.sale)}</span><span class="of">млн${m.plan ? ` · ${pct(p)}` : ""}</span></div>${bar(m.plan ? p * 100 / 3 : 0, cls, m.plan ? 100 / 3 : null)}</div>
      <div data-l="Вал · маржа"><span class="num">${valText}</span></div>
      <div data-l="Бонус"><span class="num">${nf0.format(Math.round(m.bonus / 1000))}</span> <span class="dim">тыс</span></div>
      <div data-l="Договоры" class="num">${m.contracts}</div>
      <div data-l="Сверка с CRM">${m.missCount ? (hasMissingSection && missingCount > 0 ? `<a class="flag-miss crm-miss-link" href="#r-missing">нет в CRM: ${m.missCount} на ${mln(m.missSum)} млн</a>` : `<span class="flag-miss">нет в CRM: ${m.missCount} на ${mln(m.missSum)} млн</span>`) : m.contracts ? `<span class="flag-ok">всё отмечено</span>` : `<span class="flag-ok">—</span>`}</div>
      <span data-l="" class="chev" aria-hidden="true">${m.contracts ? "▾" : ""}</span>
    </div><div class="detail"><div><div class="deals">${dealRows(m.rows)}</div></div></div>`;
  }
  s += `</div><p class="note-src">Шкала — до 300% плана, засечка — 100%. Цвет: зелёный — план выполнен, охра — от 80%, красный — меньше.</p></section>`;

  // Состав
  const g = Object.fromEntries(R.groups.map((x) => [x.g, x]));
  const ipG = g["ИП"] ?? { sale: 0, val: 0 };
  const ktG = g["КТ"] ?? { sale: 0, val: 0 };
  const ipValText = ipG.val !== null ? `${mln(ipG.sale)} млн <small>(маржа ${mln(ipG.val)} млн · ${pct(ipG.sale ? ipG.val / ipG.sale : 0)})</small>` : `${mln(ipG.sale)} млн <span class="dim">нет в файле</span>`;
  const ktValText = ktG.val !== null ? `${mln(ktG.sale)} млн <small>(маржа ${mln(ktG.val)} млн · ${pct(ktG.sale ? ktG.val / ktG.sale : 0)})</small>` : `${mln(ktG.sale)} млн <span class="dim">нет в файле</span>`;
  s += `<section class="block reveal">${head(idx(), "Что и как продаём", "доля в выручке · маржа")}<div class="two"><div>
    <div class="gsum"><div><span class="label">ИП · интерактивные панели</span><div class="v">${ipValText}</div></div>
    <div><span class="label">КТ · компьютерная техника</span><div class="v">${ktValText}</div></div></div>
    <div class="mix rows"><div class="r head"><span class="label" data-l="Товар">Товар</span><span class="label" data-l="Выручка">Выручка</span><span class="label" data-l="Вал">Вал</span><span class="label" data-l="Маржа">Маржа</span></div>
    ${R.mix.map((x) => `<div class="r"><span data-l="Товар">${esc(x.kind)} <span class="dim">${x.group}</span></span><div data-l="Выручка">${bar(R.mix[0]?.sale ? x.sale / R.mix[0].sale * 100 : 0, "ink")}<span class="dim">${mln(x.sale)} млн · ${plural(Math.round(x.qty), ["шт", "шт", "шт"])}</span></div><span data-l="Вал" class="num">${x.val !== null ? mln(x.val) : "—"}</span><span data-l="Маржа" class="num">${x.val !== null && x.sale ? pct(x.val / x.sale) : "—"}</span></div>`).join("")}</div></div>
    <div><div class="mix rows"><div class="r head"><span class="label" data-l="Канал">Канал</span><span class="label" data-l="Выручка">Выручка</span><span class="label" data-l="Вал">Вал</span><span class="label" data-l="Маржа">Маржа</span></div>
    ${R.channels.map((x) => `<div class="r"><span data-l="Канал">${esc(x.name)} <span class="dim">${x.contracts}</span></span><div data-l="Выручка">${bar(R.channels[0]?.sale ? x.sale / R.channels[0].sale * 100 : 0, "ink")}<span class="dim">${mln(x.sale)} млн</span></div><span data-l="Вал" class="num">${x.val !== null ? mln(x.val) : "—"}</span><span data-l="Маржа" class="num">${x.val !== null && x.sale ? pct(x.val / x.sale) : "—"}</span></div>`).join("")}</div></div>
  </div></section>`;

  // Партнёрские продажи: низкий вал, поэтому отдельно от выручки, вала, бонусов и плана отдела
  if (PS) {
    s += `<section class="block reveal" id="r-partner">${head(idx(), "Партнёрские продажи", `${esc(PS.kinds.join(", ").toLowerCase())} · не входят в выручку, вал, бонусы и план отдела`)}
    <div class="gsum partner-sum">
      <div><span class="label">Выручка</span><div class="v">${mln(PS.sale)}<small> млн · ${plural(PS.contracts, ["договор", "договора", "договоров"])}</small></div></div>
      <div><span class="label">Вал · маржа</span><div class="v">${PS.val !== null ? `${mln(PS.val)}<small> млн · ${pct(PS.margin)}</small>` : `<span class="dim">нет в файле</span>`}</div></div>
      ${VIEWER
        ? `<div><span class="label">Бонус МОП</span><div class="v">${nf0.format(Math.round(PS.bonusMop / 1000))}<small> тыс</small></div></div>`
        : `<div><span class="label">Бонус МОП · РОП</span><div class="v">${nf0.format(Math.round(PS.bonusMop / 1000))}<small> тыс · </small>${nf0.format(Math.round(PS.bonusRop / 1000))}<small> тыс</small></div></div>`}
    </div>
    <div class="all partner rows"><div class="r head"><span class="label" data-l="Дата">Дата</span><span class="label" data-l="Менеджер">Менеджер</span><span class="label" data-l="Заказчик">Заказчик</span><span class="label" data-l="Товар">Товар</span><span class="label" data-l="Шт">Шт</span><span class="label" data-l="Сумма">Сумма</span><span class="label" data-l="Вал">Вал</span><span class="label" data-l="Маржа">Маржа</span><span class="label" data-l="Канал">Канал</span></div>
    ${PS.rows.map((x) => regRow(x, false)).join("")}</div></section>`;
  }

  let reconciliationHtml = "";
  if (hasReconciliationSection) {
    const dealLink = (d) => `<a href="${esc(dealUrl(d))}" target="_blank" rel="noopener">${esc(d.title)}</a>`;
    const rows = [
      ...closedDeals.map(d => `<div class="mismatch-row"><div class="info">${dealLink(d)} · ${esc(d.manager)}</div><div class="meta">${esc(fmt(d.amount) + " ₸")} · ${esc(ddmm(d.date))}</div></div>`),
      ...duplicates.map(d => `<div class="mismatch-row"><div class="info">${dealLink(d)} · ${esc(d.manager)}</div><div class="meta">Возможен дубль · в реестре у ${esc(d.registerManager)}</div></div>`)
    ];
    reconciliationHtml = `<div id="r-reconciliation"><h3>В CRM «Выигран», в реестре нет</h3><div class="reconciliation mismatches-list">${rows.length ? rows.join("") : "расхождений нет"}</div>
      ${recCount ? copyButton("В CRM «Выигран», в ОП нет", [
        ...closedDeals.map(d => `${d.date} · ${d.manager} · ${d.title} · ${tenge(d.amount)} · ${dealUrl(d)}`),
        ...duplicates.map(d => `Возможен дубль · ${d.manager} · ${d.title} · в реестре у ${d.registerManager} · ${dealUrl(d)}`)
      ]) : ""}</div>`;
  }

  // Нет в CRM
  if (hasMissingSection) {
    s += `<section class="block reveal" id="r-missing">${head(idx(), "В реестре есть, в CRM не «Выигран»", `${plural(missingCount, ["договор", "договора", "договоров"])} на ${money(missSum)}`)}
      <p class="lead">Эти договоры подписаны, но в Битрикс24 сделки нет или она не переведена в «Выигран». Пульт их не видит, поэтому выручка в CRM <b>на ${money(missSum)} меньше</b>, чем в реестре. Сверка по названию заказчика и сумме.</p>
      ${missingCount ? copyButton("В ОП есть, в CRM нет", missingRows.map(c =>
        `${c.date} · ${c.manager} · ${c.customer} · ${c.products.join(", ")} · ${tenge(c.sale)}`)) : ""}
      ${missingTable(missingRows)}${reconciliationHtml}</section>`;
  } else if (reconciliationHtml) {
    s += `<section class="block reveal">${head(idx(), "Сверка с CRM", "данные по реестру отсутствуют")}${reconciliationHtml}</section>`;
  }


  // Учитываем и менеджеров, у которых были только партнёрские продажи.
  const managersWithContracts = R.legacySummary
    ? R.managers.filter(m => m.contracts).map(m => m.name)
    : [...new Set(R.rows.map(r => r.manager))];
  // Все договоры
  s += `<section class="block reveal">${head(idx(), "Все договоры месяца", `${R.legacySummary ? "Старый кэш: подробные строки недоступны" : `${R.rows.length} строк реестра`}`)}
    <div class="chips" id="regChips" ${managersWithContracts.length <= 1 ? "hidden" : ""}><button aria-pressed="true" data-f="">Все</button>${managersWithContracts.map((name) => `<button aria-pressed="false" data-f="${esc(name)}">${esc(name)}</button>`).join("")}</div>
    <div class="all rows" id="regAll"></div><button class="btn more" id="regMore"></button></section>`;

  // Ошибка загрузки истории
  if (!R.history && R.historyError) {
    s += `<section class="block reveal" id="r-history-error">${head(idx(), "История реестра", "")}
      <p class="lead"><span class="flag-miss">${esc(R.historyError)}</span></p>
    </section>`;
  }

  // История по месяцам
  if (R.history && R.historyError) {
    s += `<section class="block reveal"><div class="mismatches-box" style="margin-bottom:20px;"><span class="flag-miss">Внимание:</span> ${esc(R.historyError)}</div></section>`;
  }
  if (R.history?.failedFiles && R.history.failedFiles.length > 0) {
    s += `<section class="block reveal"><div class="mismatches-box" style="margin-bottom:20px;"><span class="flag-miss">Не удалось скачать с Диска (${R.history.failedFiles.length}):</span> ${R.history.failedFiles.map((f) => `<b>${esc(f.fileName)}</b> (${esc(f.reason)})`).join(", ")}</div></section>`;
  }

  if (R.history && R.history.months && R.history.months.length > 0) {
    const histMeta = R.history.cachedAt
      ? `с июля 2026 · ${R.history.months.length} месяцев · кэш от ${esc(formatAlmatyTimeStr(R.history.cachedAt))}`
      : `с июля 2026 · ${R.history.months.length} месяцев`;
    s += `<section class="block reveal" id="r-history">${head(idx(), "История по месяцам", histMeta)}
      <div class="hist rows">
        <div class="r head">
          <span class="label" data-l="Месяц">Месяц</span>
          <span class="label" data-l="Файл">Файл</span>
          <span class="label" data-l="Выручка">Выручка</span>
          <span class="label" data-l="Вал">Вал</span>
          <span class="label" data-l="Маржа">Маржа</span>
          <span class="label" data-l="Дог.">Дог.</span>
          <span class="label" data-l="План">План</span>
          <span class="label" data-l="% плана">% плана</span>
          <span data-l="" aria-hidden="true"></span>
        </div>`;

    for (const m of R.history.months) {
      const p = m.plan ? (m.sale / m.plan) : 0;
      const cls = !m.plan ? "ink" : p >= 1 ? "good" : p >= 0.8 ? "warn" : "bad";
      const valDisplay = m.hasVal && m.val !== null ? `${mln(m.val)} млн` : `<span class="dim">нет в файле</span>`;
      const marginDisplay = m.margin !== null ? pct(m.margin) : `<span class="dim">—</span>`;
      const planDisplay = m.plan ? `${mln(m.plan)} млн` : `<span class="dim">—</span>`;
      const planPctDisplay = m.planPct !== null ? `${pct(m.planPct / 100)}` : `<span class="dim">—</span>`;

      s += `<div class="r body" role="button" tabindex="0" aria-expanded="false" data-month="${esc(m.month)}" aria-current="${m.month === R.month}">
        <div data-l="Месяц" class="nm"><b>${esc(m.label || formatMonthLabel(m.month))}</b></div>
        <div data-l="Файл" class="dim" style="font-family:var(--mono); font-size:12px;">${esc(m.fileName)}</div>
        <div data-l="Выручка"><span class="num">${mln(m.sale)}</span> <span class="dim">млн</span>${m.partnerSale ? `<span class="dim partner-sub" title="Партнёрские продажи, в выручку не входят">+ ${mln(m.partnerSale)} партнёрские</span>` : ""}</div>
        <div data-l="Вал"><span class="num">${valDisplay}</span></div>
        <div data-l="Маржа"><span class="num">${marginDisplay}</span></div>
        <div data-l="Договоры" class="num">${m.contracts}</div>
        <div data-l="План"><span class="num">${planDisplay}</span></div>
        <div data-l="% плана"><span class="num ${cls}">${planPctDisplay}</span></div>
        <span data-l="" class="chev" aria-hidden="true">${m.byManager && m.byManager.length ? "▾" : ""}</span>
      </div>
      <div class="detail"><div>
        <div class="deals">
          <div class="r head">
            <span class="label" data-l="Менеджер">Менеджер</span>
            <span class="label" data-l="Выручка">Выручка</span>
            <span class="label" data-l="Вал">Вал</span>
            <span class="label" data-l="Маржа">Маржа</span>
            <span class="label" data-l="Дог.">Дог.</span>
            <span class="label" data-l="План">План</span>
            <span class="label" data-l="% плана">% плана</span>
          </div>
          ${(m.byManager || []).map((mgr) => {
            const mp = mgr.plan ? (mgr.sale / mgr.plan) : 0;
            const mcls = !mgr.plan ? "ink" : mp >= 1 ? "good" : mp >= 0.8 ? "warn" : "bad";
            const mVal = m.hasVal && mgr.val !== null ? `${mln(mgr.val)} млн` : `<span class="dim">нет в файле</span>`;
            const mMargin = mgr.margin !== null ? pct(mgr.margin) : `<span class="dim">—</span>`;
            return `<div class="r">
              <span data-l="Менеджер" class="nm">${esc(mgr.name)}</span>
              <span data-l="Выручка" class="num">${mln(mgr.sale)} млн</span>
              <span data-l="Вал" class="num">${mVal}</span>
              <span data-l="Маржа" class="num">${mMargin}</span>
              <span data-l="Договоры" class="num">${mgr.contracts}</span>
              <span data-l="План" class="num">${mgr.plan ? `${mln(mgr.plan)} млн` : "—"}</span>
              <span data-l="% плана" class="num ${mcls}">${mgr.planPct !== null ? pct(mgr.planPct / 100) : "—"}</span>
            </div>`;
          }).join("")}
        </div>
      </div></div>`;
    }
    s += `</div><p class="note-src">Источник планов — таблица планов менеджеров из соответствующего файла реестра на конец месяца. В сентябре колонка вала в файле отсутствовала, маржа не вычисляется.</p></section>`;
  }

  // Есть на портале, нет в реестре
  if (pm) {
    s += `<section class="block reveal" id="r-portal">${head(idx(), "Есть на портале, нет в реестре", "текущий и предыдущий месяц · сопоставление 1-к-1")}
      <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px;">
        ${Object.entries(pm.monthlyCounts || {}).map(([ym, cnt]) => `
          <div class="pill" style="padding:6px 12px; font-size:12px; border-radius:2px;">
            <b>${esc(formatMonthLabel(ym))}</b>: на портале <b>${cnt.total}</b> · сопоставлено <b>${cnt.matched ?? (cnt.total - (cnt.missing ?? 0))}</b>${cnt.matchedByCustomerSum ? ` (1-к-1: ${cnt.matched1to1 ?? ((cnt.matched ?? cnt.total) - cnt.matchedByCustomerSum)}, по сумме заказчика: ${cnt.matchedByCustomerSum})` : ""} · нет в реестре <b>${cnt.missing ?? (cnt.total - (cnt.matched ?? cnt.total))}</b>
          </div>
        `).join("")}
      </div>`;

    if (pm.error) {
      s += `<div class="mismatches-box" style="margin-top:12px;"><span class="flag-miss">Ошибка сверки с порталом:</span> ${esc(pm.error)}</div>`;
    }
    if (!pm.error && !missingContracts.length) {
      s += `<p class="lead"><span class="flag-ok">✓ Все договоры портала за ${esc(formatMonthLabel(pm.currentMonth))} и ${esc(formatMonthLabel(pm.previousMonth))} найдены в реестре.</span></p>`;
    } else if (missingContracts.length) {
      s += `<p class="lead">На портале zakup.gov.kz найдено <b>${missingContracts.length}</b> договоров текущего и прошлого месяцев, не сопоставленных с реестром, на общую сумму <b>${money(missPortalSum)}</b> (с НДС). Сопоставление 1-в-1 и по сумме заказчика (окно 14 дней, допуск до 3%).</p>
      ${copyButton("На портале есть, в ОП нет", missingContracts.map(c =>
        [c.signDate, c.supplier, c.customer, tenge(c.amountWithVat) + " с НДС", c.contractNumber, egzUrl(c)].filter(Boolean).join(" · ")))}
      <div id="portal-miss-list" class="portal-miss rows ${missingContracts.length > 10 ? 'collapsed' : ''}">
        <div class="r head">
          <span class="label" data-l="Дата">Дата</span>
          <span class="label" data-l="Поставщик">Поставщик</span>
          <span class="label" data-l="Заказчик">Заказчик</span>
          <span class="label" data-l="Сумма с НДС">Сумма с НДС</span>
          <span class="label" data-l="Способ закупки">Способ закупки</span>
          <span class="label" data-l="Договор">Договор</span>
        </div>
        ${missingContracts.map((c) => `
          <div class="r">
            <span data-l="Дата" class="num">${ddmm(c.signDate)}</span>
            <span data-l="Поставщик" class="nm">${esc(c.supplier)}</span>
            <span data-l="Заказчик" class="cust" title="${esc(c.customer)}">${esc(c.customer)}</span>
            <span data-l="Сумма с НДС" class="num">${fmt(c.amountWithVat)} ₸</span>
            <span data-l="Способ закупки" class="dim" style="font-size:12px;">${esc(c.method)}</span>
            <span data-l="Договор" class="reg-contract-number">${egzUrl(c)
              ? `<a href="${esc(egzUrl(c))}" target="_blank" rel="noopener noreferrer">${esc(c.contractNumber || c.id)}</a>`
              : esc(c.contractNumber)}</span>
          </div>
        `).join("")}
      </div>`;
      if (missingContracts.length > 10) {
        s += `<div style="margin-top:12px;">
          <button type="button" class="btn-toggle-portal" onclick="
            var l=document.getElementById('portal-miss-list');
            if(l){
              var c=l.classList.toggle('collapsed');
              this.textContent=c?'Показать все (${missingContracts.length})':'Свернуть';
            }
          ">Показать все (${missingContracts.length})</button>
        </div>`;
      }
    }
    s += `</section>`;
  }

  // Дисциплина ведения реестра
  if (R.history?.discipline) {
    const disc = R.history.discipline;
    s += `<section class="block reveal" id="r-discipline">${head(idx(), "Дисциплина ведения реестра", (VIEWER ? "" : "пропуски дней · ") + "задержка внесения · продажи ниже закупа · правки задним числом")}
      <div class="gsum">
        ${VIEWER ? "" : `<div>
          <span class="label">Пропущено рабочих дней</span>
          <div class="v">${disc.missingWorkingDays.length}<small> дней</small></div>
        </div>`}
        <div>
          <span class="label">Запоздалые строки (лаг ≥ 2 раб. дней)</span>
          <div class="v ${disc.laggedRowsCount > 0 ? "bad" : ""}">${disc.laggedRowsCount}<small> строк</small></div>
        </div>
        <div>
          <span class="label">Продажи ниже себестоимости</span>
          <div class="v ${disc.salesBelowCost.length > 0 ? "bad" : ""}">${disc.salesBelowCost.length}<small> сделок</small></div>
        </div>
        <div>
          <span class="label">Правок задним числом</span>
          <div class="v">${disc.retroChanges.length}<small> изменений</small></div>
        </div>
      </div>`;

    if (!VIEWER && disc.missingWorkingDays.length > 0) {
      s += `<div style="margin-bottom:18px;">
        <span class="label" style="display:block; margin-bottom:8px;">Даты пропущенных рабочих дней (нет файла на Диске):</span>
        <div class="chips">${disc.missingWorkingDays.map((d) => `<span class="pill" style="font-family:var(--mono);">${ddmm(d)}</span>`).join("")}</div>
      </div>`;
    }

    if (disc.laggedByManager.length > 0) {
      s += `<div style="margin-bottom:18px;">
        <span class="label" style="display:block; margin-bottom:8px;">Запоздалые строки по менеджерам (лаг ≥ 2 рабочих дней):</span>
        <div style="display:flex; flex-wrap:wrap; gap:8px;">
          ${disc.laggedByManager.map((m) => `<span class="pill bad">${esc(m.manager)}: <b>${m.count}</b></span>`).join("")}
        </div>
      </div>`;
    }

    if (disc.salesBelowCost.length > 0) {
      s += `<div style="margin-bottom:18px;">
        <span class="label" style="display:block; margin-bottom:8px;">Сделки с продажей ниже себестоимости:</span>
        <div class="rows">
          <div class="r head" style="grid-template-columns: 56px 110px minmax(0, 2fr) minmax(0, 2fr) 100px 100px 90px;">
            <span class="label" data-l="Дата">Дата</span>
            <span class="label" data-l="Менеджер">Менеджер</span>
            <span class="label" data-l="Заказчик">Заказчик</span>
            <span class="label" data-l="Товар">Товар</span>
            <span class="label" data-l="Продажа">Продажа</span>
            <span class="label" data-l="Себестоимость">Себестоимость</span>
            <span class="label" data-l="Убыток">Убыток</span>
          </div>
          ${disc.salesBelowCost.map((r) => `
            <div class="r" style="grid-template-columns: 56px 110px minmax(0, 2fr) minmax(0, 2fr) 100px 100px 90px; font-size:13px; padding:8px 0;">
              <span data-l="Дата" class="num">${ddmm(r.date)}</span>
              <span data-l="Менеджер" class="nm">${esc(r.manager)}</span>
              <span data-l="Заказчик" class="cust" title="${esc(r.customer)}">${esc(r.customer)}</span>
              <span data-l="Товар">${esc(r.product)}</span>
              <span data-l="Продажа" class="num">${fmt(r.sale)} ₸</span>
              <span data-l="Себестоимость" class="num">${fmt(r.cost)} ₸</span>
              <span data-l="Убыток" class="num" style="color:var(--bad); font-weight:500;">−${fmt(Math.abs(r.cost - r.sale))} ₸</span>
            </div>
          `).join("")}
        </div>
      </div>`;
    }

    if (disc.retroChanges.length > 0) {
      s += `<div style="margin-bottom:18px;">
        <span class="label" style="display:block; margin-bottom:8px;">Правки и удаления задним числом:</span>
        <div id="retro-changes-list" class="retro-list rows ${disc.retroChanges.length > 25 ? 'collapsed' : ''}">
          <div class="r head" style="grid-template-columns: 56px 110px minmax(0, 2fr) minmax(0, 2fr) 90px 80px minmax(0, 2fr);">
            <span class="label" data-l="Дата">Дата</span>
            <span class="label" data-l="Менеджер">Менеджер</span>
            <span class="label" data-l="Заказчик">Заказчик</span>
            <span class="label" data-l="Товар">Товар</span>
            <span class="label" data-l="Сумма">Сумма</span>
            <span class="label" data-l="Тип">Тип</span>
            <span class="label" data-l="Что изменилось">Что изменилось</span>
          </div>
          ${disc.retroChanges.map((rc) => {
            const note = rc.note || "";
            // Сформированное историей примечание повторяет diff, в том числе прежнего менеджера.
            const fileNote = VIEWER && rc.diff && note.match(/^Изменено в .*?\.xlsx(?=:|$)/i);
            let changeDesc = esc(fileNote ? fileNote[0] : note);
            if (rc.diff) {
              const parts = [];
              if (rc.diff.sale) parts.push(`Сумма: ${fmt(rc.diff.sale.before)} → ${fmt(rc.diff.sale.after)} ₸`);
              if (rc.diff.cost) parts.push(`Закуп: ${fmt(rc.diff.cost.before)} → ${fmt(rc.diff.cost.after)} ₸`);
              if (rc.diff.manager) parts.push(`Менеджер: ${esc(rc.diff.manager.before)} → ${esc(rc.diff.manager.after)}`);
              if (rc.diff.date) parts.push(`Дата: ${ddmm(rc.diff.date.before)} → ${ddmm(rc.diff.date.after)}`);
              changeDesc = [...parts, changeDesc].filter(Boolean).join("<br>");
            }
            return `<div class="r" style="grid-template-columns: 56px 110px minmax(0, 2fr) minmax(0, 2fr) 90px 80px minmax(0, 2fr); font-size:13px; padding:8px 0;">
              <span data-l="Дата" class="num">${ddmm(rc.date)}</span>
              <span data-l="Менеджер" class="nm">${esc(rc.manager)}</span>
              <span data-l="Заказчик" class="cust" title="${esc(rc.customer)}">${esc(rc.customer)}</span>
              <span data-l="Товар">${esc(rc.product)}</span>
              <span data-l="Сумма" class="num">${fmt(rc.sale)} ₸</span>
              <span data-l="Тип"><span class="pill ${rc.type === "deleted" ? "bad" : "warn"}">${rc.type === "deleted" ? "удалено" : "изменено"}</span></span>
              <span data-l="Что изменилось" class="dim" style="font-size:12px;">${changeDesc}</span>
            </div>`;
          }).join("")}
        </div>`;
      if (disc.retroChanges.length > 25) {
        s += `<div style="margin-top:12px;">
          <button type="button" class="btn-toggle-portal" onclick="
            var l=document.getElementById('retro-changes-list');
            if(l){
              var c=l.classList.toggle('collapsed');
              this.textContent=c?'Показать все (${disc.retroChanges.length})':'Свернуть';
            }
          ">Показать все (${disc.retroChanges.length})</button>
        </div>`;
      }
      s += `</div>`;
    }
    s += `</section>`;
  }

  // Сверка с CRM за прошлые месяцы
  if (R.history?.months) {
    const pastMonths = R.history.months.filter((m) => m.month < latestMonth);
    const unperformed = pastMonths.filter((m) => !m.reconciliationPerformed);
    const performed = pastMonths.filter((m) => m.reconciliationPerformed);
    const pastWithMissing = performed.filter((m) => m.missingCrm && m.missingCrm.length > 0);
    s += `<section class="block reveal" id="r-crm-history">${head(idx(), "Сверка с CRM за прошлые месяцы", "договоры реестра прошлых месяцев, не найденные в CRM со статусом «Выигран»")}`;

    if (pastMonths.length === 0) {
      s += `<p class="dim">Нет данных за прошлые месяцы.</p>`;
    } else if (unperformed.length === pastMonths.length) {
      s += `<p class="lead"><span class="flag-miss">Сверка с CRM за прошлые месяцы не выполнялась.</span></p>`;
    } else {
      if (unperformed.length > 0) {
        s += `<p class="dim" style="margin-bottom:12px;">Сверка с CRM не выполнялась за: ${unperformed.map((m) => esc(m.label || formatMonthLabel(m.month))).join(", ")}.</p>`;
      }
      if (pastWithMissing.length === 0) {
        s += `<p class="lead"><span class="flag-ok">✓ За проверенные прошлые месяцы все договоры реестра найдены в CRM со статусом «Выигран».</span></p>`;
      } else {
        for (const pm of pastWithMissing) {
          const missCount = pm.missingCrm.length;
          const missTotal = pm.missingCrm.reduce((sum, c) => sum + (c.sale || 0), 0);
          s += `<div style="margin-bottom:24px;">
            <h3 style="font-size:15px; font-weight:500; margin-bottom:10px;">${esc(pm.label || formatMonthLabel(pm.month))}: <span class="flag-miss">${missCount} договоров на ${money(missTotal)}</span></h3>
            ${missingTable(pm.missingCrm)}
          </div>`;
        }
      }
    }
    s += `</section>`;
  }

  el.innerHTML = s;
  for (const button of el.querySelectorAll("[data-copy]")) {
    button.onclick = async () => {
      const copied = await copyForChat(copyTexts[Number(button.dataset.copy)]);
      button.nextElementSibling.textContent = copied ? "Скопировано" : "Не удалось скопировать";
    };
  }

  function missingTable(rows) {
    return `<div class="miss rows">
      <div class="r head"><span class="label" data-l="Дата">Дата</span><span class="label" data-l="Менеджер">Менеджер</span><span class="label" data-l="Заказчик">Заказчик</span><span class="label" data-l="Товар">Товар</span><span class="label" data-l="Сумма">Сумма</span></div>
      ${rows.map(x => `<div class="r">
        <span data-l="Дата" class="num">${ddmm(x.date)}</span>
        <span data-l="Менеджер" class="nm">${esc(x.manager)}</span>
        <span data-l="Заказчик" class="cust" title="${esc(x.customer)}">${esc(x.customer)}</span>
        <span data-l="Товар">${esc(x.products.join(", "))}</span>
        <span data-l="Сумма" class="num">${mln(x.sale)} млн</span>
      </div>`).join("")}</div>`;
  }

  function regRow(x, tagPartner) {
    const tag = tagPartner && x.partner ? ` <span class="partner-tag" title="Партнёрская продажа: в выручку отдела не входит">партнёрская</span>` : "";
    return `<div class="r"><span data-l="Дата" class="num">${ddmm(x.date)}</span><span data-l="Менеджер" class="nm">${esc(x.manager)}</span><span data-l="Заказчик" class="cust" title="${esc(x.customer)}">${esc(x.customer)}</span><span data-l="Товар">${esc(x.product)}${tag}</span><span data-l="Шт" class="num">${fmt(x.qty)}</span><span data-l="Сумма" class="num">${mln(x.sale)} млн</span><span data-l="Вал" class="num">${x.val !== null ? mln(x.val) : "—"}</span><span data-l="Маржа" class="num">${x.val !== null && x.sale ? pct(x.val / x.sale) : "—"}</span><span data-l="Канал" class="dim">${esc(SHORT_CH[x.channel] ?? x.channel)}</span></div>`;
  }

  function dealRows(rows) {
    return `<div class="r head"><span class="label" data-l="Дата">Дата</span><span class="label" data-l="Заказчик">Заказчик</span><span class="label" data-l="Товар">Товар</span><span class="label" data-l="Шт">Шт</span><span class="label" data-l="Сумма">Сумма</span><span class="label" data-l="Вал">Вал</span><span class="label" data-l="Маржа">Маржа</span></div>` +
      rows.map((x) => `<div class="r"><span data-l="Дата" class="num">${ddmm(x.date)}</span><span data-l="Заказчик" class="cust" title="${esc(x.customer)}">${esc(x.customer)}</span><span data-l="Товар">${esc(x.product)} <span class="dim">${esc(x.type)}</span></span><span data-l="Шт" class="num">${fmt(x.qty)}</span><span data-l="Сумма" class="num">${mln(x.sale)} млн</span><span data-l="Вал" class="num">${x.val !== null ? mln(x.val) : "—"}</span><span data-l="Маржа" class="num">${x.val !== null && x.sale ? pct(x.val / x.sale) : "—"}</span></div>`).join("");
  }

  let regFilter = "", regShown = 12;
  function updateRegTable() {
    const rows = R.rows.filter((x) => !regFilter || x.manager === regFilter);
    const regAllEl = document.getElementById("regAll");
    if (!regAllEl) return;
    regAllEl.innerHTML = `<div class="r head"><span class="label" data-l="Дата">Дата</span><span class="label" data-l="Менеджер">Менеджер</span><span class="label" data-l="Заказчик">Заказчик</span><span class="label" data-l="Товар">Товар</span><span class="label" data-l="Шт">Шт</span><span class="label" data-l="Сумма">Сумма</span><span class="label" data-l="Вал">Вал</span><span class="label" data-l="Маржа">Маржа</span><span class="label" data-l="Канал">Канал</span></div>` +
      rows.slice(0, regShown).map((x) => regRow(x, true)).join("");
    const more = document.getElementById("regMore");
    if (more) {
      more.hidden = rows.length <= regShown;
      more.textContent = `Показать ещё ${Math.min(20, rows.length - regShown)}`;
    }
  }

  function renderRegChart() {
    const chartEl = document.getElementById("regChart");
    if (!chartEl || !R.daily.length) return;
    const mobile = innerWidth <= 760;
    const W = mobile ? 420 : 760, H = mobile ? 280 : 330, L = 8, Rr = mobile ? 70 : 92, Tp = 18, B = 30;
    const iw = W - L - Rr, ih = H - Tp - B, days = new Date(Number(R.month.slice(0, 4)), M, 0).getDate(), plan = R.total.plan, fact = R.total.sale;
    const yMax = Math.max(plan, fact, 1) * 1.08, x = (d) => L + (d / days) * iw, y = (v) => Tp + ih - (v / yMax) * ih;
    let chSvg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${VIEWER ? "Ваша выручка" : "Выручка отдела"} накопительно за месяц против плана">`;
    for (let i = 0; i <= 4; i++) {
      const v = (Math.ceil(yMax / 4 / 1e7) * 1e7) * i;
      if (v > yMax) break;
      chSvg += `<line x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(20,20,20,${i ? .08 : .3})"/>`;
      if (i) chSvg += `<text x="${L + 4}" y="${y(v) - 6}" class="burn-axis" font-family="JetBrains Mono" font-size="11" fill="#8c8981">${mln(v).split(",")[0]}</text>`;
    }
    chSvg += `<path d="M${x(0)},${y(0)} L${x(days)},${y(plan)}" stroke="#8c8981" stroke-width="1.5" stroke-dasharray="5 5" fill="none"/>`;
    let d = `M${x(0)},${y(0)}`, prev = 0;
    for (const p of R.daily) {
      const dd = Number(p.d.slice(8));
      d += ` L${x(dd - 1)},${y(prev)} L${x(dd)},${y(p.sale)}`;
      prev = p.sale;
    }
    const lastDayNum = Number(R.daily[R.daily.length - 1].d.slice(8));
    chSvg += `<path d="${d} L${x(lastDayNum)},${y(0)} Z" fill="rgba(20,20,20,.06)"/><path d="${d}" fill="none" stroke="#141414" stroke-width="2.2" stroke-linejoin="round"/>`;
    chSvg += `<circle cx="${x(lastDayNum)}" cy="${y(fact)}" r="4.5" fill="#faf9f5" stroke="#141414" stroke-width="2"/>`;
    let factLabelY = y(fact) + 4;
    let planLabelY = y(plan) + 4;
    if (Math.abs(factLabelY - planLabelY) < 22) {
      const upper = Math.max(12, Math.min(H - B - 18, (factLabelY + planLabelY) / 2 - 11));
      const lower = upper + 22;
      [factLabelY, planLabelY] = fact >= plan ? [upper, lower] : [lower, upper];
    }
    chSvg += `<text x="${x(lastDayNum) + 10}" y="${factLabelY}" font-family="JetBrains Mono" font-size="12" font-weight="500" fill="#141414">${mln(fact)} млн</text>`;
    chSvg += `<text x="${x(days) + 8}" y="${planLabelY}" font-family="JetBrains Mono" font-size="12" fill="#55534e">план ${mln(plan).split(",")[0]}</text>`;
    for (const dd of [1, 8, 15, 22, 29].filter(d => d <= days)) {
      chSvg += `<text x="${x(dd - .5)}" y="${H - 8}" text-anchor="middle" font-family="JetBrains Mono" font-size="11" fill="#8c8981">${dd}</text>`;
    }
    chartEl.innerHTML = chSvg + `</svg><div class="legend"><span><i></i>продано, накопительно</span><span><i class="dash"></i>план равномерно</span></div>`;
  }

  renderRegChart();
  updateRegTable();

  // Wire events
  const chips = document.getElementById("regChips");
  if (chips) {
    chips.onclick = (e) => {
      const chip = e.target.closest("button");
      if (!chip) return;
      regFilter = chip.dataset.f;
      regShown = 12;
      chips.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === chip));
      updateRegTable();
    };
  }

  const moreBtn = document.getElementById("regMore");
  if (moreBtn) {
    moreBtn.onclick = () => {
      regShown += 20;
      updateRegTable();
    };
  }
  return renderRegChart;
};
})();
