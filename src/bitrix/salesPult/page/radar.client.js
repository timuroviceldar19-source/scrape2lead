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
        expandedCol: { submitToday: false, discussion: false, secondChance: false }
      };
      radarStates.set(tab, st);
    }
    return st;
  }

  function formatTimeBadge(card) {
    if (card.column === "secondChance") {
      return `<span class="radar-badge dim">не состоялась</span>`;
    }
    if (card.hoursLeft == null) {
      return card.endAt ? `<span class="radar-badge">до ${esc(card.endAt.slice(5))}</span>` : "";
    }
    const h = card.hoursLeft;
    if (h <= 0) {
      return `<span class="radar-badge bad">приём окончен</span>`;
    }
    if (h < 1) {
      const mins = Math.max(1, Math.round(h * 60));
      return `<span class="radar-badge bad">осталось ${mins} мин</span>`;
    }
    if (h < 4) {
      const hours = Math.floor(h);
      const mins = Math.round((h % 1) * 60);
      return `<span class="radar-badge bad">осталось ${hours} ч ${mins ? `${mins} мин` : ""}</span>`;
    }
    if (h < 24) {
      const hours = Math.floor(h);
      const mins = Math.round((h % 1) * 60);
      return `<span class="radar-badge warn">осталось ${hours} ч ${mins ? `${mins} мин` : ""}</span>`;
    }
    if (h <= 48) {
      const hours = Math.floor(h);
      return `<span class="radar-badge warn">осталось ${hours} ч</span>`;
    }
    return `<span class="radar-badge">до ${esc(card.endAt ? card.endAt.slice(5) : "—")}</span>`;
  }

  function renderCard(card, custIndex) {
    const isBought = custIndex ? custIndex.isBought(card.customerBin, card.customerName) : false;
    const isLost = custIndex ? custIndex.isLost(card.customerName) : false;
    const boughtTag = isBought ? ' <span class="tag good">покупал у нас</span>' : '';
    const lostTag = isLost ? ' <span class="tag warn">ранее забрал конкурент</span>' : '';

    const dealLabel = `Сделка #${card.id} ↗`;
    const lotLink = card.lotUrl || card.announceUrl;
    const lotLabel = card.sourceType === "plan" ? "План ЭГЗ ↗" : "Лот ЭГЗ ↗";

    return `
      <div class="radar-card" data-deal-id="${esc(card.id)}">
        <div class="radar-card-head">
          <div class="radar-card-item">
            <strong>${esc(card.itemName)}</strong>${card.qty ? ` <span class="dim">· ${fmt(card.qty)} шт.</span>` : ""}
            <div class="radar-card-meta"><span class="tag method">${esc(card.method)}</span>${card.kind ? ` <span class="dim">${esc(card.kind)}</span>` : ""}</div>
          </div>
          <div class="radar-card-right">
            ${formatTimeBadge(card)}
            <div class="radar-card-sum num">${money(card.sum)}</div>
          </div>
        </div>
        <div class="radar-card-cust" title="${esc(card.customerName)}">
          <span class="cust-name">${esc(shortCustomerName(card.customerName))}</span>${boughtTag}${lostTag}
          ${card.customerBin ? `<span class="dim sub">${esc(card.customerBin)}</span>` : ""}
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

  function renderColumn(colKey, title, idx, cards, state, custIndex) {
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
            ? visibleCards.map(c => renderCard(c, custIndex)).join("")
            : `<p class="muted">Нет закупок</p>`}
        </div>
        ${cards.length > 6 && !state.expandedCol[colKey]
          ? `<button type="button" class="btn radar-col-more" data-radar-expand="${colKey}">Показать все (${fmt(cards.length)}) →</button>`
          : ""}
      </div>
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

    // Sync with global "Я — …" (localStorage "pult-me")
    let me = "";
    try { me = localStorage.getItem("pult-me") || ""; } catch (e) {}
    if (state.lastSyncedMe !== me) {
      state.lastSyncedMe = me;
      state.manualFilter = false;
      state.managerId = me;
    }

    const plansBase = typeof PAYLOAD !== "undefined" ? (groupKey === "kt" ? PAYLOAD?.plans?.kt : PAYLOAD?.plans?.ip) : null;
    const custIndex = typeof window.__buildCustomerIndices === "function"
      ? window.__buildCustomerIndices(plansBase, typeof PAYLOAD !== "undefined" ? PAYLOAD?.market : null)
      : null;

    // Available managers & methods (over all cards in group)
    const allCards = [...group.submitToday, ...group.discussion, ...group.secondChance];
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
      const discCards = baseDisc.filter(matchesSearch);
      const secondCards = baseSecond.filter(matchesSearch);

      return {
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
    `;

    const renderGridHtml = (d) => `
      ${renderColumn("submitToday", d.submitColTitle, "01", d.submitCards, state, custIndex)}
      ${renderColumn("discussion", "Успеть с замечанием", "02", d.discCards, state, custIndex)}
      ${renderColumn("secondChance", "Второй шанс", "03", d.secondCards, state, custIndex)}
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
            <div class="radar-filter-group">
              <span class="filter-legend">Менеджер:</span>
              <div class="chips">
                <button type="button" data-radar-mgr="" aria-pressed="${String(!state.managerId)}">Вся команда</button>
                ${managers.map(([id, name]) => `<button type="button" data-radar-mgr="${esc(id)}" aria-pressed="${String(state.managerId === id)}">${esc(name)}</button>`).join("")}
              </div>
            </div>

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
          </div>
        </div>

        <div class="radar-grid">
          ${renderGridHtml(initialData)}
        </div>
      </section>
    `;

    container.innerHTML = html;

    const kpisEl = container.querySelector(".radar-kpis");
    const gridEl = container.querySelector(".radar-grid");

    const updateDynamicContent = () => {
      const d = computeViewData();
      if (kpisEl) kpisEl.innerHTML = renderKpisHtml(d);
      if (gridEl) gridEl.innerHTML = renderGridHtml(d);
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
    };
  };
})();
