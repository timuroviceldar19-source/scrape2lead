// Страница «Фин. отчёты»: ОПиУ по годам и месяцам с 1- и 2-уровневой расшифровкой статей.
(function () {
  "use strict";

  const P = typeof PAYLOAD !== "undefined" ? PAYLOAD : {};
  const O = P.opiu || {};
  const R = O.report;
  const el = document.getElementById("tab-fin-reports");

  const MONTHS_SHORT = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
  const NB = String.fromCharCode(160);
  const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sign = (n) => (n < 0 ? "−" : "");
  const plural = (n, f) => {
    const a = Math.abs(n) % 100, b = a % 10;
    return `${nf0.format(n)} ${a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b > 1 && b < 5 ? f[1] : f[2]}`;
  };

  function amt(n) {
    const a = Math.abs(n || 0);
    if (a >= 1e9) return `${sign(n)}${nf1.format(a / 1e9)}${NB}млрд`;
    if (a >= 1e6) return `${sign(n)}${nf1.format(a / 1e6)}${NB}млн`;
    if (a >= 1e3) return `${sign(n)}${nf0.format(Math.round(a / 1e3))}${NB}тыс`;
    return `${sign(n)}${nf0.format(Math.round(a))}`;
  }
  const money = (n) => `${amt(n)}${NB}₸`;
  const fullMoney = (n) => `${sign(n)}${nf0.format(Math.round(Math.abs(n || 0)))}${NB}₸`;
  const pct = (n) => `${sign(n)}${nf1.format(Math.abs(n || 0) * 100)}%`;
  const big = (n) => {
    const formatted = amt(n);
    const unit = (formatted.match(/(млн|млрд|тыс)$/) || [""])[0];
    return `${unit ? formatted.slice(0, -unit.length - 1) : formatted}<small> ${unit}${NB}₸</small>`;
  };
  const almaty = (iso) => {
    const ms = Date.parse(iso || "");
    if (Number.isNaN(ms)) return "";
    const d = new Date(ms + 5 * 3600000).toISOString();
    return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)}`;
  };
  const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").trim();

  // Состояние интерфейса
  let viewMode = "years"; // "years" | "YYYY" (помесячно за выбранный год)
  const openSections = new Set(); // ключи раскрытых строк ОПиУ (например "013", "014")
  const openGroups = new Set();   // `${sectionKey}::${groupIndex}` — раскрытые жирные группы 2-го уровня
  const sectionQuery = new Map(); // поиск внутри конкретной расшифровки
  const sectionShowAll = new Set(); // показать все строки расшифровки (> 30)

  const DEFAULT_LIMIT = 30;

  function setLabels() {
    const dateLabel = document.getElementById("dateLabel");
    const srcLabel = document.getElementById("srcLabel");
    const liveText = document.getElementById("liveText");
    if (liveText && P.generatedAt) liveText.textContent = P.generatedAt;
    if (!R) return;
    if (dateLabel) {
      const span = R.years.length > 1 ? `${R.years[0].year}–${R.years[R.years.length - 1].year} (${R.periodLabel})` : R.periodLabel;
      dateLabel.textContent = `ОПиУ · ${span}${R.unitLabel ? ` · ${R.unitLabel}` : ""}`;
    }
    if (srcLabel && O.file) srcLabel.textContent = `${O.file.name} · загружен ${almaty(O.file.uploadedAt)}`;
    const foot = document.getElementById("footSource");
    if (foot && O.file) {
      foot.textContent = `Источник: «${O.file.name}» из чата «Финансовый отчет» Битрикс24, загружен ${almaty(O.file.uploadedAt)}`;
    }
  }

  /** Возвращает описание видимых числовых колонок для текущего режима. */
  function activeColumns() {
    if (viewMode === "years") {
      return R.years.map((y, idx) => ({
        key: `y:${idx}`,
        label: y.label,
        isTotal: idx === R.years.length - 1,
        readRow: (row) => row.years[idx],
        readItem: (item) => item.years[idx] || 0
      }));
    }
    const yrIdx = R.years.findIndex((y) => y.year === viewMode);
    const yr = yrIdx >= 0 ? R.years[yrIdx] : R.years[R.years.length - 1];
    const cols = yr.months.map((ym) => {
      const mIdx = Number(ym.slice(5, 7)) - 1;
      return {
        key: `m:${ym}`,
        label: MONTHS_SHORT[mIdx] || ym,
        isTotal: false,
        readRow: (row) => (row.months && ym in row.months ? row.months[ym] : null),
        readItem: (item) => (item.months && item.months[ym] ? item.months[ym] : 0)
      };
    });
    cols.push({
      key: `yt:${yrIdx}`,
      label: yr.label,
      isTotal: true,
      readRow: (row) => row.years[yrIdx],
      readItem: (item) => item.years[yrIdx] || 0
    });
    return cols;
  }

  function findRow(code) {
    return R.rows.find((r) => r.code === code);
  }

  function renderSummary() {
    const yrIdx = viewMode === "years"
      ? R.years.length - 1
      : Math.max(0, R.years.findIndex((y) => y.year === viewMode));
    const yr = R.years[yrIdx];
    const prevIdx = yrIdx > 0 ? yrIdx - 1 : -1;
    const prevYr = prevIdx >= 0 ? R.years[prevIdx] : null;

    const revRow = findRow("010");
    const grossRow = findRow("012");
    const opRow = findRow("020");
    const netRow = findRow("300") || findRow("200") || findRow("500");
    const marginRow = R.rows.find((r) => norm(r.label) === "маржа");
    const markupRow = R.rows.find((r) => norm(r.label) === "наценка");
    const opMarginRow = R.rows.find((r) => norm(r.label).startsWith("рентабельность операционной"));
    const rosRow = R.rows.find((r) => norm(r.label) === "ros");

    const val = (row, idx) => (row && idx >= 0 && row.years[idx] != null ? row.years[idx] : 0);
    const rev = val(revRow, yrIdx);
    const gross = val(grossRow, yrIdx);
    const op = val(opRow, yrIdx);
    const net = val(netRow, yrIdx);

    const prevNote = (row) => {
      if (!prevYr || !row) return "";
      const pv = val(row, prevIdx);
      return `${esc(prevYr.label)}: <b>${money(pv)}</b>`;
    };

    const marginVal = marginRow && marginRow.years[yrIdx] != null ? marginRow.years[yrIdx] : (rev ? gross / rev : null);
    const markupVal = markupRow && markupRow.years[yrIdx] != null ? markupRow.years[yrIdx] : null;
    const opMarginVal = opMarginRow && opMarginRow.years[yrIdx] != null ? opMarginRow.years[yrIdx] : (rev ? op / rev : null);
    const rosVal = rosRow && rosRow.years[yrIdx] != null ? rosRow.years[yrIdx] : (rev ? net / rev : null);

    const tileHtml = (label, value, sub, bad) =>
      `<div class="fr-tile${bad ? " is-bad" : ""}"><span class="label">${label}</span><div class="v">${big(value)}</div><div class="sub">${sub}</div></div>`;

    return `<section class="block" id="fr-summary">
      <div class="block-head"><h2><span class="idx">01</span>Ключевые показатели · ${esc(yr.label)}</h2><span class="meta">${esc(R.organization || "ОПиУ")}${R.unitLabel ? ` · ${esc(R.unitLabel)}` : ""}</span></div>
      <div class="fr-tiles">
        ${tileHtml("Выручка", rev, prevNote(revRow) || "строка 010", false)}
        ${tileHtml("Валовая прибыль", gross, `${marginVal != null ? `маржа <b>${pct(marginVal)}</b>` : ""}${markupVal != null ? ` · наценка <b>${pct(markupVal)}</b>` : ""}${prevYr ? `<br>${prevNote(grossRow)}` : ""}`, gross < 0)}
        ${tileHtml("Операционная прибыль", op, `${opMarginVal != null ? `рентабельность <b class="${opMarginVal < 0 ? "bad" : ""}">${pct(opMarginVal)}</b>` : ""}${prevYr ? `<br>${prevNote(opRow)}` : ""}`, op < 0)}
        ${tileHtml("Чистая прибыль", net, `${rosVal != null ? `ROS <b class="${rosVal < 0 ? "bad" : ""}">${pct(rosVal)}</b>` : ""}${prevYr ? `<br>${prevNote(netRow)}` : ""}`, net < 0)}
      </div>
    </section>`;
  }

  function formatCell(value, isPercent, isTotalCol) {
    const cls = ["num"];
    if (isTotalCol) cls.push("total-col");
    if (value == null || (isPercent ? Math.abs(value) < 0.00005 : Math.abs(value) < 0.5)) {
      cls.push("zero");
      return `<td class="${cls.join(" ")}">—</td>`;
    }
    if (value < 0) cls.push("bad");
    const display = isPercent ? pct(value) : amt(value);
    const tip = isPercent ? pct(value) : fullMoney(value);
    return `<td class="${cls.join(" ")}" title="${esc(tip)}">${esc(display)}</td>`;
  }

  function itemSortWeight(item, cols) {
    const last = cols[cols.length - 1];
    return Math.abs(last ? last.readItem(item) : 0);
  }

  function itemHasNonZero(item, cols) {
    return cols.some((c) => Math.abs(c.readItem(item)) >= 0.5);
  }

  function renderBreakdownRows(row, cols) {
    const sec = R.breakdowns[row.breakdownKey];
    if (!sec) return "";
    const colSpan = cols.length + 1;
    const rawQuery = sectionQuery.get(sec.key) || "";
    const words = norm(rawQuery).split(/\s+/).filter(Boolean);
    const matches = (label) => {
      if (!words.length) return true;
      const hay = norm(label);
      return words.every((w) => hay.includes(w));
    };

    // Фильтруем по ненулевым значениям в текущем периоде и по поисковой строке
    const prepared = [];
    for (let origIdx = 0; origIdx < sec.items.length; origIdx++) {
      const item = sec.items[origIdx];
      const visibleChildren = item.children
        ? item.children
            .map((ch, cIdx) => ({ ch, cIdx }))
            .filter(({ ch }) => itemHasNonZero(ch, cols))
        : null;
      const selfVisible = itemHasNonZero(item, cols) || (visibleChildren && visibleChildren.length > 0);
      if (!selfVisible) continue;

      if (words.length) {
        const selfMatch = matches(item.label);
        if (visibleChildren) {
          const matchingKids = selfMatch ? visibleChildren : visibleChildren.filter(({ ch }) => matches(ch.label));
          if (!selfMatch && matchingKids.length === 0) continue;
          prepared.push({ item, origIdx, children: matchingKids, autoOpen: !selfMatch && matchingKids.length > 0 });
        } else {
          if (!selfMatch) continue;
          prepared.push({ item, origIdx, children: null, autoOpen: false });
        }
      } else {
        prepared.push({ item, origIdx, children: visibleChildren, autoOpen: false });
      }
    }

    prepared.sort((a, b) => itemSortWeight(b.item, cols) - itemSortWeight(a.item, cols));
    const showAll = sectionShowAll.has(sec.key) || words.length > 0 || prepared.length <= DEFAULT_LIMIT + 10;
    const shown = showAll ? prepared : prepared.slice(0, DEFAULT_LIMIT);
    const hiddenCount = prepared.length - shown.length;

    let html = `<tr class="fr-bd-bar" data-bd-bar="${esc(sec.key)}"><td colspan="${colSpan}">
      <div class="fr-bd-controls">
        <input type="search" class="fr-bd-search" data-bd-search="${esc(sec.key)}" value="${esc(rawQuery)}" placeholder="${sec.hasGroups ? "Поиск по статье или контрагенту…" : "Поиск по расшифровке…"}" aria-label="Поиск по расшифровке ${esc(row.label)}">
        <span class="fr-bd-meta">${plural(prepared.length, sec.hasGroups ? ["статья", "статьи", "статей"] : ["позиция", "позиции", "позиций"])}${sec.hasGroups ? " · нажмите на строку для раскрытия" : ""}</span>
      </div>
    </td></tr>`;

    if (!shown.length) {
      html += `<tr><td colspan="${colSpan}" class="fr-empty">${words.length ? "Ничего не найдено по запросу." : "Нет сумм за выбранный период."}</td></tr>`;
      return html;
    }

    for (const entry of shown) {
      const { item, origIdx, children, autoOpen } = entry;
      const hasKids = Boolean(children && children.length > 0);
      const groupKey = `${sec.key}::${origIdx}`;
      const isGroupOpen = hasKids && (autoOpen || openGroups.has(groupKey));

      const cells = cols.map((c) => formatCell(c.readItem(item), false, c.isTotal)).join("");
      if (hasKids) {
        html += `<tr class="fr-lvl1 is-group" data-group-toggle="${esc(groupKey)}">
          <td>
            <button type="button" class="fr-toggle" data-group-toggle="${esc(groupKey)}" aria-expanded="${isGroupOpen ? "true" : "false"}">
              <span class="fr-chev" aria-hidden="true">▸</span>
              <span>${esc(item.label)}<span class="fr-pill">${children.length}</span></span>
            </button>
          </td>
          ${cells}
        </tr>`;
        if (isGroupOpen) {
          const sortedKids = [...children].sort((a, b) => itemSortWeight(b.ch, cols) - itemSortWeight(a.ch, cols));
          for (const { ch } of sortedKids) {
            const kCells = cols.map((c) => formatCell(c.readItem(ch), false, c.isTotal)).join("");
            html += `<tr class="fr-lvl2"><td>${esc(ch.label)}</td>${kCells}</tr>`;
          }
        }
      } else {
        html += `<tr class="fr-lvl1"><td>${esc(item.label)}</td>${cells}</tr>`;
      }
    }

    if (hiddenCount > 0) {
      html += `<tr class="fr-bd-more"><td colspan="${colSpan}"><button type="button" class="btn" data-bd-all="${esc(sec.key)}">Показать все ${prepared.length} (ещё ${hiddenCount})</button></td></tr>`;
    } else if (sectionShowAll.has(sec.key) && prepared.length > DEFAULT_LIMIT + 10) {
      html += `<tr class="fr-bd-more"><td colspan="${colSpan}"><button type="button" class="btn" data-bd-all="${esc(sec.key)}">Свернуть до топ-${DEFAULT_LIMIT}</button></td></tr>`;
    }

    return html;
  }

  function renderTable() {
    const cols = activeColumns();
    const yearsDesc = [...R.years].reverse();
    const hasOpen = openSections.size > 0;

    let chips = `<div class="chips" role="group" aria-label="Период ОПиУ">
      <button type="button" data-fr-mode="years" aria-pressed="${viewMode === "years" ? "true" : "false"}">По годам</button>
      ${yearsDesc.filter((y) => y.months.length > 0).map((y) =>
        `<button type="button" data-fr-mode="${esc(y.year)}" aria-pressed="${viewMode === y.year ? "true" : "false"}">${esc(y.year)} по мес.</button>`
      ).join("")}
    </div>`;

    let tbody = "";
    for (const row of R.rows) {
      const hasBreakdown = Boolean(row.breakdownKey && R.breakdowns[row.breakdownKey]);
      const isOpen = hasBreakdown && openSections.has(row.breakdownKey);
      const sec = hasBreakdown ? R.breakdowns[row.breakdownKey] : null;
      const cls = ["fr-row"];
      if (row.isBold) cls.push("is-bold");
      if (row.isPercent) cls.push("is-pct");
      if (hasBreakdown) cls.push("is-expandable");

      const codeBadge = /^\d{3}$/.test(row.code) ? `<span class="fr-code">${esc(row.code)}</span>` : "";
      const activeCount = sec ? sec.items.filter((it) => itemHasNonZero(it, cols)).length : 0;
      const countBadge = hasBreakdown && activeCount > 0 ? `<span class="fr-pill">${activeCount}</span>` : "";

      const firstCell = hasBreakdown
        ? `<button type="button" class="fr-toggle" data-sec-toggle="${esc(row.breakdownKey)}" aria-expanded="${isOpen ? "true" : "false"}">
            <span class="fr-chev" aria-hidden="true">▸</span>
            <span>${codeBadge}${esc(row.label)}${countBadge}</span>
          </button>`
        : `${codeBadge}${esc(row.label)}`;

      const cells = cols.map((c) => formatCell(c.readRow(row), row.isPercent, c.isTotal)).join("");
      tbody += `<tr class="${cls.join(" ")}"${hasBreakdown ? ` data-sec-row="${esc(row.breakdownKey)}"` : ""}><td>${firstCell}</td>${cells}</tr>`;
      if (isOpen) tbody += renderBreakdownRows(row, cols);
    }

    return `<section class="block" id="fr-opiu">
      <div class="block-head">
        <h2><span class="idx">02</span>Отчёт о прибылях и убытках (ОПиУ)</h2>
        <span class="meta">нажмите на строку со стрелкой ▸ для расшифровки</span>
      </div>
      <div class="fr-toolbar">
        ${chips}
        <div class="fr-toolbar-actions">
          ${hasOpen ? `<button type="button" class="btn" id="frCollapseAll">Свернуть расшифровки</button>` : ""}
        </div>
      </div>
      <div class="fr-table-wrap">
        <table class="fr-table">
          <thead>
            <tr>
              <th>Показатель</th>
              ${cols.map((c) => `<th${c.isTotal ? ' class="total-col"' : ""}>${esc(c.label)}</th>`).join("")}
            </tr>
          </thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    </section>`;
  }

  function render() {
    if (!el) return;
    if (!R) {
      el.innerHTML = `<section class="block"><p class="lead">${esc(O.error || "Финансовый отчёт (ОПиУ) пока не загружен. Положите файл с листом «ОПиУ» в чат «Финансовый отчет» Битрикс24.")}</p>${O.notice ? `<div class="note-warn">${esc(O.notice)}</div>` : ""}</section>`;
      return;
    }
    let html = "";
    if (O.notice) html += `<div class="note-warn">${esc(O.notice)}</div>`;
    if (R.warnings && R.warnings.length) {
      html += `<section class="block" id="f-warnings"><div class="note-warn">Сверка расшифровки ОПиУ: ${R.warnings.map(esc).join("; ")}.</div></section>`;
    }
    html += renderSummary() + renderTable();
    el.innerHTML = html;
  }

  function rerenderTablePreservingFocus(selector, selectionStart) {
    const host = document.getElementById("fr-opiu");
    if (!host) {
      render();
      return;
    }
    const wrap = host.querySelector(".fr-table-wrap");
    const scrollLeft = wrap ? wrap.scrollLeft : 0;
    const temp = document.createElement("div");
    temp.innerHTML = renderTable();
    host.replaceWith(temp.firstElementChild);
    const nextWrap = document.querySelector("#fr-opiu .fr-table-wrap");
    if (nextWrap) nextWrap.scrollLeft = scrollLeft;
    if (selector) {
      const target = document.querySelector(selector);
      if (target) {
        target.focus({ preventScroll: true });
        if (typeof selectionStart === "number" && "setSelectionRange" in target) {
          target.setSelectionRange(selectionStart, selectionStart);
        }
      }
    }
  }

  el?.addEventListener("click", (e) => {
    const modeBtn = e.target.closest("[data-fr-mode]");
    if (modeBtn) {
      viewMode = modeBtn.dataset.frMode;
      render();
      document.querySelector(`[data-fr-mode="${CSS.escape(viewMode)}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (e.target.closest("#frCollapseAll")) {
      openSections.clear();
      openGroups.clear();
      rerenderTablePreservingFocus();
      return;
    }
    const showAllBtn = e.target.closest("[data-bd-all]");
    if (showAllBtn) {
      const key = showAllBtn.dataset.bdAll;
      if (sectionShowAll.has(key)) sectionShowAll.delete(key);
      else sectionShowAll.add(key);
      rerenderTablePreservingFocus(`[data-bd-all="${CSS.escape(key)}"]`);
      return;
    }
    const groupToggle = e.target.closest("[data-group-toggle]");
    if (groupToggle) {
      const gk = groupToggle.dataset.groupToggle;
      if (openGroups.has(gk)) openGroups.delete(gk);
      else openGroups.add(gk);
      rerenderTablePreservingFocus(`button[data-group-toggle="${CSS.escape(gk)}"]`);
      return;
    }
    const secToggle = e.target.closest("[data-sec-toggle], [data-sec-row]");
    if (secToggle) {
      const key = secToggle.dataset.secToggle || secToggle.dataset.secRow;
      if (openSections.has(key)) openSections.delete(key);
      else openSections.add(key);
      rerenderTablePreservingFocus(`button[data-sec-toggle="${CSS.escape(key)}"]`);
    }
  });

  el?.addEventListener("input", (e) => {
    const input = e.target.closest("[data-bd-search]");
    if (!input) return;
    const key = input.dataset.bdSearch;
    sectionQuery.set(key, input.value);
    rerenderTablePreservingFocus(`input[data-bd-search="${CSS.escape(key)}"]`, input.selectionStart);
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
