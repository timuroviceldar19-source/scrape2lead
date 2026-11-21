(function () {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n || 0);
  const mln = n => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format((n || 0) / 1e6);
  const money = n => `${mln(n)} млн ₸`;
  const plural = (n, f) => {
    const a = Math.abs(n) % 100, b = a % 10;
    return `${fmt(n)} ${a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b > 1 && b < 5 ? f[1] : f[2]}`;
  };
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

  const validBin = value => /^\d{12}$/.test(String(value ?? "").trim()) ? String(value).trim() : "";
  const normalizeName = value => {
    let name = " " + String(value || "").toLowerCase().replace(/ё/g, "е").replace(/["«»„“]/g, " ").replace(/\s+/g, " ") + " ";
    name = name.replace(/ коммунальное государственное казенное предприятие /g, " кгкп ");
    name = name.replace(/ коммунальное государственное учреждение /g, " кгу ");
    name = name.replace(/ государственное коммунальное казенное предприятие /g, " гккп ");
    name = name.replace(/ государственное коммунальное предприятие /g, " гкп ");
    name = name.replace(/ товарищество с ограниченной ответственностью /g, " тоо ");
    name = name.replace(/ некоммерческое акционерное общество /g, " нао ");
    return name.replace(/\s+/g, " ").trim();
  };
  function append(map, key, item) {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  function customerIndex() {
    const byBin = new Map(), byName = new Map(), withoutBin = new Map();
    return {
      add(bin, name, item) {
        const key = validBin(bin);
        const norm = normalizeName(name);
        append(byBin, key, item);
        append(byName, norm, item);
        if (!key) append(withoutBin, norm, item);
      },
      find(bin, name) {
        const key = validBin(bin);
        const norm = normalizeName(name);
        return key ? byBin.get(key) || withoutBin.get(norm) || [] : byName.get(norm) || [];
      }
    };
  }

  const views = group => group ? [group, ...Object.entries(group.monthViews || {}).filter(([key]) => key !== "all").map(([, view]) => view)] : [];
  function buildCustomerIndices(plans, market, competitors) {
    const bought = customerIndex();
    const lost = customerIndex();
    const rememberPurchase = (bin, name) => bought.add(bin, name, true);
    const crmLosses = new Map(), protocolLosses = new Map();
    const rememberProtocolLoss = (lot, bin, name, diff) => {
      if ((!bin && !name) || (!lot.annoId && !lot.lotNumber)) return;
      const key = JSON.stringify([lot.annoId, lot.lotNumber, bin || normalizeName(name)]);
      const prev = protocolLosses.get(key);
      protocolLosses.set(key, {
        bin, name: prev?.name || name,
        customerBin: validBin(prev?.customerBin) || lot.customerBin,
        customerName: prev?.customerName || lot.customerName, diff: prev?.diff ?? diff
      });
    };
    for (const key of ["ip", "kt"]) {
      for (const c of plans?.[key]?.wonCustomers || []) rememberPurchase(c.bin, c.name);
      for (const slice of views(plans?.[key])) {
        for (const c of slice.customers || []) {
          if (c.wonCount > 0 || c.planList?.some(p => p.outcomeCategory === "won")) rememberPurchase(c.bin, c.name);
        }
        for (const c of slice.lostTo?.competitors || []) {
          for (const d of c.deals || []) {
            if (crmLosses.has(d.id)) continue;
            crmLosses.set(d.id, {
              bin: c.bin, name: c.name, customerBin: d.customerBin, customerName: d.customerName,
              diff: d.contractSum == null ? null : pct(d.contractSum, d.planSum)
            });
          }
        }
      }
      for (const slice of views(market?.[key])) {
        for (const c of slice.customers || []) {
          if (c.us > 0 || c.contractList?.some(item => item.us)) rememberPurchase(c.bin, c.name);
        }
        for (const supplier of slice.suppliers || []) {
          if (!supplier.us) continue;
          for (const c of supplier.contractList || []) rememberPurchase(c.customerBin, c.customer);
        }
      }
      for (const slice of views(competitors?.[key])) {
        for (const c of slice.competitors || []) {
          for (const lot of c.lotList || []) {
            if (!lot.isWinner) continue;
            if (c.us) rememberPurchase(lot.customerBin, lot.customerName);
            else {
              const diff = Number.isFinite(lot.discountPct) ? -lot.discountPct :
                lot.bidTotalPrice == null ? null : pct(lot.bidTotalPrice, lot.plannedSum);
              rememberProtocolLoss(lot, c.bin, c.name, diff);
            }
          }
        }
        for (const rival of slice.headToHead || []) {
          for (const lot of rival.lots || []) {
            if (lot.weWon) rememberPurchase(lot.customerBin, lot.customerName);
            else if (lot.rivalWon) {
              const diff = Number.isFinite(lot.winnerDiscountPct) ? -lot.winnerDiscountPct : null;
              rememberProtocolLoss(lot, lot.winnerBin || rival.bin, lot.winnerName || rival.name, diff);
            }
          }
        }
      }
    }
    for (const d of [...protocolLosses.values(), ...crmLosses.values()]) {
      lost.add(d.customerBin, d.customerName, d);
    }
    return { bought, lost };
  }

  function buildTemplateIndex(group) {
    const customers = customerIndex();
    const byLot = new Map(), byAnnouncement = new Map();
    for (const template of group?.specTemplates || []) {
      for (const lot of template.lots || []) {
        const match = { template, lot };
        append(byLot, lot.lotNumber, match);
        append(byAnnouncement, lot.annoId, match);
        customers.add(lot.customerBin, lot.customerName, match);
      }
    }
    return item => {
      const announcement = item.annoId || String(item.announceUrl || item.lotUrl || "").match(/\/announce\/index\/(\d+)(?:[/?#]|$)/)?.[1];
      const history = customers.find(item.customerBin, item.customerName);
      const direct = byLot.get(item.lotNumber) || byAnnouncement.get(announcement);
      const match = (direct || history).reduce((best, match) => {
        if (!best) return match;
        if (match.lot.strength !== best.lot.strength) return match.lot.strength === "strong" ? match : best;
        return match.lot.sharePct > best.lot.sharePct ? match : best;
      }, null);
      if (!match) return null;
      return {
        template: match.template,
        historical: !direct,
        strong: match.lot.strength === "strong" || history.some(m => m.template === match.template && m.lot.strength === "strong")
      };
    };
  }

  const diagonal = value => String(value || "").match(/(?:^|\D)(65|75|86)\s*(?:["″”»]|дюйм|$)/i)?.[1];
  function priceKind(label) {
    const name = normalizeName(label);
    if (name === "компьютеры и моноблоки") return name;
    const kinds = [
      [/панел|^(65|75|86)\b/, "панель"], [/доск/, "доска"], [/учебн.*комплект/, "учебный комплект"],
      [/системн.*блок/, "системный блок"], [/моноблок/, "моноблок"], [/компьютер/, "компьютер"],
      [/ноутбук/, "ноутбук"], [/монитор/, "монитор"], [/мфу|многофункциональн/, "мфу"], [/принтер/, "принтер"]
    ];
    return kinds.find(([pattern]) => pattern.test(name))?.[1] || name;
  }
  function priceKey(label) {
    const kind = priceKind(label);
    const size = kind === "панель" && diagonal(label);
    return size ? `панель ${size}` : kind;
  }
  function buildPriceIndex(group, market) {
    const prices = new Map();
    for (const row of market?.kinds || []) {
      const med = [row.med, row.usMed].find(value => Number.isFinite(value) && value > 0);
      if (med) prices.set(priceKey(row.kind), med);
    }
    const compRows = group ? [...(group.prices?.rows || []), group.prices?.kitsRow].filter(Boolean) : [];
    for (const row of compRows) {
      const med = [row.compWinner?.med, row.ourWinner?.med].find(value => Number.isFinite(value) && value > 0);
      if (med) prices.set(priceKey(row.label || row.kind), med);
    }
    return item => {
      let kind = priceKind(item.kind);
      if (item.kind === "МФУ и принтеры" || item.kind === "Компьютеры и системные блоки") {
        const type = priceKind(item.itemName);
        if (["мфу", "принтер", "компьютер", "системный блок"].includes(type)) kind = type;
        else if (item.truCode?.startsWith("262016")) kind = "принтер";
        else if (item.truCode?.startsWith("262040")) kind = "системный блок";
        else if (item.kind === "Компьютеры и системные блоки") kind = "компьютер";
      }
      const size = kind === "панель" && (diagonal(item.itemName) || diagonal(item.kind));
      return (size && prices.get(`панель ${size}`)) || prices.get(kind) ||
        (["компьютер", "моноблок"].includes(kind) && prices.get("компьютеры и моноблоки"));
    };
  }

  function lossTags(losses, customerBin) {
    const rivals = new Map();
    for (const loss of losses) append(rivals, loss.bin || normalizeName(loss.name), loss);
    const labels = [...rivals.values()].sort((a, b) => b.length - a.length).map(items => {
      const known = items.map(d => d.diff).filter(Number.isFinite);
      const average = known.length ? Math.round(known.reduce((sum, value) => sum + value, 0) / known.length) : null;
      return [items[0].name || items[0].bin, `${fmt(items.length)}×`, signedPct(average)].filter(Boolean).join(" · ");
    });
    if (!losses.length) return "";
    const title = label => `${esc(label)}. Процент — среднее отклонение цены победы от плана по известным ценам.`;
    if (!customerBin || !losses.some(d => validBin(d.customerBin) === customerBin)) {
      return `<span class="tag warn" title="${title(labels.join("; "))}">ранее забрал конкурент</span>`;
    }
    return labels.map(label => `<span class="tag warn" title="${title(label)}">забирал ${esc(label)}</span>`).join("");
  }

  window.__buildWinHintsIndex = function (payload, key) {
    const { plans, market, competitors } = payload || {};
    const { bought, lost } = buildCustomerIndices(plans, market, competitors);
    const findTemplate = buildTemplateIndex(competitors?.[key]);
    const findPrice = buildPriceIndex(competitors?.[key], market?.[key]);
    const cache = new WeakMap();
    return (item, unitPrice) => {
      if (cache.has(item)) return cache.get(item);
      const losses = lost.find(item.customerBin, item.customerName);
      const match = findTemplate(item);
      const winner = match?.template.winners?.[0];
      const template = match ? `<span class="tag warn"${match.historical ? ' title="Ранее найден у этого заказчика"' : ""}>Шаблон ТС: ${esc(match.template.templateName)}${winner ? ` · побеждал ${esc(winner.name)} (${esc(winner.sharePct)}%)` : ""}${match.strong ? " · сильное совпадение" : ""}</span>` : "";
      const customerTags = [
        bought.find(item.customerBin, item.customerName).length ? '<span class="tag good">покупал у нас</span>' : "",
        lossTags(losses, validBin(item.customerBin)), template
      ].join("");
      const median = findPrice(item);
      const status = unitPrice * 100 >= median * 115 ? "good" : unitPrice * 100 < median * 90 ? "bad" : "";
      const statusText = status === "good" ? "запас" : status === "bad" ? "низкая цена" : "";
      const result = {
        risk: Boolean(losses.length || match),
        customerHtml: customerTags ? `<span class="win-hints">${customerTags}</span>` : "",
        priceHtml: unitPrice > 0 && median > 0 ? `<span class="win-price ${status}">~${fmt(unitPrice)}/шт · победы ~${fmt(median)}${statusText ? ` · ${statusText}` : ""}</span>` : ""
      };
      cache.set(item, result);
      return result;
    };
  };

  function readTableState(key) {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { /* Хранилище может быть недоступно. */ }
    const filters = {};
    for (const field of Object.keys(filterLabels)) filters[field] = typeof saved?.filters?.[field] === "string" ? saved.filters[field] : "";
    return { filters, sort: ["sum", "month", "qty"].includes(saved?.sort) ? saved.sort : "sum",
      direction: saved?.direction === "asc" ? "asc" : "desc", limit: 50, quick: "all", storageKey: key, manualFilter: !!saved?.manualFilter, searchQuery: "", lastSyncedMe: typeof saved?.lastSyncedMe === "string" ? saved.lastSyncedMe : undefined };
  }
  function saveTableState(state) {
    try { sessionStorage.setItem(state.storageKey, JSON.stringify({ filters: state.filters, sort: state.sort, direction: state.direction, manualFilter: state.manualFilter, lastSyncedMe: state.lastSyncedMe })); }
    catch { /* Настройки продолжают работать в памяти. */ }
  }
  const quickLabels = {
    all: "Все", new: "Новая · ждёт разбора", former: "Ушедшие — переназначить",
    due: "Месяц наступил/прошёл", risk: "Риск ТС / конкурента"
  };

  function renderOpenPlans(base, el, active, state, asOfMonth) {
    const source = base.openPlans || [];
    let me = "";
    try { me = localStorage.getItem("pult-me") || ""; } catch {}
    if (state.lastSyncedMe !== me) {
      state.lastSyncedMe = me;
      state.manualFilter = false;
      state.filters.managerId = me && source.some(d => String(d.managerId) === me) ? me : "";
    } else if (me && !state.manualFilter && !state.filters.managerId && source.some(d => String(d.managerId) === me)) {
      state.filters.managerId = me;
    }
    const choicesByKey = new Map(Object.keys(filterLabels).map(key => [key,
      new Map(source.map(d => [String(d[key] ?? ""), key === "managerId" ? d.managerName : d[key]]).filter(([value]) => value))]));
    for (const key of Object.keys(filterLabels)) if (!choicesByKey.get(key).has(state.filters[key])) state.filters[key] = "";
    saveTableState(state);

    const hintsFor = d => state.winHintsIndex(d, d.price || (d.qty > 0 ? d.sum / d.qty : 0));
    const quickChecks = {
      all: () => true,
      new: d => d.isNewStage,
      former: d => d.isFormerManager,
      due: d => validMonth(d.month) && d.month <= asOfMonth,
      risk: d => hintsFor(d).risk
    };
    const sortHead = (key, label) => `<span role="columnheader" aria-sort="none"><button type="button" data-plan-sort="${key}" data-label="${label}">${label}</button></span>`;
    const open = el.querySelector(".plans-open");
    const filterHtml = Object.entries(filterLabels).map(([key, label]) => {
      const button = (value, name) => `<button type="button" data-plan-filter="${key}" data-value="${esc(value)}">${esc(name)}</button>`;
      return `<fieldset class="plan-filter-group"><legend>${label}</legend><div class="chips">${button("", "Все")}${[...choicesByKey.get(key)].sort((a, b) => String(a[1]).localeCompare(String(b[1]), "ru")).map(([value, name]) => button(value, name)).join("")}</div></fieldset>`;
    }).join("");
    const quickHtml = Object.keys(quickLabels).map(key => `<button type="button" data-plan-quick="${key}">${quickLabels[key]}</button>`).join("");
    open.innerHTML = `${head("05", "Открытые планы")}
      <div class="plan-search-wrap">
        <input type="search" class="plan-search-input" aria-label="Поиск по открытым планам" placeholder="Поиск по заказчику, БИН, номеру плана или товару…" value="${esc(state.searchQuery)}">
        <button type="button" class="btn" data-plan-copy>Скопировать выборку для чата</button>
        <span class="plan-copy-status" aria-live="polite"></span>
      </div>
      <div class="plan-quick-filters chips" role="group" aria-label="Быстрые фильтры действий">${quickHtml}</div>
      <div class="plan-filters" role="group" aria-label="Фильтры открытых планов">${filterHtml}</div>
      <div class="rows plans-table" role="table" aria-label="Открытые планы">
        <div class="r head" role="row">${sortHead("month", "Месяц")}<span role="columnheader">Заказчик</span><span role="columnheader">Товар / вид</span>${sortHead("qty", "Кол-во")}${sortHead("sum", "Сумма")}<span role="columnheader">Статус портала</span><span role="columnheader">Менеджер</span></div>
        <div role="rowgroup"></div>
      </div>
      <p class="muted" role="status" data-plan-empty hidden></p>
      <button type="button" class="btn plans-more" data-plan-more hidden>Показать ещё</button>`;

    const rows = open.querySelector('[role="rowgroup"]');
    const counter = open.querySelector(".block-head .meta");
    const empty = open.querySelector("[data-plan-empty]");
    const more = open.querySelector("[data-plan-more]");
    const copy = open.querySelector("[data-plan-copy]");
    const copyStatus = open.querySelector(".plan-copy-status");
    const quickButtons = [...open.querySelectorAll("[data-plan-quick]")];
    const filterButtons = [...open.querySelectorAll("[data-plan-filter]")];
    const sortButtons = [...open.querySelectorAll("[data-plan-sort]")];
    let matches = [];

    function updateControls() {
      for (const button of filterButtons) button.setAttribute("aria-pressed", String(state.filters[button.dataset.planFilter] === button.dataset.value));
      for (const button of sortButtons) {
        const selected = state.sort === button.dataset.planSort;
        button.dataset.direction = selected ? state.direction : "";
        button.textContent = button.dataset.label + (selected ? state.direction === "asc" ? " ↑" : " ↓" : " ↕");
        button.parentElement.setAttribute("aria-sort", selected ? state.direction === "asc" ? "ascending" : "descending" : "none");
      }
    }

    function updateResults() {
      const q = state.searchQuery.trim().toLowerCase();
      const eligible = source.filter(d => {
        if (active !== "all" && d.month !== active) return false;
        for (const key of Object.keys(filterLabels)) {
          if (state.filters[key] && String(d[key] ?? "") !== state.filters[key]) return false;
        }
        return !q || `${d.customerName || ""} ${d.customerBin || ""} ${d.planNumber || ""} ${d.id || ""} ${d.itemName || ""} ${d.truCode || ""} ${d.managerName || ""}`.toLowerCase().includes(q);
      });
      for (const button of quickButtons) {
        const key = button.dataset.planQuick;
        const count = key === "all" ? eligible.length : eligible.filter(quickChecks[key]).length;
        button.hidden = (key === "former" || key === "risk") && !count && state.quick !== key;
        button.textContent = key === "all" ? quickLabels[key] : `${quickLabels[key]} (${fmt(count)})`;
        button.setAttribute("aria-pressed", String(state.quick === key));
      }
      matches = eligible.filter(quickChecks[state.quick]);
      matches.sort((a, b) => {
        const cmp = state.sort === "month" ? String(a.month).localeCompare(String(b.month)) : (a[state.sort] || 0) - (b[state.sort] || 0);
        return (state.direction === "asc" ? cmp : -cmp) || String(a.id).localeCompare(String(b.id), "ru", { numeric: true });
      });
      rows.innerHTML = matches.slice(0, state.limit).map(d => {
        const hints = hintsFor(d);
        return `<div class="r" role="row" data-plan-id="${esc(d.id)}">
          <span role="cell">${esc(d.month)}<span class="sub">${link(d.dealUrl, `Сделка ${d.id} ↗`)} · ${link(d.planUrl, `План ${d.planNumber} ↗`)}</span></span>
          <span role="cell">${esc(d.customerName)}<span class="dim sub">${esc(d.customerBin)}</span>${hints.customerHtml}</span>
          <span role="cell">${esc(d.itemName)}<span class="dim sub">${[d.truCode, d.kind].filter(Boolean).map(esc).join(" · ")}</span></span>
          <span role="cell" data-label="Количество">${fmt(d.qty)} шт.</span>
          <span role="cell" class="num" data-label="Сумма">${money(d.sum)}${hints.priceHtml}</span>
          <span role="cell" data-label="Статус портала">${esc(d.portalStatus)}</span>
          <span role="cell" data-label="Менеджер">${esc(d.managerName)}${d.isNewStage ? '<span class="bad sub">Новая · ждёт разбора</span>' : ""}${d.isFormerManager ? '<span class="bad sub">Ушедший · переназначить</span>' : ""}</span>
        </div>`;
      }).join("");
      counter.textContent = `Показано ${fmt(Math.min(state.limit, matches.length))} из ${fmt(matches.length)}`;
      empty.hidden = matches.length > 0;
      if (!empty.hidden) empty.textContent = Object.values(state.filters).some(Boolean) || q || state.quick !== "all"
        ? "Ничего не найдено. Измените фильтры или месяц." : "Открытых планов нет";
      more.hidden = matches.length <= state.limit;
      copy.disabled = !matches.length;
      copyStatus.textContent = "";
    }

    const search = open.querySelector(".plan-search-input");
    search.addEventListener("input", () => {
      state.searchQuery = search.value;
      state.limit = 50;
      updateResults();
    });
    copy.addEventListener("click", async () => {
      const selection = matches.slice(0, 15);
      const text = selection.map(d => `${d.customerName} · ${d.itemName} · ${fmt(d.sum)} ₸${d.dealUrl ? ` · ${d.dealUrl}` : ""}`).join("\n");
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch { /* Попробуем запасной способ через выделение. */ }
      }
      if (!copied) {
        const field = document.createElement("textarea");
        field.value = text;
        field.readOnly = true;
        field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.append(field);
        field.select();
        try { copied = document.execCommand("copy"); } catch { /* Игнорируем отказ браузера. */ }
        field.remove();
        copy.focus({ preventScroll: true });
      }
      copyStatus.textContent = copied ? `Скопировано: ${fmt(selection.length)}` : "Не удалось скопировать выборку";
    });
    open.onclick = event => {
      const button = event.target.closest("button");
      if (!button) return;
      const previousLimit = state.limit;
      if (button.dataset.planFilter) {
        state.filters[button.dataset.planFilter] = button.dataset.value;
        state.manualFilter = true;
        state.limit = 50;
      } else if (button.dataset.planQuick) {
        state.quick = button.dataset.planQuick;
        state.limit = 50;
      } else if (button === more) state.limit += 50;
      else if (button.dataset.planSort) {
        const key = button.dataset.planSort;
        state.direction = state.sort === key && state.direction === "desc" ? "asc" : "desc";
        state.sort = key;
        state.limit = 50;
      } else return;
      saveTableState(state);
      updateControls();
      updateResults();
      if (button.dataset.planFilter) {
        const offset = (document.querySelector(".bar")?.getBoundingClientRect().height || 0) + (document.querySelector(".dateline")?.getBoundingClientRect().height || 0) + 16;
        const target = window.matchMedia("(max-width: 760px)").matches ? open.querySelector(".plan-quick-filters") : open;
        window.scrollTo({ top: scrollY + target.getBoundingClientRect().top - offset, behavior: "instant" });
      } else if (button === more) {
        rows.children[previousLimit]?.querySelector("a")?.focus({ preventScroll: true });
      }
    };
    updateControls();
    updateResults();
    open.querySelectorAll(".plan-filter-group .chips").forEach(window.__scrollPlanSelection);
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
      return `<span class="rk">${fmt(i + 1)}</span><span class="nm"><span>${esc(m.name)}</span></span><span class="plan-win-share" data-l="доля побед">${m.wonCount + m.lostCount < WIN_SHARE_MIN_DECIDED ? "мало итогов" : `<span class="hbar"><span style="width:${esc(share)}%"></span></span><span>${fmt(share)}%</span>`}</span><span class="plan-win-counts" data-l="Выиграл / Проиграл"><span class="plan-win-desktop">${fmt(m.wonCount)} / ${fmt(m.lostCount)}</span><span class="plan-win-mobile">выиграл ${fmt(m.wonCount)} · проиграл ${fmt(m.lostCount)}</span></span><span class="num" data-l="Сумма">${money(m.sum)}</span><span class="num" data-l="Шт. / В работе / Новых">${fmt(m.count)} / ${fmt(m.openCount)} / <b class="${m.newCount ? "bad" : ""}">${fmt(m.newCount)}</b></span>`;
    };
    // Закупки ушедших сотрудников остаются в итогах, но своей строки в таблице не получают.
    const F = V.formerManagers;
    const formerNote = F ? `<p class="note-src plan-former">Ушедшие сотрудники в таблице не показаны (${fmt(F.people)} чел.): ${plural(F.count, ["закупка", "закупки", "закупок"])} на ${money(F.sum)}, из них ${F.openCount ? `<b class="bad">в работе ${fmt(F.openCount)}</b> на ${money(F.openSum)}` : "в работе нет"}. В итогах страницы они учтены.</p>` : "";
    const maxMonth = Math.max(1, ...base.months.map(m => m.sum));
    const monthAttrs = m => `data-m="${esc(m.m)}" role="button" tabindex="0" aria-label="${esc(monthName(m.m))}" aria-current="${m.m === active}"`;
    el.innerHTML = `
      <section class="block plans-summary" data-slice="${active}">
        ${head("01", `Планы ${title} · ${esc(monthName(active))}`)}
        <div class="hero"><div>
          <span class="label">Общая сумма собранных планов</span>
          <div class="hero-num"><span class="big">${mln(total.sum)}</span><span class="of">млн ₸</span></div>
          <p data-plan-count="${total.count}">${fmt(total.count)} пунктов · ${fmt(total.customers)} заказчиков</p>
          <p class="plans-summary-actions"><button type="button" class="btn plans-find-open" data-plan-find-open>Найти открытый план</button></p>
          <div class="readout">${metric("В работе", total.openSum, total.openCount)}${metric('Ждут разбора (стадия «Новая»)', total.newSum, total.newCount, total.newCount ? "bad" : "")}${metric("Опубликовано / Договор", total.publishedSum, total.publishedCount)}</div>
          <div class="readout plans-outcomes">${metric("Забрали мы (F3 + партнёр)", total.wonSum, total.wonCount)}${metric("Ушло конкурентам", total.lostSum, total.lostCount)}${totalWinShare}${metric("Отменено / изменено", total.cancelledSum, total.cancelledCount)}${metric("Новые за 7 дней", total.createdLast7dSum, total.createdLast7dCount)}</div>
        </div><div class="share rows"><h3>По менеджерам</h3>
          <div class="r head"><span>Место</span><span>Менеджер</span><span>Доля побед</span><span>Выиграл / Проиграл</span><span>Сумма</span><span>Шт. / В работе / Новых</span></div>
          ${V.managers.map((m, i) => m.planList.length ? `<details class="cust-d"><summary class="r">${managerCells(m, i)}</summary>${list(m.planList)}</details>` : `<div class="r">${managerCells(m, i)}</div>`).join("") || '<p class="muted">Планов нет</p>'}
          ${formerNote}<p class="note-src">Доля побед — выигранные (F3 и партнёр) из закупок с известным итогом; показывается от 10 итогов</p>
        </div></div>
      </section>
      <section class="block plans-months">${head("02", "По планируемым месяцам", "Тёмная часть: в работе + выигранные нами")}
        <div class="months">${base.months.map(m => `<div class="col" ${monthAttrs(m)} title="${esc(monthName(m.m))}: ${money(m.sum)}, ${fmt(m.count)} планов"><div class="tot" style="height:${Math.max(0, m.sum / maxMonth * 100)}%"><span class="lab">${mln(m.sum)}</span><div class="our" style="height:${m.sum > 0 ? Math.max(0, Math.min(100, m.activeSum / m.sum * 100)) : 0}%"></div></div></div>`).join("")}</div>
        <div class="mlabels">${base.months.map(m => `<span ${monthAttrs(m)}>${esc(m.m)}</span>`).join("")}</div>
      </section>
      <section class="block plans-breakdown" data-slice="${active}">${head("03", "Способы закупки и товары")}
        <div class="two"><div class="meth rows"><h3>Способы закупки</h3><div class="r head"><span>Способ</span><span>Планов</span><span>Объём</span><span>Сумма</span><span>В работе</span></div>
          ${V.methods.map(m => `<div class="r"><span>${esc(m.name)}</span><span data-l="Планов">${fmt(m.count)}</span><div data-l="Объём">${bar(m.sum, total.sum)}</div><span class="num" data-l="Сумма">${money(m.sum)}</span><span data-l="В работе">${fmt(m.openCount)}</span></div>`).join("")}
        </div><div><h3>Виды товаров</h3><div class="rows plans-kinds"><div class="r head"><span>Вид</span><span>Шт.</span><span>Средняя цена</span><span>Сумма</span></div>
          ${V.kinds.map(k => `<div class="r"><span>${esc(k.kind)}</span><span data-l="Шт.">${fmt(k.qty)}</span><span data-l="Средняя цена">${fmt(k.avgPrice)} ₸</span><span class="num" data-l="Сумма">${money(k.sum)}</span></div>`).join("")}</div>
          <h3>Статусы на портале</h3><div class="rows plans-statuses">${V.statuses.map(s => `<div class="r"><span>${esc(s.status)}</span><span data-l="Планов">${fmt(s.count)} шт.</span><span class="num" data-l="Сумма">${money(s.sum)}</span></div>`).join("")}</div>
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
    const payload = typeof PAYLOAD === "undefined" ? {} : PAYLOAD;
    if (state.plans !== PLANS) {
      state.plans = PLANS;
      state.winHintsIndex = window.__buildWinHintsIndex({ ...payload, plans: PLANS }, stateKey === "plans-ip" ? "ip" : "kt");
    }
    const asOfMonth = String(PLANS.asOf || payload.asOfDate || "").slice(0, 7);
    renderOpenPlans(base, el, active, state, asOfMonth);
    const findOpenBtn = el.querySelector("[data-plan-find-open]");
    if (findOpenBtn) {
      findOpenBtn.addEventListener("click", () => {
        const openSection = el.querySelector(".plans-open");
        const input = el.querySelector(".plan-search-input");
        const target = openSection || input;
        if (target) {
          const barH = document.querySelector(".bar")?.getBoundingClientRect().height || 0;
          const dateH = document.querySelector(".dateline")?.getBoundingClientRect().height || 0;
          const offset = barH + dateH + 16;
          window.scrollTo({
            top: Math.max(0, window.scrollY + target.getBoundingClientRect().top - offset),
            behavior: "instant"
          });
        }
        if (input) input.focus({ preventScroll: true });
      });
    }
  };
})();
