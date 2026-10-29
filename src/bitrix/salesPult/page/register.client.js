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
        <div><span class="label">Вал</span><div class="v">${mln(T.val)}<small> млн · ${pct(T.sale ? T.val / T.sale : 0)}</small></div></div>
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
    s += `<div class="r body" role="button" tabindex="0" aria-expanded="false" data-m="${esc(m.name)}">
      <div class="who"><span class="mono-av">${initials(m.name)}</span><div><div class="nm">${esc(m.name)}</div><div class="rl">${m.plan ? `план ${mln(m.plan)} млн` : "без плана"}</div></div></div>
      <div><div class="top"><span class="num">${mln(m.sale)}</span><span class="of">млн${m.plan ? ` · ${pct(p)}` : ""}</span></div>${bar(m.plan ? p * 100 / 3 : 0, cls, m.plan ? 100 / 3 : null)}</div>
      <div><span class="num">${mln(m.val)}</span> <span class="dim">млн · ${pct(m.margin)}</span></div>
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
  s += `<section class="block reveal">${head("03", "Что и как продаём", "доля в выручке · маржа")}<div class="two"><div>
    <div class="gsum"><div><span class="label">ИП · интерактивные панели</span><div class="v">${mln(ipG.sale)} <small>млн · маржа ${pct(ipG.sale ? ipG.val / ipG.sale : 0)}</small></div></div>
    <div><span class="label">КТ · компьютерная техника</span><div class="v">${mln(ktG.sale)} <small>млн · маржа ${pct(ktG.sale ? ktG.val / ktG.sale : 0)}</small></div></div></div>
    <div class="mix rows"><div class="r head"><span class="label">Товар</span><span class="label">Выручка</span><span class="label">Вал</span><span class="label">Маржа</span></div>
    ${R.mix.map((x) => `<div class="r"><span>${esc(x.kind)} <span class="dim">${x.group}</span></span><div>${bar(R.mix[0]?.sale ? x.sale / R.mix[0].sale * 100 : 0, "ink")}<span class="dim">${mln(x.sale)} млн · ${plural(Math.round(x.qty), ["шт", "шт", "шт"])}</span></div><span class="num">${mln(x.val)}</span><span class="num">${pct(x.sale ? x.val / x.sale : 0)}</span></div>`).join("")}</div></div>
    <div><div class="mix rows"><div class="r head"><span class="label">Канал</span><span class="label">Выручка</span><span class="label">Вал</span><span class="label">Маржа</span></div>
    ${R.channels.map((x) => `<div class="r"><span>${esc(x.name)} <span class="dim">${x.contracts}</span></span><div>${bar(R.channels[0]?.sale ? x.sale / R.channels[0].sale * 100 : 0, "ink")}<span class="dim">${mln(x.sale)} млн</span></div><span class="num">${mln(x.val)}</span><span class="num">${pct(x.sale ? x.val / x.sale : 0)}</span></div>`).join("")}</div></div>
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

  el.innerHTML = s;

  function dealRows(rows) {
    return `<div class="r head"><span class="label">Дата</span><span class="label">Заказчик</span><span class="label">Товар</span><span class="label">Шт</span><span class="label">Сумма</span><span class="label">Вал</span><span class="label">Маржа</span></div>` +
      rows.map((x) => `<div class="r"><span class="num">${ddmm(x.date)}</span><span class="cust" title="${esc(x.customer)}">${esc(short(x.customer, 80))}</span><span>${esc(x.product)} <span class="dim">${esc(x.type)}</span></span><span class="num">${fmt(x.qty)}</span><span class="num">${mln(x.sale)} млн</span><span class="num">${mln(x.val)}</span><span class="num">${pct(x.sale ? x.val / x.sale : 0)}</span></div>`).join("");
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
      rows.slice(0, regShown).map((x) => `<div class="r"><span class="num">${ddmm(x.date)}</span><span class="nm">${esc(x.manager)}</span><span class="cust" title="${esc(x.customer)}">${esc(short(x.customer, 80))}</span><span>${esc(x.product)}</span><span class="num">${fmt(x.qty)}</span><span class="num">${mln(x.sale)} млн</span><span class="num">${mln(x.val)}</span><span class="num">${pct(x.sale ? x.val / x.sale : 0)}</span><span class="dim">${esc(SHORT_CH[x.channel] ?? x.channel)}</span></div>`).join("");
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
