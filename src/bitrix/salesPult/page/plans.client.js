(function () {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n || 0);
  const mln = n => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format((n || 0) / 1e6);
  const money = n => `${mln(n)} млн ₸`;
  const WIN_SHARE_MIN_DECIDED = 10;
  const winShare = (won, lost) => won + lost > 0 ? Math.round(won / (won + lost) * 100) : 0;
  const validMonth = m => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  const monthName = m => m === "all" ? "все месяцы" : new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
  window.__planMonths = group => group ? ["all", ...[...new Set((group.months || []).map(m => m.m).filter(validMonth))].sort()] : [];
  window.__planViewForMonth = function (group, month) {
    if (!group) return null;
    const key = month === "all" || validMonth(month) ? month : "all";
    if (group.monthViews && Object.prototype.hasOwnProperty.call(group.monthViews, key)) return group.monthViews[key];
    return group.monthViews && Object.prototype.hasOwnProperty.call(group.monthViews, "all") ? group.monthViews.all : group;
  };
  const head = (i, title, meta = "") => `<div class="block-head"><h2><span class="idx">${i}</span>${title}</h2><span class="meta">${meta}</span></div>`;
  const bar = (value, max, cls = "") => `<div class="hbar"><span class="${cls}" style="width:${max > 0 ? Math.max(0, Math.min(100, value / max * 100)) : 0}%"></span></div>`;
  const link = (url, label) => {
    let valid = false;
    try { const u = new URL(url); valid = u.protocol === "https:" && !u.username && !u.password; } catch {}
    return valid ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
  };
  const pct = (part, whole) => whole > 0 ? Math.round((part / whole - 1) * 100) : null;
  const signedPct = p => p === null ? "" : p === 0 ? "как в плане" : `${p > 0 ? "+" : "−"}${fmt(Math.abs(p))}%`;
  const lostList = deals => `<div class="cust-list rows">${deals.map(d => {
    const diff = d.contractSum === null ? null : pct(d.contractSum, d.planSum);
    return `<div class="r lost-row"><span>${esc(d.month)}</span><span>${link(d.dealUrl, d.planNumber || d.id)} · ${esc(d.customerName)}<span class="dim sub">${esc(d.itemName)} · ${esc(d.managerName)}</span></span><span class="num">план ${money(d.planSum)}</span><span class="num">${d.contractSum === null ? "сумма договора неизвестна" : `договор ${money(d.contractSum)}${diff === null ? "" : ` · ${signedPct(diff)}`}`}</span></div>`;
  }).join("")}</div>`;
  const lostToBlock = (L, idx) => {
    const rows = L.competitors.map((c, i) => `<details class="cust-d lost-d"><summary class="r"><span class="rk">${fmt(i + 1)}</span><span class="cust">${esc(c.name)}<span class="dim sub">БИН ${esc(c.bin)}</span></span><span data-l="закупок">${fmt(c.count)}</span><span class="num" data-l="по плану">${money(c.planSum)}</span><span class="num" data-l="по договорам">${c.knownSumCount ? money(c.contractSum) : "—"}</span><span data-l="дешевле плана">${c.knownSumCount ? `${fmt(c.cheaperCount)} из ${fmt(c.knownSumCount)}` : "—"}</span></summary>${lostList(c.deals)}${c.count > c.deals.length ? `<p class="muted lost-more">и ещё ${fmt(c.count - c.deals.length)} помельче</p>` : ""}</details>`).join("");
    const shown = L.competitors.length < L.companies ? ` · показаны ${fmt(L.competitors.length)} с наибольшим числом` : "";
    return `${head(idx, "Кому проиграли", L.lostCount ? `${fmt(L.lostCount)} закупок · ${fmt(L.companies)} компаний${shown}` : "")}
      ${L.lostCount ? `<div class="lost-to rows"><div class="r head"><span>Место</span><span>Победитель</span><span>Закупок</span><span>По плану</span><span>По договорам</span><span>Дешевле плана</span></div>${rows}</div>
      ${L.unknownCount ? `<p class="muted lost-unknown">ещё ${fmt(L.unknownCount)} без данных о победителе</p>` : ""}
      <p class="note-src">Победитель и сумма договора — из комментария робота «Итог закупки» в сделке. «Дешевле плана» — договор меньше суммы плана больше чем на 0,5%. Если договор закрыл только часть количества, процент по сделке занижен.</p>` : `<p class="muted">Проигранных закупок нет</p>`}`;
  };
  const list = plans => `<div class="cust-list rows">${plans.map(d => `<div class="r plan-list-row"><span>${esc(d.month)}</span><span>${link(d.dealUrl, d.planNumber || d.id)} · ${esc(d.customerName)}<span class="dim sub">${esc(d.itemName)}</span></span><span>${fmt(d.qty)} шт.</span><span class="num">${money(d.sum)} · ${link(d.planUrl, "План ↗")}</span></div>`).join("")}</div>`;

  // Общая прокрутка выбранной кнопки для месяцев и строк фильтров.
  window.__scrollPlanSelection = row => {
    const button = row?.querySelector('[aria-pressed="true"]');
    if (button) row.scrollLeft += button.getBoundingClientRect().left - row.getBoundingClientRect().left - 16;
  };

  const tableStates = new Map();
  const filterLabels = { managerId: "Менеджер", kind: "Вид товара", portalStatus: "Статус портала", method: "Способ закупки" };

  function buildCustomerIndices(base, market) {
    const boughtBins = new Set();
    const boughtNames = new Set();
    const lostNames = new Set();
    const norm = s => {
      let t = " " + String(s || "").toLowerCase().replace(/ё/g, "е").replace(/["«»„“]/g, " ") + " ";
      t = t.replace(/\s+коммунальное\s+государственное\s+казенное\s+предприятие\s+/g, " кгкп ");
      t = t.replace(/\s+коммунальное\s+государственное\s+учреждение\s+/g, " кгу ");
      t = t.replace(/\s+государственное\s+коммунальное\s+казенное\s+предприятие\s+/g, " гккп ");
      t = t.replace(/\s+государственное\s+коммунальное\s+предприятие\s+/g, " гкп ");
      t = t.replace(/\s+товарищество\s+с\s+ограниченной\s+ответственностью\s+/g, " тоо ");
      t = t.replace(/\s+некоммерческое\s+акционерное\s+общество\s+/g, " нао ");
      return t.replace(/\s+/g, " ").trim();
    };

    const scanPlansWon = (slice) => {
      if (!slice) return;
      for (const c of slice.customers || []) {
        const hasWon = (c.wonCount && c.wonCount > 0) || (c.planList && c.planList.some(p => p.outcomeCategory === "won"));
        if (hasWon) {
          if (c.bin) boughtBins.add(String(c.bin).trim());
          if (c.name) boughtNames.add(norm(c.name));
        }
      }
      for (const m of slice.managers || []) {
        for (const p of m.planList || []) {
          if (p.outcomeCategory === "won") {
            if (p.customerBin) boughtBins.add(String(p.customerBin).trim());
            if (p.customerName) boughtNames.add(norm(p.customerName));
          }
        }
      }
    };
    scanPlansWon(base);
    if (base.monthViews) {
      for (const mv of Object.values(base.monthViews)) scanPlansWon(mv);
    }

    const mkt = market || (typeof PAYLOAD !== "undefined" ? PAYLOAD?.market : null);
    if (mkt) {
      for (const group of [mkt.ip, mkt.kt]) {
        if (!group) continue;
        const scanCustomers = (custs) => {
          for (const c of custs || []) {
            const hasUs = (c.us && c.us > 0) || (c.contractList && c.contractList.some(item => item.us));
            if (hasUs) {
              if (c.bin) boughtBins.add(String(c.bin).trim());
              if (c.name) boughtNames.add(norm(c.name));
            }
          }
        };
        scanCustomers(group.customers);
        if (group.monthViews) {
          for (const mv of Object.values(group.monthViews)) scanCustomers(mv?.customers);
        }
        const scanSuppliers = (supps) => {
          for (const s of supps || []) {
            if (s.us) {
              for (const item of s.contractList || []) {
                if (item.customer) boughtNames.add(norm(item.customer));
              }
            }
          }
        };
        scanSuppliers(group.suppliers);
        if (group.monthViews) {
          for (const mv of Object.values(group.monthViews)) scanSuppliers(mv?.suppliers);
        }
      }
    }

    const scanLostTo = (lt) => {
      if (!lt) return;
      for (const comp of lt.competitors || []) {
        for (const deal of comp.deals || []) {
          if (deal.customerName) lostNames.add(norm(deal.customerName));
        }
      }
    };
    scanLostTo(base.lostTo);
    if (base.monthViews) {
      for (const mv of Object.values(base.monthViews)) scanLostTo(mv?.lostTo);
    }

    return {
      isBought: (bin, name) => (bin && boughtBins.has(String(bin).trim())) || (name && boughtNames.has(norm(name))),
      isLost: (name) => name && lostNames.has(norm(name))
    };
  }

  function readTableState(key) {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { /* Хранилище может быть недоступно. */ }
    const filters = {};
    for (const field of Object.keys(filterLabels)) filters[field] = typeof saved?.filters?.[field] === "string" ? saved.filters[field] : "";
    return { filters, sort: ["sum", "month", "qty"].includes(saved?.sort) ? saved.sort : "sum",
      direction: saved?.direction === "asc" ? "asc" : "desc", limit: 50, storageKey: key, manualFilter: !!saved?.manualFilter, searchQuery: "", lastSyncedMe: typeof saved?.lastSyncedMe === "string" ? saved.lastSyncedMe : undefined };
  }
  function saveTableState(state) {
    try { sessionStorage.setItem(state.storageKey, JSON.stringify({ filters: state.filters, sort: state.sort, direction: state.direction, manualFilter: state.manualFilter, lastSyncedMe: state.lastSyncedMe })); }
    catch { /* Настройки продолжают работать в памяти. */ }
  }
  function renderOpenPlans(base, el, active, state) {
    const source = base.openPlans || [];
    let me = "";
    try { me = localStorage.getItem("pult-me") || ""; } catch (e) {}
    if (state.lastSyncedMe !== me) {
      state.lastSyncedMe = me;
      state.manualFilter = false;
      state.filters.managerId = me && source.some(d => String(d.managerId) === me) ? me : "";
    } else if (me && !state.manualFilter && !state.filters.managerId) {
      if (source.some(d => String(d.managerId) === me)) {
        state.filters.managerId = me;
      }
    }
    const choicesByKey = new Map(Object.keys(filterLabels).map(key => [key,
      new Map(source.map(d => [String(d[key] ?? ""), key === "managerId" ? d.managerName : d[key]]).filter(([value]) => value))]));
    for (const key of Object.keys(filterLabels)) if (!choicesByKey.get(key).has(state.filters[key])) state.filters[key] = "";
    saveTableState(state);
    const q = (state.searchQuery || "").trim().toLowerCase();
    const matches = source.filter(d => {
      if (active !== "all" && d.month !== active) return false;
      for (const key of Object.keys(filterLabels)) {
        if (state.filters[key] && String(d[key] ?? "") !== state.filters[key]) return false;
      }
      if (q) {
        const hay = `${d.customerName || ""} ${d.customerBin || ""} ${d.planNumber || ""} ${d.id || ""} ${d.itemName || ""} ${d.truCode || ""} ${d.managerName || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    matches.sort((a, b) => {
      const cmp = state.sort === "month" ? String(a.month).localeCompare(String(b.month)) : (a[state.sort] || 0) - (b[state.sort] || 0);
      return (state.direction === "asc" ? cmp : -cmp) || String(a.id).localeCompare(String(b.id), "ru", { numeric: true });
    });
    const custIndex = buildCustomerIndices(base, typeof PAYLOAD !== "undefined" ? PAYLOAD?.market : null);
    const sortHead = (key, label) => `<span role="columnheader" aria-sort="${state.sort === key ? state.direction === "asc" ? "ascending" : "descending" : "none"}"><button type="button" data-plan-sort="${key}" data-direction="${state.sort === key ? state.direction : ""}">${label}${state.sort === key ? state.direction === "asc" ? " ↑" : " ↓" : " ↕"}</button></span>`;
    const open = el.querySelector(".plans-open");
    const scrollPositions = [...open.querySelectorAll(".plan-filter-group .chips")].map(row => row.scrollLeft);
    const filterHtml = Object.entries(filterLabels).map(([key, label]) => {
      const button = (value, name) => `<button type="button" data-plan-filter="${key}" data-value="${esc(value)}" aria-pressed="${state.filters[key] === value}">${esc(name)}</button>`;
      return `<fieldset class="plan-filter-group"><legend>${label}</legend><div class="chips">${button("", "Все")}${[...choicesByKey.get(key)].sort((a, b) => String(a[1]).localeCompare(String(b[1]), "ru")).map(([value, name]) => button(value, name)).join("")}</div></fieldset>`;
    }).join("");
    open.innerHTML = `${head("05", "Открытые планы", `Показано ${fmt(Math.min(state.limit, matches.length))} из ${fmt(matches.length)}`)}
      <div class="plan-search-wrap">
        <input type="search" class="plan-search-input" placeholder="Поиск по заказчику, БИН, номеру плана или товару…" value="${esc(state.searchQuery || "")}">
      </div>
      <div class="plan-filters" role="group" aria-label="Фильтры открытых планов">${filterHtml}</div>
      <div class="rows plans-table" role="table" aria-label="Открытые планы">
        <div class="r head" role="row">${sortHead("month", "Месяц")}<span role="columnheader">Заказчик</span><span role="columnheader">Товар / вид</span>${sortHead("qty", "Кол-во")}${sortHead("sum", "Сумма")}<span role="columnheader">Статус портала</span><span role="columnheader">Менеджер</span></div>
        ${matches.slice(0, state.limit).map(d => {
          const isBought = custIndex.isBought(d.customerBin, d.customerName);
          const isLost = custIndex.isLost(d.customerName);
          const boughtTag = isBought ? ' <span class="tag good">покупал у нас</span>' : '';
          const lostTag = isLost ? ' <span class="tag warn">ранее забрал конкурент</span>' : '';
          return `<div class="r" role="row" data-plan-id="${esc(d.id)}"><span role="cell">${esc(d.month)}<span class="sub">${link(d.dealUrl, `Сделка ${d.id} ↗`)} · ${link(d.planUrl, `План ${d.planNumber} ↗`)}</span></span><span role="cell">${esc(d.customerName)}${boughtTag}${lostTag}<span class="dim sub">${esc(d.customerBin)}</span></span><span role="cell">${esc(d.itemName)}<span class="dim sub">${[d.truCode, d.kind].filter(Boolean).map(esc).join(" · ")}</span></span><span role="cell" data-label="Количество">${fmt(d.qty)} шт.</span><span role="cell" class="num" data-label="Сумма">${money(d.sum)}</span><span role="cell" data-label="Статус портала">${esc(d.portalStatus)}</span><span role="cell" data-label="Менеджер">${esc(d.managerName)}${d.isNewStage ? '<span class="bad sub">Новая · ждёт разбора</span>' : ""}</span></div>`;
        }).join("")}
      </div>${!matches.length ? `<p class="muted" role="status">${Object.values(state.filters).some(Boolean) || state.searchQuery ? "Ничего не найдено. Измените фильтры или месяц." : "Открытых планов нет"}</p>` : ""}
      ${matches.length > state.limit ? '<button type="button" class="btn plans-more" data-plan-more>Показать ещё</button>' : ""}`;
    open.querySelectorAll(".plan-filter-group .chips").forEach((row, i) => {
      row.scrollLeft = scrollPositions[i] || 0;
      if (!scrollPositions.length) window.__scrollPlanSelection(row);
    });
    const searchInput = open.querySelector(".plan-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        state.searchQuery = searchInput.value;
        state.limit = 50;
        renderOpenPlans(base, el, active, state);
        const nextInput = open.querySelector(".plan-search-input");
        if (nextInput) {
          nextInput.focus();
          nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
        }
      });
    }
    open.onclick = event => {
      const button = event.target.closest("button");
      if (!button) return;
      const previousLimit = state.limit;
      if (button.dataset.planFilter) {
        state.filters[button.dataset.planFilter] = button.dataset.value;
        state.manualFilter = true;
        state.limit = 50;
      } else if (button.hasAttribute("data-plan-more")) state.limit += 50;
      else if (button.dataset.planSort) {
        const key = button.dataset.planSort;
        state.direction = state.sort === key && state.direction === "desc" ? "asc" : "desc";
        state.sort = key;
        state.limit = 50;
      } else return;
      renderOpenPlans(base, el, active, state);
      if (button.dataset.planFilter) {
        const focused = [...open.querySelectorAll("[data-plan-filter]")].find(b => b.dataset.planFilter === button.dataset.planFilter && b.dataset.value === button.dataset.value);
        focused?.focus({ preventScroll: true });
        const offset = (document.querySelector(".bar")?.getBoundingClientRect().height || 0) + (document.querySelector(".dateline")?.getBoundingClientRect().height || 0) + 16;
        window.scrollTo({ top: scrollY + open.getBoundingClientRect().top - offset, behavior: "instant" });
      } else if (button.dataset.planSort) open.querySelector(`[data-plan-sort="${button.dataset.planSort}"]`)?.focus({ preventScroll: true });
      else {
        const target = open.querySelectorAll("[data-plan-id]")[previousLimit]?.querySelector("a");
        target?.focus({ preventScroll: true });
      }
    };
  }

  window.__renderPlansTab = function (key, PLANS, el, selectedMonth) {
    if (!el) return;
    const base = key === "plans-ip" || key === "ИП" ? PLANS?.ip : PLANS?.kt;
    const V = window.__planViewForMonth(base, selectedMonth);
    if (!V) { el.innerHTML = `<section class="block"><p class="lead">${esc(PLANS?.error || "Данные планов ещё собираются.")}</p></section>`; return; }
    const active = window.__planMonths(base).includes(selectedMonth) ? selectedMonth : "all";
    const total = V.total;
    const title = key === "plans-ip" || key === "ИП" ? "интерактивных панелей" : "компьютерной техники";
    const metric = (label, amount, count, cls = "") => `<div class="${cls}"><span class="label">${label}</span><div class="v">${money(amount)}<small> · ${fmt(count)} шт.</small></div></div>`;
    const decided = total.wonCount + total.lostCount;
    const totalWinShare = `<div class="plan-win-total"><span class="label">Доля побед</span><div class="v">${decided < WIN_SHARE_MIN_DECIDED ? "мало итогов" : `${fmt(winShare(total.wonCount, total.lostCount))}%`}<small>${decided < WIN_SHARE_MIN_DECIDED || total.wonSum + total.lostSum === 0 ? "" : `по сумме ${fmt(winShare(total.wonSum, total.lostSum))}% · `}из ${fmt(decided)} с итогом</small></div></div>`;
    const managerCells = (m, i) => {
      const share = winShare(m.wonCount, m.lostCount);
      return `<span class="rk">${fmt(i + 1)}</span><span class="nm"><span>${esc(m.name)}</span></span><span class="plan-win-share" data-l="доля побед">${m.wonCount + m.lostCount < WIN_SHARE_MIN_DECIDED ? "мало итогов" : `<span class="hbar"><span style="width:${esc(share)}%"></span></span><span>${fmt(share)}%</span>`}</span><span class="plan-win-counts"><span class="plan-win-desktop">${fmt(m.wonCount)} / ${fmt(m.lostCount)}</span><span class="plan-win-mobile">выиграл ${fmt(m.wonCount)} · проиграл ${fmt(m.lostCount)}</span></span><span class="num">${money(m.sum)}</span><span class="num">${fmt(m.count)} / ${fmt(m.openCount)} / <b class="${m.newCount ? "bad" : ""}">${fmt(m.newCount)}</b></span>`;
    };
    const maxMonth = Math.max(1, ...base.months.map(m => m.sum));
    const monthAttrs = m => `data-m="${esc(m.m)}" role="button" tabindex="0" aria-label="${esc(monthName(m.m))}" aria-current="${m.m === active}"`;
    el.innerHTML = `
      <section class="block plans-summary" data-slice="${active}">
        ${head("01", `Планы ${title} · ${esc(monthName(active))}`)}
        <div class="hero"><div>
          <span class="label">Общая сумма собранных планов</span>
          <div class="hero-num"><span class="big">${mln(total.sum)}</span><span class="of">млн ₸</span></div>
          <p data-plan-count="${total.count}">${fmt(total.count)} пунктов · ${fmt(total.customers)} заказчиков</p>
          <div class="readout">${metric("В работе", total.openSum, total.openCount)}${metric('Ждут разбора (стадия «Новая»)', total.newSum, total.newCount, total.newCount ? "bad" : "")}${metric("Опубликовано / Договор", total.publishedSum, total.publishedCount)}</div>
          <div class="readout plans-outcomes">${metric("Забрали мы (F3 + партнёр)", total.wonSum, total.wonCount)}${metric("Ушло конкурентам", total.lostSum, total.lostCount)}${totalWinShare}${metric("Отменено / изменено", total.cancelledSum, total.cancelledCount)}${metric("Новые за 7 дней", total.createdLast7dSum, total.createdLast7dCount)}</div>
        </div><div class="share rows"><h3>По менеджерам</h3>
          <div class="r head"><span>Место</span><span>Менеджер</span><span>Доля побед</span><span>Выиграл / Проиграл</span><span>Сумма</span><span>Шт. / В работе / Новых</span></div>
          ${V.managers.map((m, i) => m.planList.length ? `<details class="cust-d"><summary class="r">${managerCells(m, i)}</summary>${list(m.planList)}</details>` : `<div class="r">${managerCells(m, i)}</div>`).join("") || '<p class="muted">Планов нет</p>'}
          <p class="note-src">Доля побед — выигранные (F3 и партнёр) из закупок с известным итогом; показывается от 10 итогов</p>
        </div></div>
      </section>
      <section class="block plans-months">${head("02", "По планируемым месяцам", "Тёмная часть: в работе + выигранные нами")}
        <div class="months">${base.months.map(m => `<div class="col" ${monthAttrs(m)} title="${esc(monthName(m.m))}: ${money(m.sum)}, ${fmt(m.count)} планов"><div class="tot" style="height:${Math.max(0, m.sum / maxMonth * 100)}%"><span class="lab">${mln(m.sum)}</span><div class="our" style="height:${m.sum > 0 ? Math.max(0, Math.min(100, m.activeSum / m.sum * 100)) : 0}%"></div></div></div>`).join("")}</div>
        <div class="mlabels">${base.months.map(m => `<span ${monthAttrs(m)}>${esc(m.m)}</span>`).join("")}</div>
      </section>
      <section class="block plans-breakdown" data-slice="${active}">${head("03", "Способы закупки и товары")}
        <div class="two"><div class="meth rows"><h3>Способы закупки</h3><div class="r head"><span>Способ</span><span>Планов</span><span>Объём</span><span>Сумма</span><span>В работе</span></div>
          ${V.methods.map(m => `<div class="r"><span>${esc(m.name)}</span><span>${fmt(m.count)}</span>${bar(m.sum, total.sum)}<span class="num">${money(m.sum)}</span><span>${fmt(m.openCount)}</span></div>`).join("")}
        </div><div><h3>Виды товаров</h3><div class="rows plans-kinds"><div class="r head"><span>Вид</span><span>Шт.</span><span>Средняя цена</span><span>Сумма</span></div>
          ${V.kinds.map(k => `<div class="r"><span>${esc(k.kind)}</span><span>${fmt(k.qty)}</span><span>${fmt(k.avgPrice)} ₸</span><span class="num">${money(k.sum)}</span></div>`).join("")}</div>
          <h3>Статусы на портале</h3><div class="rows plans-statuses">${V.statuses.map(s => `<div class="r"><span>${esc(s.status)}</span><span>${fmt(s.count)} шт.</span><span class="num">${money(s.sum)}</span></div>`).join("")}</div>
        </div></div>
      </section>
      <section class="block plans-lost" data-slice="${active}">${V.lostTo ? lostToBlock(V.lostTo, "04") : ""}</section>
      <section class="block plans-open" data-slice="${active}"></section>
      <section class="block plans-customers" data-slice="${active}">${head("06", "Крупнейшие заказчики по планам", "Топ-15")}
        <div class="cust rows"><div class="r head"><span>Заказчик / БИН</span><span>Сумма планов</span><span>Пунктов</span><span>В работе</span></div>
          ${V.customers.map(c => `<details class="cust-d"><summary class="r"><span class="cust">${esc(c.name)}<span class="dim sub">${esc(c.bin)}</span></span><span class="num">${money(c.sum)}</span><span>${fmt(c.count)}</span><span>${money(c.openSum)} · ${fmt(c.openCount)} шт.${bar(c.openSum, c.sum, "ink")}</span></summary>${list(c.planList)}</details>`).join("")}
        </div>
      </section>`;
    const stateKey = base.group === "ИП" ? "plans-ip" : "plans-kt";
    if (!tableStates.has(stateKey)) tableStates.set(stateKey, readTableState(`sales-pult:plans:${stateKey}`));
    const state = tableStates.get(stateKey);
    if (state.month !== active) state.limit = 50;
    state.month = active;
    renderOpenPlans(base, el, active, state);
  };
})();
