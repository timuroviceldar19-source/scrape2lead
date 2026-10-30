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
  const short = (s, n = 70) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
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

  window.__renderRegisterTab = function (R, el) {
    if (!el) return;
    if (!R || R.error) {
      el.innerHTML = `<section class="block"><p class="lead">${esc(R?.error || "Реестр не подключён: нет данных")}</p></section>`;
      return;
    }

  const T = R.total;
  const M = Number(R.month.slice(5, 7));
  const planPct = T.plan ? T.sale / T.plan : 0;
  const over = T.sale - T.plan;
  const top = R.managers[0] ?? { name: "—", sale: 0 };

  let s = `<section class="block reveal" id="r-month">${head("01", `${MONTHS[M - 1][0].toUpperCase() + MONTHS[M - 1].slice(1)}: выручка отдела`, `файл «${esc(R.file)}» · суммы без НДС`)}
    <div class="hero"><div>
      <span class="label">Продано с 1 ${["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"][M - 1]}</span>
      <div class="hero-num"><span class="big">${mln(T.sale).split(",")[0]}</span><span class="of">/ ${mln(T.plan).split(",")[0]}</span></div>
      <div class="hero-amt">млн ₸ · ${pct(planPct)} плана <span class="muted">· ${plural(T.contracts, ["договор", "договора", "договоров"])}</span></div>
      <div class="readout">
        <div><span class="label">Вал</span><div class="v">${T.hasVal && T.val !== null ? `${mln(T.val)}<small> млн · ${pct(T.sale ? T.val / T.sale : 0)}</small>` : `<span class="dim">нет в файле</span>`}</div></div>
        <div><span class="label">Бонус МОП</span><div class="v">${mln(T.bonusMop)}<small> млн</small></div></div>
        <div><span class="label">Бонус РОП</span><div class="v">${nf0.format(Math.round(T.bonusRop / 1000))}<small> тыс</small></div></div>
      </div>
      <p class="verdict">${over >= 0 ? `План отдела перевыполнен на <b>${money(over)}</b>.` : `До плана отдела <b>${money(-over)}</b>.`} Больше всех продал ${esc(top.name)}: ${money(top.sale)}. B2B: ${money(T.b2bSale)} из ${money(T.b2bPlan)}.</p>
    </div><div class="chart-wrap" id="regChart"></div></div></section>`;

  // 02 Менеджеры
  s += `<section class="block reveal">${head("02", "Менеджеры", "выручка против плана в деньгах · вал · бонус")}<div class="mgr rows">
    <div class="r head"><span class="label">Менеджер</span><span class="label">Выручка / план</span><span class="label">Вал · маржа</span><span class="label">Бонус</span><span class="label">Дог.</span><span class="label">Сверка с CRM</span><span></span></div>`;
  for (const m of R.managers) {
    const p = m.plan ? m.sale / m.plan : 0;
    const cls = !m.plan ? "ink" : p >= 1 ? "good" : p >= 0.8 ? "warn" : "bad";
    const valText = m.val !== null ? `${mln(m.val)} <span class="dim">млн · ${pct(m.margin)}</span>` : `<span class="dim">нет в файле</span>`;
    s += `<div class="r body" role="button" tabindex="0" aria-expanded="false" data-m="${esc(m.name)}">
      <div class="who"><span class="mono-av">${initials(m.name)}</span><div><div class="nm">${esc(m.name)}</div><div class="rl">${m.plan ? `план ${mln(m.plan)} млн` : "без плана"}</div></div></div>
      <div><div class="top"><span class="num">${mln(m.sale)}</span><span class="of">млн${m.plan ? ` · ${pct(p)}` : ""}</span></div>${bar(m.plan ? p * 100 / 3 : 0, cls, m.plan ? 100 / 3 : null)}</div>
      <div><span class="num">${valText}</span></div>
      <div><span class="num">${nf0.format(Math.round(m.bonus / 1000))}</span> <span class="dim">тыс</span></div>
      <div class="num">${m.contracts}</div>
      <div>${m.missCount ? `<span class="flag-miss">нет в CRM: ${m.missCount} на ${mln(m.missSum)} млн</span>` : m.contracts ? `<span class="flag-ok">всё отмечено</span>` : `<span class="flag-ok">—</span>`}</div>
      <span class="chev">${m.contracts ? "▾" : ""}</span>
    </div><div class="detail"><div><div class="deals">${dealRows(m.rows)}</div></div></div>`;
  }
  s += `</div><p class="note-src">Шкала — до 300% плана, засечка — 100%. Цвет: зелёный — план выполнен, охра — от 80%, красный — меньше.</p></section>`;

  // 03 Состав
  const g = Object.fromEntries(R.groups.map((x) => [x.g, x]));
  const ipG = g["ИП"] ?? { sale: 0, val: 0 };
  const ktG = g["КТ"] ?? { sale: 0, val: 0 };
  const ipValText = ipG.val !== null ? `${mln(ipG.val)} <small>млн · маржа ${pct(ipG.sale ? ipG.val / ipG.sale : 0)}</small>` : `<span class="dim">нет в файле</span>`;
  const ktValText = ktG.val !== null ? `${mln(ktG.val)} <small>млн · маржа ${pct(ktG.sale ? ktG.val / ktG.sale : 0)}</small>` : `<span class="dim">нет в файле</span>`;
  s += `<section class="block reveal">${head("03", "Что и как продаём", "доля в выручке · маржа")}<div class="two"><div>
    <div class="gsum"><div><span class="label">ИП · интерактивные панели</span><div class="v">${mln(ipG.sale)} ${ipValText}</div></div>
    <div><span class="label">КТ · компьютерная техника</span><div class="v">${mln(ktG.sale)} ${ktValText}</div></div></div>
    <div class="mix rows"><div class="r head"><span class="label">Товар</span><span class="label">Выручка</span><span class="label">Вал</span><span class="label">Маржа</span></div>
    ${R.mix.map((x) => `<div class="r"><span>${esc(x.kind)} <span class="dim">${x.group}</span></span><div>${bar(R.mix[0]?.sale ? x.sale / R.mix[0].sale * 100 : 0, "ink")}<span class="dim">${mln(x.sale)} млн · ${plural(Math.round(x.qty), ["шт", "шт", "шт"])}</span></div><span class="num">${x.val !== null ? mln(x.val) : "—"}</span><span class="num">${x.val !== null && x.sale ? pct(x.val / x.sale) : "—"}</span></div>`).join("")}</div></div>
    <div><div class="mix rows"><div class="r head"><span class="label">Канал</span><span class="label">Выручка</span><span class="label">Вал</span><span class="label">Маржа</span></div>
    ${R.channels.map((x) => `<div class="r"><span>${esc(x.name)} <span class="dim">${x.contracts}</span></span><div>${bar(R.channels[0]?.sale ? x.sale / R.channels[0].sale * 100 : 0, "ink")}<span class="dim">${mln(x.sale)} млн</span></div><span class="num">${x.val !== null ? mln(x.val) : "—"}</span><span class="num">${x.val !== null && x.sale ? pct(x.val / x.sale) : "—"}</span></div>`).join("")}</div></div>
  </div></section>`;

  // 04 Нет в CRM
  const missSum = R.missing.reduce((a, x) => a + x.sale, 0);
  s += `<section class="block reveal">${head("04", "В реестре есть, в CRM не «Выигран»", `${plural(R.missing.length, ["договор", "договора", "договоров"])} на ${money(missSum)}`)}
    <p class="lead">Эти договоры подписаны, но в Битрикс24 сделки нет или она не переведена в «Выигран». Пульт их не видит, поэтому выручка в CRM <b>на ${money(missSum)} меньше</b>, чем в реестре. Сверка по названию заказчика и сумме.</p>
    <div class="miss rows"><div class="r head"><span class="label">Дата</span><span class="label">Менеджер</span><span class="label">Заказчик</span><span class="label">Товар</span><span class="label">Сумма</span></div>
    ${R.missing.map((x) => `<div class="r"><span class="num">${ddmm(x.date)}</span><span class="nm">${esc(x.manager)}</span><span class="cust" title="${esc(x.customer)}">${esc(short(x.customer, 90))}</span><span>${esc(x.products.join(", "))}</span><span class="num">${mln(x.sale)} млн</span></div>`).join("")}</div></section>`;

  // 05 Все договоры
  s += `<section class="block reveal">${head("05", "Все договоры месяца", `${R.rows.length} строк реестра`)}
    <div class="chips" id="regChips"><button aria-pressed="true" data-f="">Все</button>${R.managers.filter((m) => m.contracts).map((m) => `<button aria-pressed="false" data-f="${esc(m.name)}">${esc(m.name)}</button>`).join("")}</div>
    <div class="all rows" id="regAll"></div><button class="btn more" id="regMore"></button></section>`;

  // Ошибка загрузки истории
  if (!R.history && R.historyError) {
    s += `<section class="block reveal" id="r-history-error">${head("06", "История реестра", "")}
      <p class="lead"><span class="flag-miss">${esc(R.historyError)}</span></p>
    </section>`;
  }

  // 06 История по месяцам
  if (R.historyError) {
    s += `<section class="block reveal"><div class="mismatches-box" style="margin-bottom:20px;"><span class="flag-miss">Внимание:</span> ${esc(R.historyError)}</div></section>`;
  }
  if (R.history?.failedFiles && R.history.failedFiles.length > 0) {
    s += `<section class="block reveal"><div class="mismatches-box" style="margin-bottom:20px;"><span class="flag-miss">Не удалось скачать с Диска (${R.history.failedFiles.length}):</span> ${R.history.failedFiles.map((f) => `<b>${esc(f.fileName)}</b> (${esc(f.reason)})`).join(", ")}</div></section>`;
  }

  if (R.history && R.history.months && R.history.months.length > 0) {
    const histMeta = R.history.cachedAt
      ? `с июля 2026 · ${R.history.months.length} месяцев · кэш от ${esc(formatAlmatyTimeStr(R.history.cachedAt))}`
      : `с июля 2026 · ${R.history.months.length} месяцев`;
    s += `<section class="block reveal" id="r-history">${head("06", "История по месяцам", histMeta)}
      <div class="hist rows">
        <div class="r head">
          <span class="label">Месяц</span>
          <span class="label">Файл</span>
          <span class="label">Выручка</span>
          <span class="label">Вал</span>
          <span class="label">Маржа</span>
          <span class="label">Дог.</span>
          <span class="label">План</span>
          <span class="label">% плана</span>
          <span></span>
        </div>`;

    for (const m of R.history.months) {
      const p = m.plan ? (m.sale / m.plan) : 0;
      const cls = !m.plan ? "ink" : p >= 1 ? "good" : p >= 0.8 ? "warn" : "bad";
      const valDisplay = m.hasVal && m.val !== null ? `${mln(m.val)} млн` : `<span class="dim">нет в файле</span>`;
      const marginDisplay = m.margin !== null ? pct(m.margin) : `<span class="dim">—</span>`;
      const planDisplay = m.plan ? `${mln(m.plan)} млн` : `<span class="dim">—</span>`;
      const planPctDisplay = m.planPct !== null ? `${pct(m.planPct / 100)}` : `<span class="dim">—</span>`;

      s += `<div class="r body" role="button" tabindex="0" aria-expanded="false" data-month="${esc(m.month)}">
        <div class="nm"><b>${esc(m.label || formatMonthLabel(m.month))}</b></div>
        <div class="dim" style="font-family:var(--mono); font-size:12px;">${esc(m.fileName)}</div>
        <div><span class="num">${mln(m.sale)}</span> <span class="dim">млн</span></div>
        <div><span class="num">${valDisplay}</span></div>
        <div><span class="num">${marginDisplay}</span></div>
        <div class="num">${m.contracts}</div>
        <div><span class="num">${planDisplay}</span></div>
        <div><span class="num ${cls}">${planPctDisplay}</span></div>
        <span class="chev">${m.byManager && m.byManager.length ? "▾" : ""}</span>
      </div>
      <div class="detail"><div>
        <div class="deals" style="padding: 10px 14px 18px 24px;">
          <div class="r head">
            <span class="label">Менеджер</span>
            <span class="label">Выручка</span>
            <span class="label">Вал</span>
            <span class="label">Маржа</span>
            <span class="label">Дог.</span>
            <span class="label">План</span>
            <span class="label">% плана</span>
          </div>
          ${(m.byManager || []).map((mgr) => {
            const mp = mgr.plan ? (mgr.sale / mgr.plan) : 0;
            const mcls = !mgr.plan ? "ink" : mp >= 1 ? "good" : mp >= 0.8 ? "warn" : "bad";
            const mVal = m.hasVal && mgr.val !== null ? `${mln(mgr.val)} млн` : `<span class="dim">нет в файле</span>`;
            const mMargin = mgr.margin !== null ? pct(mgr.margin) : `<span class="dim">—</span>`;
            return `<div class="r" style="grid-template-columns: minmax(140px, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) 70px 50px minmax(0, 1fr) 70px; padding: 6px 0;">
              <span class="nm">${esc(mgr.name)}</span>
              <span class="num">${mln(mgr.sale)} млн</span>
              <span class="num">${mVal}</span>
              <span class="num">${mMargin}</span>
              <span class="num">${mgr.contracts}</span>
              <span class="num">${mgr.plan ? `${mln(mgr.plan)} млн` : "—"}</span>
              <span class="num ${mcls}">${mgr.planPct !== null ? pct(mgr.planPct / 100) : "—"}</span>
            </div>`;
          }).join("")}
        </div>
      </div></div>`;
    }
    s += `</div><p class="note-src">Источник планов — таблица планов менеджеров из соответствующего файла реестра на конец месяца. В сентябре колонка вала в файле отсутствовала, маржа не вычисляется.</p></section>`;
  }

  // 07 Есть на портале, нет в реестре
  if (R.history?.portalMissing) {
    const pm = R.history.portalMissing;
    const missingContracts = pm.missingContracts || [];
    s += `<section class="block reveal" id="r-portal">${head("07", "Есть на портале, нет в реестре", "текущий и предыдущий месяц · сопоставление 1-к-1")}
      <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px;">
        ${Object.entries(pm.monthlyCounts || {}).map(([ym, cnt]) => `
          <div class="pill" style="padding:6px 12px; font-size:12px; border-radius:2px;">
            <b>${esc(formatMonthLabel(ym))}</b>: на портале <b>${cnt.total}</b> · сопоставлено <b>${cnt.matched ?? (cnt.total - (cnt.missing ?? 0))}</b>${cnt.matchedByCustomerSum ? ` (1-к-1: ${cnt.matched1to1 ?? ((cnt.matched ?? cnt.total) - cnt.matchedByCustomerSum)}, по сумме заказчика: ${cnt.matchedByCustomerSum})` : ""} · нет в реестре <b>${cnt.missing ?? (cnt.total - (cnt.matched ?? cnt.total))}</b>
          </div>
        `).join("")}
      </div>`;

    if (pm.error) {
      s += `<div class="mismatches-box" style="margin-top:12px;"><span class="flag-miss">Ошибка сверки с порталом:</span> ${esc(pm.error)}</div>`;
    } else if (missingContracts.length === 0) {
      s += `<p class="lead"><span class="flag-ok">✓ Все договоры портала за ${esc(formatMonthLabel(pm.currentMonth))} и ${esc(formatMonthLabel(pm.previousMonth))} найдены в реестре.</span></p>`;
    } else {
      const missPortalSum = missingContracts.reduce((sum, c) => sum + (c.amountWithVat || 0), 0);
      s += `<p class="lead">На портале zakup.gov.kz найдено <b>${missingContracts.length}</b> договоров текущего и прошлого месяцев, не сопоставленных с реестром, на общую сумму <b>${money(missPortalSum)}</b> (с НДС). Сопоставление 1-в-1 и по сумме заказчика (окно 14 дней, допуск до 3%).</p>
      <div id="portal-miss-list" class="portal-miss rows ${missingContracts.length > 10 ? 'collapsed' : ''}">
        <div class="r head">
          <span class="label">Дата</span>
          <span class="label">Поставщик</span>
          <span class="label">Заказчик</span>
          <span class="label">Сумма с НДС</span>
          <span class="label">Способ закупки</span>
          <span class="label">Договор</span>
        </div>
        ${missingContracts.map((c) => `
          <div class="r">
            <span class="num">${ddmm(c.signDate)}</span>
            <span class="nm">${esc(c.supplier)}</span>
            <span class="cust" title="${esc(c.customer)}">${esc(short(c.customer, 80))}</span>
            <span class="num">${fmt(c.amountWithVat)} ₸</span>
            <span class="dim" style="font-size:12px;">${esc(c.method)}</span>
            <span style="font-family:var(--mono); font-size:12px;">${esc(c.contractNumber)}</span>
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

  // 08 Дисциплина ведения реестра
  if (R.history?.discipline) {
    const disc = R.history.discipline;
    s += `<section class="block reveal" id="r-discipline">${head("08", "Дисциплина ведения реестра", "пропуски дней · задержка внесения · продажи ниже закупа · правки задним числом")}
      <div class="gsum" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
        <div>
          <span class="label">Пропущено рабочих дней</span>
          <div class="v">${disc.missingWorkingDays.length}<small> дней</small></div>
        </div>
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

    if (disc.missingWorkingDays.length > 0) {
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
            <span class="label">Дата</span>
            <span class="label">Менеджер</span>
            <span class="label">Заказчик</span>
            <span class="label">Товар</span>
            <span class="label">Продажа</span>
            <span class="label">Себестоимость</span>
            <span class="label">Убыток</span>
          </div>
          ${disc.salesBelowCost.map((r) => `
            <div class="r" style="grid-template-columns: 56px 110px minmax(0, 2fr) minmax(0, 2fr) 100px 100px 90px; font-size:13px; padding:8px 0;">
              <span class="num">${ddmm(r.date)}</span>
              <span class="nm">${esc(r.manager)}</span>
              <span class="cust" title="${esc(r.customer)}">${esc(short(r.customer, 60))}</span>
              <span>${esc(r.product)}</span>
              <span class="num">${fmt(r.sale)} ₸</span>
              <span class="num">${fmt(r.cost)} ₸</span>
              <span class="num" style="color:var(--bad); font-weight:500;">−${fmt(Math.abs(r.cost - r.sale))} ₸</span>
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
            <span class="label">Дата</span>
            <span class="label">Менеджер</span>
            <span class="label">Заказчик</span>
            <span class="label">Товар</span>
            <span class="label">Сумма</span>
            <span class="label">Тип</span>
            <span class="label">Что изменилось</span>
          </div>
          ${disc.retroChanges.map((rc) => {
            let changeDesc = esc(rc.note || "");
            if (rc.diff) {
              const parts = [];
              if (rc.diff.sale) parts.push(`Сумма: ${fmt(rc.diff.sale.before)} → ${fmt(rc.diff.sale.after)} ₸`);
              if (rc.diff.cost) parts.push(`Закуп: ${fmt(rc.diff.cost.before)} → ${fmt(rc.diff.cost.after)} ₸`);
              if (rc.diff.manager) parts.push(`Менеджер: ${esc(rc.diff.manager.before)} → ${esc(rc.diff.manager.after)}`);
              if (rc.diff.date) parts.push(`Дата: ${ddmm(rc.diff.date.before)} → ${ddmm(rc.diff.date.after)}`);
              if (parts.length > 0) changeDesc = parts.join("; ");
            }
            return `<div class="r" style="grid-template-columns: 56px 110px minmax(0, 2fr) minmax(0, 2fr) 90px 80px minmax(0, 2fr); font-size:13px; padding:8px 0;">
              <span class="num">${ddmm(rc.date)}</span>
              <span class="nm">${esc(rc.manager)}</span>
              <span class="cust" title="${esc(rc.customer)}">${esc(short(rc.customer, 60))}</span>
              <span>${esc(rc.product)}</span>
              <span class="num">${fmt(rc.sale)} ₸</span>
              <span><span class="pill ${rc.type === "deleted" ? "bad" : "warn"}">${rc.type === "deleted" ? "удалено" : "изменено"}</span></span>
              <span class="dim" style="font-size:12px;">${changeDesc}</span>
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

  // 09 Сверка с CRM за прошлые месяцы
  if (R.history?.months) {
    const pastMonths = R.history.months.filter((m) => m.month !== R.month);
    const unperformed = pastMonths.filter((m) => !m.reconciliationPerformed);
    const performed = pastMonths.filter((m) => m.reconciliationPerformed);
    const pastWithMissing = performed.filter((m) => m.missingCrm && m.missingCrm.length > 0);
    s += `<section class="block reveal" id="r-crm-history">${head("09", "Сверка с CRM за прошлые месяцы", "договоры реестра прошлых месяцев, не найденные в CRM со статусом «Выигран»")}`;

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
            <div class="miss rows">
              <div class="r head"><span class="label">Дата</span><span class="label">Менеджер</span><span class="label">Заказчик</span><span class="label">Товар</span><span class="label">Сумма</span></div>
              ${pm.missingCrm.map((x) => `
                <div class="r">
                  <span class="num">${ddmm(x.date)}</span>
                  <span class="nm">${esc(x.manager)}</span>
                  <span class="cust" title="${esc(x.customer)}">${esc(short(x.customer, 90))}</span>
                  <span>${esc(x.products.join(", "))}</span>
                  <span class="num">${mln(x.sale)} млн</span>
                </div>
              `).join("")}
            </div>
          </div>`;
        }
      }
    }
    s += `</section>`;
  }

  el.innerHTML = s;

  function dealRows(rows) {
    return `<div class="r head"><span class="label">Дата</span><span class="label">Заказчик</span><span class="label">Товар</span><span class="label">Шт</span><span class="label">Сумма</span><span class="label">Вал</span><span class="label">Маржа</span></div>` +
      rows.map((x) => `<div class="r"><span class="num">${ddmm(x.date)}</span><span class="cust" title="${esc(x.customer)}">${esc(short(x.customer, 80))}</span><span>${esc(x.product)} <span class="dim">${esc(x.type)}</span></span><span class="num">${fmt(x.qty)}</span><span class="num">${mln(x.sale)} млн</span><span class="num">${x.val !== null ? mln(x.val) : "—"}</span><span class="num">${x.val !== null && x.sale ? pct(x.val / x.sale) : "—"}</span></div>`).join("");
  }

  const SHORT_CH = {
    "Электронный магазин": "эл. магазин",
    "Запрос ценовых предложений": "ЗЦП",
    "Из одного источника": "из 1 источника",
    "Открытый конкурс": "конкурс",
    "B2B, вне портала": "B2B"
  };

  let regFilter = "", regShown = 12;
  function updateRegTable() {
    const rows = R.rows.filter((x) => !regFilter || x.manager === regFilter);
    const regAllEl = document.getElementById("regAll");
    if (!regAllEl) return;
    regAllEl.innerHTML = `<div class="r head"><span class="label">Дата</span><span class="label">Менеджер</span><span class="label">Заказчик</span><span class="label">Товар</span><span class="label">Шт</span><span class="label">Сумма</span><span class="label">Вал</span><span class="label">Маржа</span><span class="label">Канал</span></div>` +
      rows.slice(0, regShown).map((x) => `<div class="r"><span class="num">${ddmm(x.date)}</span><span class="nm">${esc(x.manager)}</span><span class="cust" title="${esc(x.customer)}">${esc(short(x.customer, 80))}</span><span>${esc(x.product)}</span><span class="num">${fmt(x.qty)}</span><span class="num">${mln(x.sale)} млн</span><span class="num">${x.val !== null ? mln(x.val) : "—"}</span><span class="num">${x.val !== null && x.sale ? pct(x.val / x.sale) : "—"}</span><span class="dim">${esc(SHORT_CH[x.channel] ?? x.channel)}</span></div>`).join("");
    const more = document.getElementById("regMore");
    if (more) {
      more.hidden = rows.length <= regShown;
      more.textContent = `Показать ещё ${Math.min(20, rows.length - regShown)}`;
    }
  }

  function renderRegChart() {
    const chartEl = document.getElementById("regChart");
    if (!chartEl || !R.daily.length) return;
    const W = innerWidth < 760 ? 420 : 760, H = innerWidth < 760 ? 280 : 330, L = 8, Rr = innerWidth < 760 ? 70 : 92, Tp = 18, B = 30;
    const iw = W - L - Rr, ih = H - Tp - B, days = 31, plan = R.total.plan, fact = R.total.sale;
    const yMax = Math.max(plan, fact) * 1.08, x = (d) => L + (d / days) * iw, y = (v) => Tp + ih - (v / yMax) * ih;
    let chSvg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Выручка отдела накопительно за месяц против плана">`;
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
    chSvg += `<text x="${x(lastDayNum) + 10}" y="${y(fact) + 4}" font-family="JetBrains Mono" font-size="12" font-weight="500" fill="#141414">${mln(fact)} млн</text>`;
    chSvg += `<text x="${x(days) + 8}" y="${y(plan) + 4}" font-family="JetBrains Mono" font-size="12" fill="#55534e">план ${mln(plan).split(",")[0]}</text>`;
    for (const dd of [1, 8, 15, 22, 29]) {
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
};
})();
