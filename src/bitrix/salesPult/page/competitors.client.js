// Client-side rendering for "Конкуренты ИП" and "Конкуренты КТ" tabs
(function () {
  "use strict";

  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  const MONTHS_S = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const NBSP = "\u00a0";
  const cleanQuotes = (s) => String(s ?? "").replace(/""+/g, '"');
  const esc = (s) => cleanQuotes(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmt = (n) => nf0.format(Math.round(n || 0));
  const mln = (n) => nf1.format((n || 0) / 1e6);
  const money = (n) => (n == null ? "—" : n >= 1e6 ? `${mln(n)}${NBSP}млн${NBSP}₸` : `${fmt(n)}${NBSP}₸`);
  const fmtPct1 = (n) => (n == null ? "—" : `${nf1.format(n)}%`);
  const ddmm = (d) => (d && d.length >= 10 ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "—");
  const plural = (n, f) => {
    const a = Math.abs(n) % 100, b = a % 10;
    return `${fmt(n)} ${a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b > 1 && b < 5 ? f[1] : f[2]}`;
  };
  const short = (s, n = 72) => {
    const t = cleanQuotes(s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const tooShort = (s, n = 44) =>
    short(cleanQuotes(s).replace(/^(?:Товарищество с ограниченной ответственностью|ТОО)\s*/i, "ТОО ").replace(/\s+/g, " "), n);

  const head = (idx, title, meta = "") => `<div class="block-head"><h2><span class="idx">${idx}</span>${title}</h2><span class="meta">${meta}</span></div>`;
  const link = (url, label) => {
    let ok = false;
    try { const u = new URL(url); ok = u.protocol === "https:"; } catch {}
    return ok ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
  };

  const validMonth = (m) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  const monthLabel = (m) => {
    if (m === "all") return "весь год";
    const idx = Number(m.slice(5, 7)) - 1;
    return `${MONTHS[idx] || m} ${m.slice(0, 4)}`;
  };

  window.__competitorsMonths = function (groupView) {
    if (!groupView) return [];
    const keys = [
      ...(groupView.months || []).map((m) => m.m),
      ...Object.keys(groupView.monthViews || {})
    ].filter(validMonth);
    return ["all", ...[...new Set(keys)].sort()];
  };

  window.__competitorsViewForPeriod = function (groupView, period) {
    if (!groupView) return null;
    const key = period === "all" || validMonth(period) ? period : "all";
    if (groupView.monthViews && Object.prototype.hasOwnProperty.call(groupView.monthViews, key)) {
      return groupView.monthViews[key];
    }
    if (groupView.monthViews && Object.prototype.hasOwnProperty.call(groupView.monthViews, "all")) {
      return groupView.monthViews.all;
    }
    return groupView;
  };

  const REASON_LABEL = {
    price: "цена",
    cond_discount: "усл. скидка",
    our_rejected: "отклонена заявка",
    tie_or_other: "прочее"
  };

  function priceCell(t) {
    if (!t || !t.n) return `<span class="dim">—</span>`;
    return `<span class="num">${fmt(t.med)}${NBSP}₸</span><span class="dim sub">${fmt(t.min)}–${fmt(t.max)} · n=${fmt(t.n)}</span>`;
  }

  const TOP_ROWS_LIMIT = 15;
  const expandedState = new WeakMap();

  window.__renderCompetitorsTab = function (key, COMP, el, selectedPeriod) {
    if (!el) return;
    const isIp = key === "competitors-ip" || key === "ИП";
    const base = isIp ? COMP?.ip : COMP?.kt;
    const V = window.__competitorsViewForPeriod(base, selectedPeriod);
    if (!V || !base) {
      el.innerHTML = `<section class="block"><p class="lead">${esc(COMP?.error || "Данные конкурентов ещё собираются.")}</p></section>`;
      return;
    }

    const activePeriod = window.__competitorsMonths(base).includes(selectedPeriod) ? selectedPeriod : "all";
    const scopeKey = `${key}:${activePeriod}`;
    let exp = expandedState.get(el);
    if (!exp || exp.scope !== scopeKey) {
      exp = { scope: scopeKey, competitors: false, h2h: false };
      expandedState.set(el, exp);
    }
    const title = isIp ? "интерактивных панелей и комплектов" : "компьютерной техники";
    const S = V.summary;
    const staleWarning = COMP?.stale && COMP?.updatedAt
      ? `<div class="note-warn">Данные конкурентов не обновлены с ${ddmm(COMP.updatedAt)}</div>`
      : "";

    // 01 Итоги + помесячный график
    const months = base.months || [];
    const maxWon = Math.max(1, ...months.map((m) => m.wonSum || 0), ...months.map((m) => m.lots || 0));
    const maxLots = Math.max(1, ...months.map((m) => m.lots || 0));
    const useSumBars = months.some((m) => m.wonSum > 0);
    const barMax = useSumBars ? Math.max(1, ...months.map((m) => m.wonSum)) : maxLots;

    const chartHtml = months.length
      ? `<div class="comp-chart" style="--m-count:${months.length}">
          <div class="months">${months.map((m) => {
            const val = useSumBars ? m.wonSum : m.lots;
            const hPct = Math.max(2, (val / barMax) * 100);
            const ourPct = val > 0 && useSumBars ? Math.min(100, (m.ourWonSum / val) * 100) : 0;
            const lab = useSumBars ? fmt(m.wonSum / 1e6) : fmt(m.lots);
            return `<div class="col" role="button" tabindex="0" data-m="${esc(m.m)}" aria-current="${String(m.m === activePeriod)}" title="${esc(monthLabel(m.m))}: ${fmt(m.lots)} лотов, побед на ${money(m.wonSum)}"><div class="tot" style="height:${hPct.toFixed(1)}%"><span class="lab">${lab}</span><div class="our" style="height:${ourPct.toFixed(1)}%"></div></div></div>`;
          }).join("")}</div>
          <div class="mlabels">${months.map((m) => {
            const mIdx = Number(m.m.slice(5)) - 1;
            const wonShare = m.lots ? Math.round((m.wonLots / m.lots) * 100) : 0;
            return `<span role="button" tabindex="0" data-m="${esc(m.m)}" aria-current="${String(m.m === activePeriod)}"><span class="m-name">${MONTHS_S[mIdx] || m.m}</span><span class="m-pct">${fmt(m.lots)}${NBSP}л.<br>${wonShare}%</span></span>`;
          }).join("")}</div>
        </div>`
      : "";

    let html = `${staleWarning}<section class="block reveal in">
      ${head("01", `Итоги открытых конкурсов · ${title} · ${esc(monthLabel(activePeriod))}`, "способ «Открытый конкурс» · без НДС · уникальные лоты по последней версии")}
      <div class="hero comp-hero">
        <div>
          <span class="label">Состоялось лотов</span>
          <div class="hero-num"><span class="big">${fmt(S.wonLots)}</span><span class="of" data-comp-lots="${fmt(S.lotsTotal)}">/ ${fmt(S.lotsTotal)}</span></div>
          <div class="hero-amt">${money(S.wonSum)} <span class="muted">сумма побед${S.ourWinsCount ? ` · наши (F3 + партнёры): ${fmt(S.ourWinsCount)} на ${money(S.ourWinsSum)}` : ""}</span></div>
          <div class="readout comp-readout">
            <div><span class="label">Не состоялось / отмена</span><div class="v">${fmt(S.failedLots)}<small> / ${fmt(S.cancelledLots)} отм.</small></div></div>
            <div><span class="label">Заявок / отклонено</span><div class="v">${fmt(S.bidsTotal)}<small> · ${fmtPct1(S.rejectedSharePct)} откл. (${fmt(S.bidsRejected)})</small></div></div>
            <div><span class="label">Скидка от плана</span><div class="v">${fmtPct1(S.avgDiscountPct)}<small>${S.medianDiscountPct != null ? ` · мед. ${fmtPct1(S.medianDiscountPct)}` : ""}</small></div></div>
          </div>
        </div>
        <div>${chartHtml}</div>
      </div>
    </section>`;

    // 02 Конкуренты (первые 15 + наши компании всегда видны; остальные под кнопкой «Показать всех»)
    const indexedComps = V.competitors.map((c, idx) => ({ c, idx }));
    const collapsedComps = indexedComps.filter(({ c, idx }) => idx < TOP_ROWS_LIMIT || c.us);
    const visibleComps = exp.competitors ? indexedComps : collapsedComps;
    const hasMoreComps = indexedComps.length > collapsedComps.length;

    const compRowsHtml = visibleComps.map(({ c, idx }) => {
      const lotsHtml = c.lotList.map((l) => {
        const outcomeTag = l.isWinner
          ? `<span class="tag good">Победа</span>`
          : l.isSecond
          ? `<span class="tag">2-е место</span>`
          : l.admittedStatus === "Отклонен"
          ? `<span class="tag warn">Отклонён</span>`
          : `<span class="tag">Допущен</span>`;
        return `<div class="r comp-lot-row${c.us ? " us" : ""}">
          <span class="num">${ddmm(l.date)}</span>
          <span class="cust" title="${esc(l.customerName)}">${link(l.url, l.lotNumber)} · ${esc(short(l.customerName, 70))}<span class="dim sub">${esc(l.kind)} · ${esc(l.status)}${l.rejectionShort ? ` · Причина: ${esc(l.rejectionShort)}` : ""}</span></span>
          <span>${outcomeTag}</span>
          <span class="num">${l.bidTotalPrice != null ? money(l.bidTotalPrice) : "—"}<span class="dim sub">${l.discountPct != null ? `скидка ${fmtPct1(l.discountPct)}` : ""}${l.otpKtpPct > 0 ? ` · ОТП ${fmtPct1(l.otpKtpPct)}` : ""}</span></span>
        </div>`;
      }).join("");
      const moreLots = c.totalLotsInList > c.lotList.length
        ? `<p class="more">и ещё ${plural(c.totalLotsInList - c.lotList.length, ["лот", "лота", "лотов"])}</p>`
        : "";
      const nameBlock = `<span class="nm" title="${esc(c.name)}">${esc(tooShort(c.name, 42))}${c.us ? ' <span class="tag good">мы</span>' : ""}<span class="dim sub">БИН ${esc(c.bin)}</span></span>`;
      const summaryRow = `<span class="rk">${idx + 1}</span>${nameBlock}<span class="num" data-l="Заявок">${fmt(c.bids)}</span><span class="num" data-l="Доп. / Откл.">${fmt(c.admitted)} / ${fmt(c.rejected)}</span><span class="num" data-l="Побед (2-х)">${fmt(c.wins)}${c.secondPlaces ? ` (${fmt(c.secondPlaces)})` : ""}</span><span class="num" data-l="Доля побед">${fmtPct1(c.winRateAdmittedPct)}</span><span class="num" data-l="Сумма побед">${money(c.wonSum)}</span><span class="num" data-l="Мед. скидка">${fmtPct1(c.medianDiscountPct)}</span><span class="num" data-l="Усл. скидка">${fmtPct1(c.meanCondDiscountPct)}</span><span class="num" data-l="ОТП/КТП">${fmt(c.otpKtpCount)}</span>`;
      return `<details class="cust-d"><summary class="r${c.us ? " us" : ""}">${summaryRow}</summary><div class="cust-list rows">${lotsHtml}${moreLots}</div></details>`;
    }).join("");

    const compMoreBtn = hasMoreComps
      ? `<div class="comp-more-wrap"><button type="button" class="btn-toggle-portal comp-more-btn" data-comp-more="competitors">${exp.competitors ? "Свернуть до топ-15" : `Показать всех (${fmt(V.competitors.length)})`}</button></div>`
      : "";

    html += `<section class="block reveal in">
      ${head("02", "Конкуренты", `${fmt(V.competitorsTotal)} участников · показаны ${fmt(visibleComps.length)} · строка раскрывает список лотов`)}
      <div class="comp-table rows">
        <div class="r head"><span></span><span class="label">Участник / БИН</span><span class="label">Заявок</span><span class="label">Доп./Откл.</span><span class="label">Побед (2-х)</span><span class="label">От допусков</span><span class="label">Сумма побед</span><span class="label">Мед. скидка</span><span class="label">Усл. скидка</span><span class="label">ОТП/КТП</span></div>
        ${compRowsHtml || '<p class="muted">Участников за этот период нет</p>'}
      </div>
      ${compMoreBtn}
    </section>`;

    // 03 Где мы встречались (первые 15 + кнопка «Показать всех»)
    const visibleH2h = exp.h2h ? V.headToHead : V.headToHead.slice(0, TOP_ROWS_LIMIT);
    const hasMoreH2h = V.headToHead.length > TOP_ROWS_LIMIT;

    const h2hHtml = visibleH2h.map((r, idx) => {
      const lostCauses = [
        r.lostByPrice ? `цена: ${r.lostByPrice}` : "",
        r.lostByCondDiscount ? `усл. скидка: ${r.lostByCondDiscount}` : "",
        r.lostByOurRejected ? `наше откл.: ${r.lostByOurRejected}` : ""
      ].filter(Boolean).join(", ");
      const wonCauses = [
        r.wonByPrice ? `цена: ${r.wonByPrice}` : "",
        r.wonByCondDiscount ? `усл. скидка: ${r.wonByCondDiscount}` : "",
        r.wonByRivalRejected ? `откл. соперника: ${r.wonByRivalRejected}` : ""
      ].filter(Boolean).join(", ");
      const lotsList = r.lots.map((l) => {
        const resLabel = l.rivalWon
          ? `<span class="tag warn">Победил соперник (${REASON_LABEL[l.reason] || "итог"})</span>`
          : l.weWon
          ? `<span class="tag good">Победили мы (${l.reason === "our_rejected" ? "соперник отклонён" : REASON_LABEL[l.reason] || "итог"})</span>`
          : `<span class="tag">${esc(l.status)}</span>`;
        return `<div class="r comp-h2h-lot">
          <span class="num">${ddmm(l.date)}</span>
          <span class="cust">${link(l.url, l.lotNumber)} · ${esc(short(l.customerName, 64))}<span class="dim sub">${esc(l.ourCompany)}: ${l.ourPrice != null ? money(l.ourPrice) : l.ourAdmitted}${l.ourCondDisc != null ? ` (${fmtPct1(l.ourCondDisc)})` : ""} · Соперник: ${l.rivalPrice != null ? money(l.rivalPrice) : l.rivalAdmitted}${l.rivalCondDisc != null ? ` (${fmtPct1(l.rivalCondDisc)})` : ""}</span></span>
          <span>${resLabel}</span>
        </div>`;
      }).join("");
      const summary = `<span class="rk">${idx + 1}</span>
        <span class="nm" title="${esc(r.name)}">${esc(tooShort(r.name, 44))}<span class="dim sub">БИН ${esc(r.bin)}</span></span>
        <span class="num" data-l="Общих лотов">${fmt(r.sharedLots)}</span>
        <span class="num bad" data-l="Обошёл нас">${fmt(r.rivalWonOverUs)}${lostCauses ? `<span class="dim sub">${esc(lostCauses)}</span>` : ""}</span>
        <span class="num good" data-l="Мы обошли">${fmt(r.weWonOverRival)}${wonCauses ? `<span class="dim sub">${esc(wonCauses)}</span>` : ""}</span>
        <span class="num" data-l="Прочее / не сост.">${fmt(r.bothLost)}</span>`;
      return `<details class="cust-d"><summary class="r">${summary}</summary><div class="cust-list rows">${lotsList}</div></details>`;
    }).join("");

    const h2hMoreBtn = hasMoreH2h
      ? `<div class="comp-more-wrap"><button type="button" class="btn-toggle-portal comp-more-btn" data-comp-more="h2h">${exp.h2h ? "Свернуть до топ-15" : `Показать всех (${fmt(V.headToHead.length)})`}</button></div>`
      : "";

    html += `<section class="block reveal in">
      ${head("03", "Где мы встречались", `лоты с участием F3 и партнёров (${fmt(V.headToHead.length)} соперников) · показаны ${fmt(visibleH2h.length)} · причина исхода`)}
      <div class="comp-h2h rows">
        <div class="r head"><span></span><span class="label">Соперник</span><span class="label">Общих лотов</span><span class="label">Обошёл нас</span><span class="label">Мы обошли</span><span class="label">Прочее</span></div>
        ${h2hHtml || '<p class="muted">Совместных лотов за этот период нет</p>'}
      </div>
      ${h2hMoreBtn}
    </section>`;

    // 04 Наши отклонения
    const rejHtml = V.ourRejections.map((r) => {
      const hasEqualOrLower = r.status === "Закупка состоялась" && r.ourPrice != null && r.winnerPrice != null && r.winnerPrice > 0;
      const pctStr = r.cheaperByPct != null ? nf1.format(r.cheaperByPct) : "";
      const isEqualPrice = hasEqualOrLower && ((r.cheaperThanWinner && (r.cheaperByPct == null || r.cheaperByPct < 0.05)) || Math.abs(r.ourPrice - r.winnerPrice) <= Math.max(1, r.winnerPrice * 0.0005));
      const badge = r.cheaperThanWinner && r.cheaperByPct != null && r.cheaperByPct >= 0.05
        ? `<span class="tag bad">наша цена ниже победителя на ${pctStr}%</span>`
        : isEqualPrice
        ? `<span class="tag warn">равна цене победителя</span>`
        : `<span class="tag">${esc(r.status)}</span>`;
      return `<div class="r comp-rej-row">
        <span class="num">${ddmm(r.date)}</span>
        <span class="cust">${link(r.url, r.lotNumber)} · <b>${esc(r.ourCompany)}</b> · ${esc(short(r.customerName, 60))}<span class="dim sub">${esc(r.kind)} · Причина: ${esc(r.rejectionShort)}${r.rejectionDetail ? ` — ${esc(short(r.rejectionDetail, 160))}` : ""}</span></span>
        <span>${badge}</span>
        <span class="num">${r.ourPrice != null ? money(r.ourPrice) : "—"}<span class="dim sub">${r.winnerPrice != null ? `победитель ${money(r.winnerPrice)}` : ""}</span></span>
      </div>`;
    }).join("");

    html += `<section class="block reveal in">
      ${head("04", "Наши отклонения", `${fmt(V.ourRejections.length)} заявок · ниже цены победителя: ${fmt(V.ourRejectionsCheaperCount)}`)}
      <div class="comp-rej rows">
        <div class="r head"><span class="label">Дата</span><span class="label">Лот, компания и причина отклонения</span><span class="label">Итог</span><span class="label">Наша цена / Победитель</span></div>
        ${rejHtml || '<p class="muted">Отклонённых заявок наших компаний нет</p>'}
      </div>
    </section>`;

    // 05 Цены
    const renderPriceRow = (row) => `<div class="r">
      <span class="nm">${esc(row.label)} <span class="dim">${plural(row.lotsCount, ["лот", "лота", "лотов"])}</span></span>
      <span data-l="План">${priceCell(row.plan)}</span>
      <span data-l="Конкуренты (допущ.)">${priceCell(row.compAdmitted)}</span>
      <span data-l="Конкуренты (победы)">${priceCell(row.compWinner)}</span>
      <span data-l="Наши (допущ.)">${priceCell(row.ourAdmitted)}</span>
      <span data-l="Наши (победы)">${priceCell(row.ourWinner)}</span>
    </div>`;

    const pricesRowsHtml = V.prices.rows.map(renderPriceRow).join("") + (V.prices.kitsRow ? renderPriceRow(V.prices.kitsRow) : "");

    html += `<section class="block reveal in">
      ${head("05", "Цены за единицу", `без НДС · однотоварные лоты без комплектов${V.prices.kitsRow ? " · комплекты отдельно" : ""}${V.prices.excludedTypoCount ? ` · отсечено опечаток: ${fmt(V.prices.excludedTypoCount)}` : ""}`)}
      <div class="comp-prices rows">
        <div class="r head"><span class="label">${isIp ? "Диагональ / группа" : "Вид техники"}</span><span class="label">План</span><span class="label">Конкуренты допущ.</span><span class="label">Конкуренты победы</span><span class="label">Наши допущ.</span><span class="label">Наши победы</span></div>
        ${pricesRowsHtml || '<p class="muted">Нет однотоварных лотов для расчёта цен</p>'}
      </div>
    </section>`;

    // 06 Шаблоны ТС
    const tplHtml = V.specTemplates.map((tpl) => {
      const winnersHtml = tpl.winners.length
        ? `<div class="comp-tpl-winners rows">
            <div class="r head"><span class="label">Победитель</span><span class="label">Побед</span><span class="label">Доля</span><span class="label">Сумма</span></div>
            ${tpl.winners.slice(0, 12).map((w) => `<div class="r${w.ourCompany ? " us" : ""}">
              <span class="nm">${esc(tooShort(w.name, 46))}${w.ourCompany ? ' <span class="tag good">мы</span>' : ""} <span class="dim">БИН ${esc(w.bin)}</span></span>
              <span class="num">${fmt(w.wins)}</span>
              <span class="num">${fmtPct1(w.sharePct)}</span>
              <span class="num">${money(w.wonSum)}</span>
            </div>`).join("")}
          </div>`
        : `<p class="muted">Состоявшихся лотов с этим шаблоном пока нет.</p>`;

      const tplLotsHtml = tpl.lots.map((l) => `<div class="r comp-tpl-lot">
        <span class="num">${ddmm(l.date)}</span>
        <span class="cust">${link(l.annoUrl, l.lotNumber)} · ${esc(short(l.customerName, 64))}<span class="dim sub">${esc(l.kind)} · ${esc(l.status)} · ${l.strength === "strong" ? "сильное" : "частичное"} (${fmt(l.sharePct)}%)${l.winnerName ? ` · Победитель: ${esc(tooShort(l.winnerName, 36))}` : ""}</span></span>
        <span>${l.techspecUrl ? link(l.techspecUrl, "Файл ТС ↗") : '<span class="dim">нет ссылки</span>'}</span>
        <span class="num">${l.plannedSum != null ? money(l.plannedSum) : "—"}</span>
      </div>`).join("");

      return `<div class="comp-tpl-card">
        <div class="comp-tpl-head">
          <div>
            <h3>${esc(tpl.templateName)}</h3>
            ${tpl.note ? `<p class="dim">${esc(tpl.note)}</p>` : ""}
          </div>
          <div class="readout comp-tpl-readout">
            <div><span class="label">Лотов</span><div class="v">${fmt(tpl.totalLots)}<small> (${fmt(tpl.strongLots)} сильн. / ${fmt(tpl.partialLots)} част.)</small></div></div>
            <div><span class="label">Заказчиков</span><div class="v">${fmt(tpl.uniqueCustomers)}</div></div>
            <div><span class="label">Допущено заявок</span><div class="v">${tpl.admittedRatePct != null ? fmtPct1(tpl.admittedRatePct) : "—"}<small>${tpl.bidsTotal ? ` (${fmt(tpl.bidsAdmitted)} из ${fmt(tpl.bidsTotal)})` : ""}</small></div></div>
          </div>
        </div>
        ${winnersHtml}
        ${tpl.lots.length ? `<details class="cust-d comp-tpl-lots-d"><summary class="old-tasks-sum">Список лотов (${fmt(tpl.lots.length)})</summary><div class="cust-list rows">${tplLotsHtml}</div></details>` : ""}
      </div>`;
    }).join("");

    html += `<section class="block reveal in">
      ${head("06", "Шаблоны ТС", "одинаковые фрагменты в техспецификациях заказчиков")}
      ${tplHtml || '<p class="muted">Шаблоны ТС не настроены</p>'}
    </section>`;

    el.innerHTML = html;
    el.querySelectorAll("[data-comp-more]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-comp-more");
        if (kind === "competitors" || kind === "h2h") {
          exp[kind] = !exp[kind];
          window.__renderCompetitorsTab(key, COMP, el, selectedPeriod);
        }
      });
    });
  };
})();
