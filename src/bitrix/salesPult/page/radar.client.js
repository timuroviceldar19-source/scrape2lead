// Client-side rendering for "Радар" tab
(function () {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmt = (n) => nf0.format(Math.round(n || 0));
  const mln = (n) => nf1.format((n || 0) / 1e6);
  const money = (n) => `${mln(n)} млн ₸`;
  const link = (url, text) => url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text);

  function shortCustomerName(name) {
    if (!name) return "";
    let s = String(name).trim();
    s = s.replace(/коммунальное\s+государственное\s+казенное\s+предприятие/gi, "КГКП");
    s = s.replace(/коммунальное\s+государственное\s+учреждение/gi, "КГУ");
    s = s.replace(/государственное\s+коммунальное\s+казенное\s+предприятие/gi, "ГККП");
    s = s.replace(/государственное\s+коммунальное\s+предприятие/gi, "ГКП");
    s = s.replace(/товарищество\s+с\s+ограниченной\s+ответственностью/gi, "ТОО");
    s = s.replace(/некоммерческое\s+акционерное\s+общество/gi, "НАО");
    s = s.replace(/акционерное\s+общество/gi, "АО");
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  const radarStates = new Map();

  function getState(tab) {
    let st = radarStates.get(tab);
    if (!st) {
      st = {
        managerId: "",
        manualFilter: false,
        lastSyncedMe: "",
        method: "",
        timeFilter: "all",
        searchQuery: "",
        missedOpen: false,
        order: "deadline",
        expandedCol: { submitToday: false, discussion: false, secondChance: false }
      };
      radarStates.set(tab, st);
    }
    return st;
  }

  // Срок приёма — время Алматы (UTC+5), те же правила, что parseAlmatyTimestamp в radar/aggregate.ts:
  // «YYYY-MM-DD HH:mm[:ss]»; дата без времени — конец дня 23:59:59; строка со смещением — как есть.
  const ALMATY_OFFSET_MS = 5 * 3_600_000;
  function parseAlmatyEnd(value) {
    const s = String(value || "").trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
      const ms = Date.parse(s);
      return Number.isFinite(ms) ? ms : null;
    }
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2})(?::(\d{2}))?)?/.exec(s);
    if (!m) return null;
    const ms = Date.parse(`${m[1]}T${m[2] ? `${m[2]}:${m[3] || "00"}` : "23:59:59"}+05:00`);
    return Number.isFinite(ms) ? ms : null;
  }

  /** Карточке с понятным сроком нужен живой таймер: срок кладётся в data-end и пересчитывается от часов браузера. */
  const liveEnd = (card) => card.column !== "secondChance" && card.column !== "missed" && parseAlmatyEnd(card.endAt) !== null ? card.endAt : "";

  // Пороги прежние: меньше 4 ч — красный, меньше 48 ч — жёлтый. Минуты округляются вниз: таймер не обещает лишнего.
  function badgeState(msLeft, endAt) {
    if (msLeft == null) return endAt ? { cls: "", text: `до ${endAt.slice(5)}` } : null;
    if (msLeft <= 0) return { cls: "bad", text: "приём окончен" };
    const h = msLeft / 3_600_000;
    const minutes = Math.floor(msLeft / 60_000);
    const hoursMinutes = `осталось ${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}`;
    if (h < 1) return { cls: "bad", text: `осталось ${Math.max(1, minutes)} мин` };
    if (h < 4) return { cls: "bad", text: hoursMinutes };
    if (h < 24) return { cls: "warn", text: hoursMinutes };
    if (h <= 48) return { cls: "warn", text: `осталось ${Math.floor(h)} ч` };
    return { cls: "", text: `до ${endAt ? endAt.slice(5) : "—"}` };
  }

  function msLeftOf(card, nowMs) {
    const endMs = parseAlmatyEnd(card.endAt);
    if (endMs !== null) return endMs - nowMs;
    return card.hoursLeft == null ? null : card.hoursLeft * 3_600_000;
  }

  function formatTimeBadge(card, nowMs = Date.now()) {
    if (card.column === "secondChance") {
      return `<span class="radar-badge dim">не состоялась</span>`;
    }
    const st = badgeState(msLeftOf(card, nowMs), card.endAt);
    if (!st) return "";
    const live = liveEnd(card) ? ` data-radar-timer role="timer"` : "";
    return `<span class="radar-badge${st.cls ? ` ${st.cls}` : ""}"${live}>${esc(st.text)}</span>`;
  }

  // Один минутный таймер на страницу: обновляет только текст и цвет бейджей, разметку, поиск и фокус не трогает.
  // Карточка, у которой приём закрылся уже в браузере, остаётся на месте с бейджем «приём окончен».
  let liveTimer = null;
  function refreshLiveBadges() {
    const now = Date.now();
    document.querySelectorAll(".radar-card[data-end]").forEach((el) => {
      const badge = el.querySelector("[data-radar-timer]");
      const st = badge && badgeState(msLeftOf({ endAt: el.dataset.end, hoursLeft: null }, now), el.dataset.end);
      if (!st) return;
      const cls = `radar-badge${st.cls ? ` ${st.cls}` : ""}`;
      if (badge.className !== cls) badge.className = cls;
      if (badge.textContent !== st.text) badge.textContent = st.text;
    });
  }
  function ensureLiveTimer() {
    if (liveTimer !== null) return;
    liveTimer = setInterval(refreshLiveBadges, 60_000);
    // Фоновая вкладка получает таймеры с опозданием: при возвращении обновляем сразу.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLiveBadges(); });
  }

  // Вердикт и подсказки считает сервер (bid/assess.ts), здесь только разметка.
  const bidHtml = (card) => window.__bidHtml ? window.__bidHtml(card.bid) : { verdictHtml: "", customerHtml: "", priceHtml: "" };

  function renderCard(card) {
    const hints = bidHtml(card);

    const dealLabel = `Сделка #${card.id} ↗`;
    const lotLink = card.lotUrl || card.announceUrl;
    const lotLabel = card.sourceType === "plan" ? "План ЭГЗ ↗" : "Лот ЭГЗ ↗";
    const end = liveEnd(card);

    return `
      <div class="radar-card" data-deal-id="${esc(card.id)}"${end ? ` data-end="${esc(end)}"` : ""}>
        <div class="radar-card-head">
          <div class="radar-card-item">
            <strong>${esc(card.itemName)}</strong>${card.qty ? ` <span class="dim">· ${fmt(card.qty)} шт.</span>` : ""}
            <div class="radar-card-meta">${hints.verdictHtml}<span class="tag method">${esc(card.method)}</span>${card.kind ? ` <span class="dim">${esc(card.kind)}</span>` : ""}</div>
          </div>
          <div class="radar-card-right">
            ${formatTimeBadge(card)}
            <div class="radar-card-sum num">${money(card.sum)}</div>
          </div>
        </div>
        ${hints.priceHtml}
        ${window.__stockHint ? window.__stockHint(card) : ""}
        <div class="radar-card-cust" title="${esc(card.customerName)}">
          <span class="cust-name">${esc(shortCustomerName(card.customerName))}</span>
          ${card.customerBin ? `<span class="dim sub">${esc(card.customerBin)}</span>` : ""}
          ${hints.customerHtml}
        </div>
        <div class="radar-card-foot">
          <span class="radar-mgr">${esc(card.managerName)}</span>
          <div class="radar-links">
            ${card.dealUrl ? link(card.dealUrl, dealLabel) : ""}
            ${lotLink ? ` · ${link(lotLink, lotLabel)}` : ""}
          </div>
        </div>
      </div>
    `;
  }

  const lotWord = (n) => {
    const a = Math.abs(n) % 100, b = a % 10;
    return a > 10 && a < 20 ? "лотов" : b === 1 ? "лот" : b > 1 && b < 5 ? "лота" : "лотов";
  };
  const dealWord = (n) => {
    const a = Math.abs(n) % 100, b = a % 10;
    return a > 10 && a < 20 ? "закупок" : b === 1 ? "закупка" : b > 1 && b < 5 ? "закупки" : "закупок";
  };

  function renderColumn(colKey, title, idx, cards, state) {
    const limit = state.expandedCol[colKey] ? cards.length : 6;
    const visibleCards = cards.slice(0, limit);
    const sum = cards.reduce((acc, c) => acc + (c.sum || 0), 0);
    const countLabel = colKey === "secondChance" ? dealWord(cards.length) : lotWord(cards.length);

    return `
      <div class="radar-col" data-col="${colKey}">
        <div class="radar-col-head">
          <h3><span class="idx">${idx}</span>${title}</h3>
          <span class="radar-col-meta">${fmt(cards.length)} ${countLabel} · <span class="num">${money(sum)}</span></span>
        </div>
        <div class="radar-card-list">
          ${visibleCards.length > 0
            ? visibleCards.map(c => renderCard(c)).join("")
            : `<p class="muted">Нет закупок</p>`}
        </div>
        ${cards.length > 6 && !state.expandedCol[colKey]
          ? `<button type="button" class="btn radar-col-more" data-radar-expand="${colKey}">Показать все (${fmt(cards.length)}) →</button>`
          : ""}
      </div>
    `;
  }

  /** Когда закрылся приём, по Алматы: «20.11 18:00»; для даты без времени — только «20.11». */
  function formatClosedAt(endAt) {
    const ms = parseAlmatyEnd(endAt);
    if (ms === null) return "";
    const iso = new Date(ms + ALMATY_OFFSET_MS).toISOString();
    const day = `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
    return /\d{2}:\d{2}/.test(String(endAt).slice(10)) ? `${day} ${iso.slice(11, 16)}` : day;
  }

  function renderMissedRow(card) {
    const lotLink = card.lotUrl || card.announceUrl;
    const closedAt = formatClosedAt(card.endAt);
    return `
      <li class="radar-missed-row" data-deal-id="${esc(card.id)}">
        <div class="radar-missed-main">
          <strong>${esc(card.itemName)}</strong>${card.qty ? ` <span class="dim">· ${fmt(card.qty)} шт.</span>` : ""}
          <span class="radar-missed-cust" title="${esc(card.customerName)}">${esc(shortCustomerName(card.customerName))}</span>
        </div>
        <div class="radar-missed-sum num">${money(card.sum)}</div>
        <div class="radar-missed-foot">
          ${closedAt ? `<span class="radar-badge bad">приём закрыт ${esc(closedAt)}</span>` : ""}
          <span class="radar-mgr">${esc(card.managerName)}</span>
          <span class="radar-links">${card.dealUrl ? link(card.dealUrl, `Сделка #${card.id} ↗`) : ""}${lotLink ? `${card.dealUrl ? " · " : ""}${link(lotLink, "Лот ЭГЗ ↗")}` : ""}</span>
        </div>
      </li>
    `;
  }

  // Пропущенные сроки за 7 дней: срок подачи прошёл, а сделка так и стоит в «Новой». Без таких лотов блока нет.
  function renderMissed(baseCount, cards, open) {
    if (!baseCount) return "";
    const sum = cards.reduce((acc, c) => acc + (c.sum || 0), 0);
    return `
      <details class="radar-missed"${open ? " open" : ""}>
        <summary>
          <span class="radar-missed-title">Пропущенные сроки за 7 дней</span>
          <span class="radar-missed-meta">${fmt(cards.length)} ${lotWord(cards.length)} · <span class="num">${money(sum)}</span></span>
        </summary>
        <p class="radar-missed-note">Приём заявок закончился, а сделка осталась в стадии «Новая». Свежие сверху.</p>
        ${cards.length
          ? `<ul class="radar-missed-list" role="list">${cards.map(renderMissedRow).join("")}</ul>`
          : `<p class="muted">Нет закупок</p>`}
      </details>
    `;
  }

  window.__renderRadarTab = function (tab, radarView, container) {
    if (!container) return;
    const groupKey = tab === "radar-kt" ? "kt" : "ip";
    const group = radarView ? radarView[groupKey] : null;

    if (!group) {
      container.innerHTML = `<div class="block"><p class="muted">Данные Радара не загружены</p></div>`;
      return;
    }

    const state = getState(tab);
    const payload = typeof PAYLOAD === "undefined" ? null : PAYLOAD;
    // Вид менеджера: в радаре уже только его карточки, фильтр «Менеджер» не нужен.
    const viewer = payload && payload.viewer && payload.viewer.kind === "manager" ? payload.viewer : null;
    const missedAll = group.missed || [];

    if (viewer) {
      state.managerId = "";
    } else {
      // Sync with global "Я — …" (localStorage "pult-me")
      let me = "";
      try { me = localStorage.getItem("pult-me") || ""; } catch (e) {}
      if (state.lastSyncedMe !== me) {
        state.lastSyncedMe = me;
        state.manualFilter = false;
        state.managerId = me;
      }
    }

    // Порядок «по ценности» (сумма × вес вердикта) — только когда вердикты вынесены: у вида менеджера их нет.
    const hasVerdicts = [...group.submitToday, ...group.discussion, ...group.secondChance]
      .some(c => c.bid && c.bid.verdict && c.bid.verdict !== "unknown");
    if (!hasVerdicts) state.order = "deadline";
    const ordered = (cards) => state.order === "value"
      ? cards.map((c, i) => [c, i]).sort((a, b) => ((b[0].bid && b[0].bid.value) || 0) - ((a[0].bid && a[0].bid.value) || 0) || a[1] - b[1]).map(x => x[0])
      : cards;

    // Available managers & methods (over all cards in group)
    const allCards = [...group.submitToday, ...group.discussion, ...group.secondChance, ...missedAll];
    const managersMap = new Map();
    for (const c of allCards) {
      if (c.managerId && c.managerName) managersMap.set(String(c.managerId), c.managerName);
    }
    const managers = [...managersMap.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
    const methods = [...new Set(allCards.map(c => c.method).filter(Boolean))].sort();

    // Reset stale manager/method if no longer present
    if (state.managerId && !managersMap.has(state.managerId)) {
      // keep managerId if synced from "Я — …" so "Нет закупок" stays accurate for that manager
    }
    if (state.method && !methods.includes(state.method)) {
      state.method = "";
    }

    const filterByMgrMethod = (card) => {
      if (state.managerId && String(card.managerId) !== state.managerId) return false;
      if (state.method && card.method !== state.method) return false;
      return true;
    };

    const matchesSearch = (card) => {
      const q = (state.searchQuery || "").trim().toLowerCase();
      if (!q) return true;
      const text = `${card.itemName} ${card.lotNumber || ""} ${card.planNumber || ""} ${card.customerName} ${card.customerBin} ${card.method} ${card.managerName}`.toLowerCase();
      return text.includes(q);
    };

    const sumOf = (arr) => arr.reduce((acc, c) => acc + (c.sum || 0), 0);

    const submitColTitles = {
      all: "Все в приёме",
      today: "Сегодня",
      "48h": "До 48 часов"
    };

    const computeViewData = () => {
      const baseSubmit = group.submitToday.filter(filterByMgrMethod);
      const baseDisc = group.discussion.filter(filterByMgrMethod);
      const baseSecond = group.secondChance.filter(filterByMgrMethod);

      const todayCards = baseSubmit.filter(c => c.isToday);
      const within48hCards = baseSubmit.filter(c => c.isToday || c.isWithin48h);

      let submitCards = baseSubmit.filter(matchesSearch);
      if (state.timeFilter === "today") {
        submitCards = submitCards.filter(c => c.isToday);
      } else if (state.timeFilter === "48h") {
        submitCards = submitCards.filter(c => c.isToday || c.isWithin48h);
      }
      submitCards = ordered(submitCards);
      const discCards = ordered(baseDisc.filter(matchesSearch));
      const secondCards = ordered(baseSecond.filter(matchesSearch));
      const baseMissed = missedAll.filter(filterByMgrMethod);

      return {
        missedCount: baseMissed.length,
        missedSum: sumOf(baseMissed),
        missedCards: baseMissed.filter(matchesSearch),
        todayCount: todayCards.length,
        todaySum: sumOf(todayCards),
        within48hCount: within48hCards.length,
        within48hSum: sumOf(within48hCards),
        totalCount: baseSubmit.length + baseDisc.length + baseSecond.length,
        totalSum: sumOf(baseSubmit) + sumOf(baseDisc) + sumOf(baseSecond),
        discCount: baseDisc.length,
        discSum: sumOf(baseDisc),
        secondCount: baseSecond.length,
        secondSum: sumOf(baseSecond),
        submitCards,
        discCards,
        secondCards,
        submitColTitle: submitColTitles[state.timeFilter] || "Все в приёме"
      };
    };

    const renderKpisHtml = (d) => `
      <div class="tile">
        <span class="label">В работе на радаре</span>
        <div class="v">${fmt(d.totalCount)} <small>${lotWord(d.totalCount)}</small></div>
        <div class="sub">${mln(d.totalSum)} млн ₸</div>
      </div>
      <div class="tile tile-submit-counters">
        <span class="label">Сроки подачи</span>
        <div class="radar-deadline-counters">
          <div class="radar-deadline-item" data-radar-counter="today">
            <div class="radar-deadline-title">До конца дня</div>
            <div class="v bad">${fmt(d.todayCount)} <small>${lotWord(d.todayCount)}</small></div>
            <div class="sub">${mln(d.todaySum)} млн ₸</div>
          </div>
          <div class="radar-deadline-item" data-radar-counter="48h">
            <div class="radar-deadline-title">До 48 часов <span class="radar-deadline-note">(включая сегодня)</span></div>
            <div class="v warn">${fmt(d.within48hCount)} <small>${lotWord(d.within48hCount)}</small></div>
            <div class="sub">${mln(d.within48hSum)} млн ₸</div>
          </div>
        </div>
      </div>
      <div class="tile">
        <span class="label">Обсуждение КД</span>
        <div class="v">${fmt(d.discCount)} <small>${lotWord(d.discCount)}</small></div>
        <div class="sub">${mln(d.discSum)} млн ₸</div>
      </div>
      <div class="tile">
        <span class="label">Второй шанс (ИОИ)</span>
        <div class="v good">${fmt(d.secondCount)} <small>${dealWord(d.secondCount)}</small></div>
        <div class="sub">${mln(d.secondSum)} млн ₸</div>
      </div>
      <div class="tile tile-missed${d.missedCount > 0 ? " is-bad" : ""}" data-radar-counter="missed">
        <span class="label">Пропущенные сроки</span>
        <div class="v${d.missedCount > 0 ? " bad" : ""}">${fmt(d.missedCount)} <small>${lotWord(d.missedCount)}</small></div>
        <div class="sub">${mln(d.missedSum)} млн ₸ · за 7 дней</div>
      </div>
    `;

    const renderGridHtml = (d) => `
      ${renderColumn("submitToday", d.submitColTitle, "01", d.submitCards, state)}
      ${renderColumn("discussion", "Успеть с замечанием", "02", d.discCards, state)}
      ${renderColumn("secondChance", "Второй шанс", "03", d.secondCards, state)}
    `;

    const prevInput = container.querySelector(".radar-search-input");
    const savedSelection = prevInput && document.activeElement === prevInput
      ? {
          start: prevInput.selectionStart,
          end: prevInput.selectionEnd,
          dir: prevInput.selectionDirection || "none"
        }
      : null;

    const initialData = computeViewData();

    const html = `
      <section class="block reveal in radar-section">
        <div class="radar-kpis kpis">
          ${renderKpisHtml(initialData)}
        </div>

        <div class="radar-filters-bar">
          <div class="radar-search-wrap">
            <input type="search" class="radar-search-input" placeholder="Поиск по заказчику, БИН, номеру лота или товару…" value="${esc(state.searchQuery)}">
          </div>

          <div class="radar-chips-row">
            ${viewer ? "" : `
            <div class="radar-filter-group">
              <span class="filter-legend">Менеджер:</span>
              <div class="chips">
                <button type="button" data-radar-mgr="" aria-pressed="${String(!state.managerId)}">Вся команда</button>
                ${managers.map(([id, name]) => `<button type="button" data-radar-mgr="${esc(id)}" aria-pressed="${String(state.managerId === id)}">${esc(name)}</button>`).join("")}
              </div>
            </div>
            `}

            ${methods.length > 1 ? `
              <div class="radar-filter-group">
                <span class="filter-legend">Способ:</span>
                <div class="chips">
                  <button type="button" data-radar-method="" aria-pressed="${String(!state.method)}">Все</button>
                  ${methods.map(m => `<button type="button" data-radar-method="${esc(m)}" aria-pressed="${String(state.method === m)}">${esc(m)}</button>`).join("")}
                </div>
              </div>
            ` : ""}

            <div class="radar-filter-group">
              <span class="filter-legend">Срок подачи:</span>
              <div class="chips">
                <button type="button" data-radar-time="all" aria-pressed="${String(state.timeFilter === "all")}">Все в приёме</button>
                <button type="button" data-radar-time="48h" aria-pressed="${String(state.timeFilter === "48h")}">До 48 ч</button>
                <button type="button" data-radar-time="today" aria-pressed="${String(state.timeFilter === "today")}">Сегодня</button>
              </div>
            </div>
            ${hasVerdicts ? `
            <div class="radar-filter-group">
              <span class="filter-legend" title="Ценность — сумма лота × вес вердикта: идём 1, осторожно и без вердикта 0,5, не идём 0,1">Порядок:</span>
              <div class="chips">
                <button type="button" data-radar-order="deadline" aria-pressed="${String(state.order === "deadline")}">по сроку</button>
                <button type="button" data-radar-order="value" aria-pressed="${String(state.order === "value")}">по ценности</button>
              </div>
            </div>
            ` : ""}
          </div>
        </div>

        <div class="radar-grid">
          ${renderGridHtml(initialData)}
        </div>

        <div class="radar-missed-wrap"></div>
      </section>
    `;

    container.innerHTML = html;

    const kpisEl = container.querySelector(".radar-kpis");
    const gridEl = container.querySelector(".radar-grid");
    const missedEl = container.querySelector(".radar-missed-wrap");

    // toggle не всплывает: слушаем каждый новый <details>, чтобы раскрытый список пережил фильтры и поиск.
    const renderMissedBlock = (d) => {
      if (!missedEl) return;
      missedEl.innerHTML = renderMissed(d.missedCount, d.missedCards, state.missedOpen);
      const details = missedEl.querySelector("details.radar-missed");
      if (details) details.addEventListener("toggle", () => { state.missedOpen = details.open; });
    };
    renderMissedBlock(initialData);
    ensureLiveTimer();

    const updateDynamicContent = () => {
      const d = computeViewData();
      if (kpisEl) kpisEl.innerHTML = renderKpisHtml(d);
      if (gridEl) gridEl.innerHTML = renderGridHtml(d);
      renderMissedBlock(d);
    };

    const syncPressedChips = () => {
      container.querySelectorAll("button[data-radar-mgr]").forEach(btn => {
        btn.setAttribute("aria-pressed", String((btn.dataset.radarMgr || "") === state.managerId));
      });
      container.querySelectorAll("button[data-radar-method]").forEach(btn => {
        btn.setAttribute("aria-pressed", String((btn.dataset.radarMethod || "") === state.method));
      });
      container.querySelectorAll("button[data-radar-time]").forEach(btn => {
        btn.setAttribute("aria-pressed", String((btn.dataset.radarTime || "all") === state.timeFilter));
      });
      container.querySelectorAll("button[data-radar-order]").forEach(btn => {
        btn.setAttribute("aria-pressed", String(btn.dataset.radarOrder === state.order));
      });
    };

    // Wire search input: update only the columns without touching the input element, preserving cursor & selection
    const searchInput = container.querySelector(".radar-search-input");
    if (searchInput) {
      if (savedSelection) {
        searchInput.focus();
        if (savedSelection.start !== null && savedSelection.end !== null) {
          searchInput.setSelectionRange(savedSelection.start, savedSelection.end, savedSelection.dir);
        }
      }
      searchInput.addEventListener("input", () => {
        state.searchQuery = searchInput.value;
        const d = computeViewData();
        if (gridEl) gridEl.innerHTML = renderGridHtml(d);
        renderMissedBlock(d);
      });
    }

    // Wire clicks on filters and expand buttons
    container.onclick = (e) => {
      const expandBtn = e.target.closest("button[data-radar-expand]");
      if (expandBtn) {
        const col = expandBtn.dataset.radarExpand;
        state.expandedCol[col] = true;
        const d = computeViewData();
        if (gridEl) gridEl.innerHTML = renderGridHtml(d);
        return;
      }

      const mgrBtn = e.target.closest("button[data-radar-mgr]");
      if (mgrBtn) {
        state.managerId = mgrBtn.dataset.radarMgr || "";
        state.manualFilter = true;
        syncPressedChips();
        updateDynamicContent();
        return;
      }

      const methodBtn = e.target.closest("button[data-radar-method]");
      if (methodBtn) {
        state.method = methodBtn.dataset.radarMethod || "";
        syncPressedChips();
        updateDynamicContent();
        return;
      }

      const timeBtn = e.target.closest("button[data-radar-time]");
      if (timeBtn) {
        state.timeFilter = timeBtn.dataset.radarTime || "all";
        syncPressedChips();
        updateDynamicContent();
        return;
      }

      const orderBtn = e.target.closest("button[data-radar-order]");
      if (orderBtn) {
        state.order = orderBtn.dataset.radarOrder === "value" ? "value" : "deadline";
        syncPressedChips();
        const d = computeViewData();
        if (gridEl) gridEl.innerHTML = renderGridHtml(d);
        return;
      }
    };
  };
})();
