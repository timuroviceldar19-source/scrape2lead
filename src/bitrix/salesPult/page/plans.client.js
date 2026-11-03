(function () {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n || 0);
  const mln = n => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format((n || 0) / 1e6);
  const money = n => `${mln(n)} млн ₸`;
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
  const list = plans => `<div class="cust-list rows">${plans.map(d => `<div class="r plan-list-row"><span>${esc(d.month)}</span><span>${link(d.dealUrl, d.planNumber || d.id)} · ${esc(d.customerName)}<span class="dim sub">${esc(d.itemName)}</span></span><span>${fmt(d.qty)} шт.</span><span class="num">${money(d.sum)} · ${link(d.planUrl, "План ↗")}</span></div>`).join("")}</div>`;

  window.__renderPlansTab = function (key, PLANS, el, selectedMonth) {
    if (!el) return;
    const base = key === "plans-ip" || key === "ИП" ? PLANS?.ip : PLANS?.kt;
    const V = window.__planViewForMonth(base, selectedMonth);
    if (!V) { el.innerHTML = `<section class="block"><p class="lead">${esc(PLANS?.error || "Данные планов ещё собираются.")}</p></section>`; return; }
    const active = window.__planMonths(base).includes(selectedMonth) ? selectedMonth : "all";
    const total = V.total;
    const title = key === "plans-ip" || key === "ИП" ? "интерактивных панелей" : "компьютерной техники";
    const metric = (label, amount, count, cls = "") => `<div class="${cls}"><span class="label">${label}</span><div class="v">${money(amount)}<small> · ${fmt(count)} шт.</small></div></div>`;
    const managerCells = (m, i) => `<span class="rk">${i + 1}</span><span class="nm"><span>${esc(m.name)}</span></span>${bar(m.sum, V.managers[0]?.sum)}<span class="num">${money(m.sum)}</span><span class="num">${fmt(m.count)} / ${fmt(m.openCount)} / <b class="${m.newCount ? "bad" : ""}">${fmt(m.newCount)}</b></span>`;
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
          <div class="readout plans-outcomes">${metric("Забрали мы (F3 + партнёр)", total.wonSum, total.wonCount)}${metric("Ушло конкурентам", total.lostSum, total.lostCount)}${metric("Отменено / изменено", total.cancelledSum, total.cancelledCount)}${metric("Новые за 7 дней", total.createdLast7dSum, total.createdLast7dCount)}</div>
        </div><div class="share rows"><h3>По менеджерам</h3>
          <div class="r head"><span>Место</span><span>Менеджер</span><span>Объём планов</span><span>Сумма</span><span>Шт. / В работе / Новых</span></div>
          ${V.managers.map((m, i) => m.planList.length ? `<details class="cust-d"><summary class="r">${managerCells(m, i)}</summary>${list(m.planList)}</details>` : `<div class="r">${managerCells(m, i)}</div>`).join("") || '<p class="muted">Планов нет</p>'}
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
      <section class="block plans-open" data-slice="${active}">${head("04", "Крупнейшие открытые планы", "Топ-20 в работе")}
        <div class="rows plans-table"><div class="r head"><span>Планируемый месяц</span><span>Заказчик</span><span>Товар / вид</span><span>Шт.</span><span>Сумма</span><span>Статус портала</span><span>Менеджер</span></div>
          ${V.topOpenPlans.map(d => `<div class="r"><span>${esc(d.month)}<span class="sub">${link(d.dealUrl, `Сделка ${d.id} ↗`)} · ${link(d.planUrl, `План ${d.planNumber} ↗`)}</span></span><span>${esc(d.customerName)}<span class="dim sub">${esc(d.customerBin)}</span></span><span>${esc(d.itemName)}<span class="dim sub">${esc(d.truCode)} · ${esc(d.kind)}</span></span><span>${fmt(d.qty)}</span><span class="num">${money(d.sum)}</span><span>${esc(d.portalStatus)}</span><span>${esc(d.managerName)}${d.isNewStage ? '<span class="bad sub">Новая · ждёт разбора</span>' : ""}</span></div>`).join("") || '<p class="muted">Открытых планов нет</p>'}
        </div>
      </section>
      <section class="block plans-customers" data-slice="${active}">${head("05", "Крупнейшие заказчики по планам", "Топ-15")}
        <div class="cust rows"><div class="r head"><span>Заказчик / БИН</span><span>Сумма планов</span><span>Пунктов</span><span>В работе</span></div>
          ${V.customers.map(c => `<details class="cust-d"><summary class="r"><span class="cust">${esc(c.name)}<span class="dim sub">${esc(c.bin)}</span></span><span class="num">${money(c.sum)}</span><span>${fmt(c.count)}</span><span>${money(c.openSum)} · ${fmt(c.openCount)} шт.${bar(c.openSum, c.sum, "ink")}</span></summary>${list(c.planList)}</details>`).join("")}
        </div>
      </section>`;
  };
})();
