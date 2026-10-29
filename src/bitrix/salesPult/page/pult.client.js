(function () {
  "use strict";

  const P = PAYLOAD;
  const V = VIEW;

  /* ================= format ================= */
  const NF = new Intl.NumberFormat("ru-RU");
  const fmt = (n) => NF.format(Math.round(n || 0));
  const fmt1 = (n) => (Math.round((n || 0) * 10) / 10).toFixed(1).replace(".", ",");
  function money(n) {
    if (!n) return "";
    if (n >= 1e9) return fmt1(n / 1e9) + " млрд ₸";
    if (n >= 1e6) return fmt1(n / 1e6) + " млн ₸";
    if (n >= 1e3) return fmt(n / 1e3) + " тыс ₸";
    return fmt(n) + " ₸";
  }
  function plural(n, f) {
    const a = Math.abs(n) % 100, b = a % 10;
    const w = a > 10 && a < 20 ? f[2] : b > 1 && b < 5 ? f[1] : b === 1 ? f[0] : f[2];
    return fmt(n) + "\u00A0" + w;
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
  const decode = (str) => {
    const t = document.createElement("textarea");
    t.innerHTML = String(str == null ? "" : str);
    return t.value;
  };
  const first = (name) => String(name).trim().split(/\s+/)[0];
  const initials = (name) => String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

  /* ================= signals ================= */
  function renderSignals() {
    const s = V.signals;
    const urgent = V.signalsUrgent;
    const body = s.length ? s.map((sig) => `<div class="sig ${sig.cls}"><span>${sig.text}</span></div>`).join("") : `<div class="sig s-good"><span>Сегодня без происшествий</span></div>`;
    document.getElementById("signals").innerHTML = `
      <div class="block-head"><h2><span class="idx">02</span>Требует внимания</h2><span class="meta">${urgent ? plural(urgent, ["срочный пункт", "срочных пункта", "срочных пунктов"]) : "срочного нет"}</span></div>
      <div class="signals">${body}</div>`;
  }

  /* ================= month hero ================= */
  function renderMonth() {
    const m = V.month;
    const M = m.asOfMonth;

    document.getElementById("month").innerHTML = `
      <div class="block-head"><h2><span class="idx">01</span>${MONTHS[M - 1]}: договоры</h2><span class="meta">план ${fmt(m.plan)} · ${m.targetContracts} на менеджера × ${m.totalActiveCount}</span></div>
      <div class="hero">
        <div>
          <span class="label">Подписано с 1 ${MONTHS_GEN[M - 1]}</span>
          <div class="hero-num"><span class="big" data-count="${m.fact}">0</span><span class="of">/ ${fmt(m.plan)}</span></div>
          <div class="hero-amt">${money(m.amount) || "0 ₸"} <span class="muted">· ${m.pct}% плана</span></div>
          <div class="readout">
            <div><span class="label">Темп</span><div class="v">${m.hasForecast ? `${fmt1(m.pacePerDay)}<small> в день</small>` : "—"}</div></div>
            <div><span class="label">Прогноз</span><div class="v">${m.hasForecast ? `≈ ${fmt(m.forecast)}<small> к ${m.daysInMonth}.${String(M).padStart(2, "0")}</small>` : `—<small> с 3-го дня</small>`}</div></div>
            <div><span class="label">До плана</span><div class="v">${fmt(m.left)}<small>${m.daysLeft <= 0 ? " не добрали" : ` за ${plural(Math.ceil(m.daysLeft), ["день", "дня", "дней"])}`}</small></div></div>
          </div>
          <p class="verdict">${m.verdict}</p>
          <div class="split">${m.split.map((x) => `<div class="split-row"><span>${esc(x.name)}</span><span class="trk"><span data-w="${x.widthPct}"></span></span><span class="num">${fmt(x.c)} · ${money(x.a) || "—"}</span></div>`).join("")}</div>
        </div>
        <div>
          <div class="chart-wrap" id="burnWrap">${burnup()}<div class="tip" id="burnTip"></div></div>
          <div class="legend"><span><i></i>подписано</span><span><i class="dash"></i>темп плана</span><span><i class="dot"></i>прогноз</span><span><i class="band"></i>выходные</span></div>
        </div>
      </div>`;
    wireBurnTip();
  }

  function burnup() {
    const m = V.month;
    const plan = m.plan, fact = m.fact, forecast = m.forecast;
    const daysInMonth = m.daysInMonth, D = m.asOfDay, dayFrac = m.dayFrac;
    const W = innerWidth < 760 ? 420 : 760, H = innerWidth < 760 ? 300 : 340, L = 8, R = innerWidth < 760 ? 72 : 96, T = 18, B = 30;
    const iw = W - L - R, ih = H - T - B;
    const cum = m.points;
    const yMax = Math.max(plan, m.hasForecast ? forecast : 0, fact) * 1.06;
    const x = (d) => L + (d / daysInMonth) * iw;
    const y = (v) => T + ih - (v / yMax) * ih;
    const isWorkMap = new Set(m.workDays);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Договоры накопительно за месяц: факт, темп плана и прогноз">`;
    for (let d = 1; d <= daysInMonth; d++) if (!isWorkMap.has(d)) s += `<rect x="${x(d - 1)}" y="${T}" width="${iw / daysInMonth}" height="${ih}" fill="rgba(20,20,20,.03)"/>`;
    for (let i = 0; i <= 4; i++) { const v = (plan / 4) * i; s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(20,20,20,${i === 0 ? .3 : .08})"/>`; }
    let ideal = `M${x(0)},${y(0)}`; let n = 0;
    for (let d = 1; d <= daysInMonth; d++) { if (isWorkMap.has(d)) n++; ideal += ` L${x(d)},${y((plan * n) / m.monthTotal)}`; }
    s += `<path d="${ideal}" fill="none" stroke="#8c8981" stroke-width="1.5" stroke-dasharray="5 5"/>`;
    const lastDay = cum.length - 1;
    const nowX = x(D - 1 + dayFrac);
    let act = `M${x(0)},${y(0)}`; for (let d = 1; d <= lastDay; d++) act += ` L${x(d)},${y(cum[d])}`;
    const area = act + ` L${x(lastDay)},${y(0)} Z`;
    s += `<path d="${area}" fill="rgba(20,20,20,.06)" class="burn-area"/>`;
    s += `<path d="${act}" fill="none" stroke="#141414" stroke-width="2.2" stroke-linejoin="round" class="burn-line"/>`;
    if (m.hasForecast) s += `<path d="M${x(lastDay)},${y(fact)} L${x(daysInMonth)},${y(forecast)}" fill="none" stroke="#141414" stroke-width="2" stroke-dasharray="1.5 5" stroke-linecap="round" class="burn-fc"/>`;
    s += `<line x1="${nowX}" x2="${nowX}" y1="${T - 6}" y2="${T + ih}" stroke="#141414" stroke-width="1"/>`;
    for (let i = 1; i <= 4; i++) { const v = (plan / 4) * i; s += `<text x="${L + 4}" y="${y(v) - 6}" class="burn-axis" font-family="JetBrains Mono" font-size="11" fill="#8c8981" style="paint-order:stroke;stroke:var(--paper,#f1efe9);stroke-width:3px;stroke-linejoin:round">${fmt(v)}</text>`; }
    s += `<text x="${nowX}" y="${T - 10}" text-anchor="middle" font-family="JetBrains Mono" font-size="11" fill="#141414">сегодня</text>`;
    s += `<circle cx="${x(lastDay)}" cy="${y(fact)}" r="4.5" fill="#faf9f5" stroke="#141414" stroke-width="2"/>`;
    let yp = y(plan);
    if (m.hasForecast) {
      let yf = y(forecast);
      if (Math.abs(yp - yf) < 30) { if (yf >= yp) yf = yp + 30; else yp = yf + 30; }
      s += `<text x="${x(daysInMonth) + 10}" y="${yp + 4}" font-family="JetBrains Mono" font-size="12" fill="#55534e">план ${fmt(plan)}</text>`;
      s += `<text x="${x(daysInMonth) + 10}" y="${yf + 4}" font-family="JetBrains Mono" font-size="12" fill="#141414" font-weight="500">≈ ${fmt(forecast)}</text>`;
      s += `<circle cx="${x(daysInMonth)}" cy="${y(forecast)}" r="3" fill="#141414"/>`;
    } else {
      s += `<text x="${x(daysInMonth) + 10}" y="${yp + 4}" font-family="JetBrains Mono" font-size="12" fill="#55534e">план ${fmt(plan)}</text>`;
    }
    for (const d of [1, 8, 15, 22, 29].filter((d) => d <= daysInMonth)) s += `<text x="${x(d - 0.5)}" y="${H - 8}" text-anchor="middle" font-family="JetBrains Mono" font-size="11" fill="#8c8981">${d}</text>`;
    for (let d = 1; d <= daysInMonth; d++) s += `<rect class="hit" data-d="${d}" x="${x(d - 1)}" y="${T}" width="${iw / daysInMonth}" height="${ih}" fill="transparent"/>`;
    return s + `</svg>`;
  }

  function wireBurnTip() {
    const wrap = document.getElementById("burnWrap"), tip = document.getElementById("burnTip");
    const m = V.month;
    const cum = m.points;
    const byDayMap = new Map(m.byDay.map((d) => [d.day, d]));
    const isWorkMap = new Set(m.workDays);
    const M = m.asOfMonth, D = m.asOfDay;
    wrap.querySelectorAll(".hit").forEach((r) => {
      r.addEventListener("mouseenter", () => {
        const d = +r.dataset.d; const x = byDayMap.get(d);
        const box = r.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
        const head = `<b>${d} ${MONTHS_GEN[M - 1]}</b>${isWorkMap.has(d) ? "" : " · выходной"}`;
        const body = d > D ? "ещё впереди" : x ? `+${plural(x.contracts, ["договор", "договора", "договоров"])}${x.amount ? " · " + money(x.amount) : ""}<br>${plural(x.calls, ["дозвон", "дозвона", "дозвонов"])}<br>всего с начала месяца: ${fmt(cum[d] || 0)}` : "нет данных";
        tip.innerHTML = head + "<br>" + body;
        tip.style.left = (box.left - wb.left + box.width / 2) + "px"; tip.style.top = "40px"; tip.classList.add("on");
      });
      r.addEventListener("mouseleave", () => tip.classList.remove("on"));
    });
  }

  /* ================= sales department ================= */
  function gauge(fact, tgt, j, unit, period) {
    const w = tgt ? Math.min(100, (fact / tgt) * 100) : 0;
    const pp = tgt ? Math.min(100, (j.expected / tgt) * 100) : 0;
    const edge = pp > 82 ? "edge-r" : pp < 12 ? "edge-l" : "";
    const pace = j.expected >= 0.5 && fact < tgt ? `<span class="pace ${edge}" style="left:${pp}%"><span>${period === "day" ? "к " + V.genLabel + " нужно" : "по темпу нужно"} ${fmt(j.expected)}${unit || ""}</span></span>` : "";
    return `<div class="gauge"><span class="fill ${j.cls}" data-w="${w}"></span>${pace}</div>`;
  }

  function instrument(label, fact, tgt, period, sub, j) {
    return `<div>
      <span class="label">${label}</span>
      <div class="v"><span class="n" data-count="${fact}">0</span><span class="t">из ${fmt(tgt)}</span></div>
      <span class="state ${j.cls === "idle" ? "idle" : j.cls}">${j.label || j.text}</span>
      ${gauge(fact, tgt, j, "", period)}
      <div class="sub">${sub}</div>
    </div>`;
  }

  function renderSales(period) {
    const sp = V.periods[period].sales;
    const tc = sp.totals.calls, tk = sp.totals.proposals, tg = sp.totals.contracts;
    document.getElementById("sales").innerHTML = `
      <div class="block-head"><h2><span class="idx">03</span>${esc(sp.name)} ${sp.periodName}</h2><span class="meta">${sp.meta}</span></div>
      <div class="inst">
        ${instrument("Дозвонились", tc.fact, tc.target, period, tc.sub, tc)}
        ${instrument("Отправили КП", tk.fact, tk.target, period, tk.sub, tk)}
        ${instrument("Подписали договоры", tg.fact, tg.target, period, tg.sub, tg)}
      </div>
      ${sp.isEarly ? `<p class="early">${sp.earlyText}</p>` : ""}
      <div class="team" role="table" aria-label="Менеджеры отдела продаж">
        <div class="trow head label" role="row"><span>Менеджер</span><span>Дозвонился</span><span>КП</span><span>Подписал</span><span>Долги сегодня</span><span></span></div>
        ${sp.managers.map((m) => managerRow(m, period)).join("")}
      </div>`;
    wireRows(document.getElementById("sales"));
  }

  function miniCell(label, j) {
    if (j.isEarlyEmpty) return `<div class="cell" data-l="${label}"><span class="muted">—</span></div>`;
    if (j.untracked) return `<div class="cell" data-l="${label}"><div class="top"><span class="num muted">${fmt(j.fact)}</span></div></div>`;
    const w = j.target ? Math.min(100, (j.fact / j.target) * 100) : 0;
    const pace = !j.untracked && j.expected >= 0.5 && j.fact < j.target ? `<b style="left:${Math.min(100, (j.expected / j.target) * 100)}%"></b>` : "";
    return `<div class="cell" data-l="${label}"><div class="top"><span class="num ${j.cls === "idle" ? "" : j.cls}">${fmt(j.fact)}</span><span class="of">/ ${fmt(j.target)}</span></div><div class="mini"><span class="${j.cls}" data-w="${w}"></span>${pace}</div><div class="sub">${j.sub || ""}</div></div>`;
  }

  function debtsCell(d) {
    if (!d) return `<div class="cell debts" data-l="Долги"><span class="clean">нет данных</span></div>`;
    const out = [];
    if (d.overdue) out.push(`<span class="bad">${plural(d.overdue, ["дело просрочено", "дела просрочены", "дел просрочено"])}</span>`);
    if (d.newDeals) out.push(`<span class="warn">${plural(d.newDeals, ["новая", "новые", "новых"])} без звонка</span>`);
    if (d.readyToCloseDealIds && d.readyToCloseDealIds.length) out.push(`<span class="muted">${fmt(d.readyToCloseDealIds.length)} пора закрыть</span>`);
    return `<div class="cell debts" data-l="Долги">${out.length ? out.join("") : `<span class="clean">долгов нет</span>`}</div>`;
  }

  function managerRow(m, period) {
    let calls;
    if (!P.callsAvailable) calls = `<div class="cell" data-l="Дозвонился"><span class="muted">нет доступа</span></div>`;
    else if (m.calls.noCallsFlag) calls = `<div class="cell" data-l="Дозвонился"><span class="flag">Нет звонков через Битрикс</span><div class="sub">норма ${m.calls.target}</div></div>`;
    else calls = miniCell("Дозвонился", m.calls);
    const kp = miniCell("КП", m.proposals);
    const c = miniCell("Подписал", m.contracts);
    const id = "d-" + m.id;
    return `<div class="trow body" role="row" tabindex="0" aria-expanded="false" aria-controls="${id}">
        <div class="who"><span class="mono-av">${esc(m.initials)}</span><div><div class="nm">${esc(m.name)}</div><div class="rl">${m.tasksCountText}</div></div></div>
        ${calls}${kp}${c}${debtsCell(m.debts)}
        <span class="chev" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 4.5 6 8.5l4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></span>
      </div>
      <div class="detail" id="${id}"><div>${managerDetail(m)}</div></div>`;
  }

  function managerDetail(m) {
    const d = m.debts || { overdue: 0, overdueOverMonth: 0, newDeals: 0, newOldestAgeDays: 0, readyToCloseDealIds: [] };
    const tasks = (m.topTasks || []).map((t) => taskRow(t, m, true)).join("");
    return `<div class="detail-in">
      <div class="dstats">
        <div><span class="label">Просрочено</span><span class="num ${d.overdue ? "bad" : ""}">${fmt(d.overdue)}</span></div>
        <div><span class="label">30+ дней</span><span class="num">${fmt(d.overdueOverMonth)}</span></div>
        <div><span class="label">Без звонка</span><span class="num ${d.newDeals ? "warn" : ""}">${fmt(d.newDeals)}</span></div>
        <div><span class="label">Самой старой</span><span class="num">${d.newDeals ? fmt(d.newOldestAgeDays) + " дн." : "—"}</span></div>
        <div style="grid-column:1/-1"><span class="label">Пора закрыть</span><span class="num">${fmt(d.readyToCloseDealIds.length)}</span></div>
      </div>
      <div>${tasks || `<div class="mini-empty">Срочных задач нет.</div>`}</div>
    </div>`;
  }

  function wireRows(root) {
    root.querySelectorAll(".trow.body").forEach((row) => {
      const toggle = () => {
        const open = row.getAttribute("aria-expanded") !== "true";
        row.setAttribute("aria-expanded", String(open));
        const target = document.getElementById(row.getAttribute("aria-controls"));
        if (target) target.classList.toggle("open", open);
      };
      row.addEventListener("click", (e) => { if (!e.target.closest("a")) toggle(); });
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });
  }

  /* ================= calls ================= */
  function renderCalls(period) {
    const cp = V.periods[period].calls;
    const st = cp.strip;
    const html = `
      <div class="block-head"><h2><span class="idx">04</span>Звонки ${cp.periodName}</h2><span class="meta">${cp.meta}</span></div>
      <div class="callstrip">
        <div><span class="label">Дозвонились</span><div class="v" data-count="${st.calls}">0</div></div>
        <div><span class="label">Наборов</span><div class="v">${fmt(st.attempts)}</div></div>
        <div><span class="label">Доля дозвона</span><div class="v">${st.attempts ? st.conv : "—"}<small>${st.attempts ? "%" : ""}</small></div></div>
        <div><span class="label">Средний разговор</span><div class="v">${st.calls ? fmt1(st.avg) : "—"}<small>${st.calls ? "мин" : ""}</small></div></div>
        <div><span class="label">${st.normLabel}</span><div class="v">${st.normValue}<small>${st.normSub}</small></div></div>
      </div>
      <div class="calls-grid">
        <div>
          <div class="sub-h"><h3>Дозвоны по дням, ${MONTHS[V.month.asOfMonth - 1].toLowerCase()}</h3><span class="label">норма ${fmt(st.norm)} в день</span></div>
          <div class="chart-wrap" id="callsWrap">${callsChart(st.norm)}<div class="tip" id="callsTip"></div></div>
        </div>
        <div>
          <div class="sub-h"><h3>Что видно по звонкам</h3><span class="label">${cp.periodName}</span></div>
          <div class="notes">${cp.notes.map((x) => `<div class="note"><span>${x}</span></div>`).join("")}</div>
        </div>
      </div>
      <div class="anat">
        <div class="sub-h"><h3>Кто как звонит</h3><span class="label">■ дозвон  ▨ не дозвонился  ┆ норма</span></div>
        <div class="arow head label"><span>Менеджер</span><span>Наборы</span><span class="astats"><span>Дозвон</span><span>Доля</span><span>Разговор</span><span>Минут</span></span></div>
        ${anatomy(period)}
      </div>`;
    document.getElementById("calls").innerHTML = html;
    wireCallsTip();
  }

  function callsChart(norm) {
    const m = V.month;
    const daysInMonth = m.daysInMonth, D = m.asOfDay;
    const isWorkMap = new Set(m.workDays);
    const byDayMap = new Map(m.byDay.map((d) => [d.day, d]));
    const W = innerWidth < 760 ? 420 : 760, H = innerWidth < 760 ? 230 : 250, L = 4, R = 74, T = 22, B = 28, iw = W - L - R, ih = H - T - B;
    const mx = Math.max(norm, ...m.byDay.map((d) => d.calls)) * 1.1;
    const bw = iw / daysInMonth;
    const y = (v) => T + ih - (v / mx) * ih;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Дозвоны по дням месяца и дневная норма">`;
    s += `<line x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}" stroke="rgba(20,20,20,.3)"/>`;
    let worked = 0, sum = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const x0 = L + (d - 1) * bw;
      const v = byDayMap.get(d);
      if (!isWorkMap.has(d)) { s += `<rect x="${x0}" y="${T}" width="${bw}" height="${ih}" fill="rgba(20,20,20,.03)"/>`; continue; }
      if (d > D) { s += `<rect x="${x0 + bw * .18}" y="${T + ih - 2}" width="${bw * .64}" height="2" fill="#bdbab1"/>`; continue; }
      const calls = v ? v.calls : 0;
      if (d < D || (d === D && calls)) { worked++; sum += calls; }
      const h = (calls / mx) * ih;
      const fill = d === D ? "none" : calls >= norm ? "#1d7a4c" : "#2b2a27";
      s += `<rect class="cbar" x="${x0 + bw * .18}" y="${T + ih - h}" width="${bw * .64}" height="${Math.max(h, 1)}" fill="${fill}" ${d === D ? 'stroke="#141414" stroke-dasharray="2 2"' : ""} style="transform-origin:${x0 + bw / 2}px ${T + ih}px"/>`;
      if (calls && bw > 14) s += `<text x="${x0 + bw / 2}" y="${T + ih - h - 6}" text-anchor="middle" font-family="JetBrains Mono" font-size="10" fill="#55534e">${calls}</text>`;
    }
    const avg = worked ? sum / worked : 0;
    s += `<line x1="${L}" x2="${W - R}" y1="${y(norm)}" y2="${y(norm)}" stroke="#c2372c" stroke-width="1.2" stroke-dasharray="6 4"/>`;
    s += `<text x="${W - R + 10}" y="${y(norm) + 4}" font-family="JetBrains Mono" font-size="11" fill="#c2372c">норма ${fmt(norm)}</text>`;
    if (avg) { s += `<line x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}" stroke="#141414" stroke-width="1" stroke-dasharray="1 3"/>`; s += `<text x="${W - R + 10}" y="${y(avg) + 4}" font-family="JetBrains Mono" font-size="11" fill="#141414">ср. ${fmt(avg)}</text>`; }
    for (const d of [1, 8, 15, 22, 29].filter((d) => d <= daysInMonth)) s += `<text x="${L + (d - .5) * bw}" y="${H - 8}" text-anchor="middle" font-family="JetBrains Mono" font-size="11" fill="#8c8981">${d}</text>`;
    for (let d = 1; d <= daysInMonth; d++) s += `<rect class="hit" data-d="${d}" x="${L + (d - 1) * bw}" y="${T}" width="${bw}" height="${ih}" fill="transparent"/>`;
    return s + `</svg>`;
  }

  function wireCallsTip() {
    const wrap = document.getElementById("callsWrap"), tip = document.getElementById("callsTip");
    const m = V.month;
    const isWorkMap = new Set(m.workDays);
    const byDayMap = new Map(m.byDay.map((d) => [d.day, d]));
    const M = m.asOfMonth, D = m.asOfDay;
    wrap.querySelectorAll(".hit").forEach((r) => {
      r.addEventListener("mouseenter", () => {
        const d = +r.dataset.d, v = byDayMap.get(d), box = r.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
        tip.innerHTML = `<b>${d} ${MONTHS_GEN[M - 1]}</b><br>` + (!isWorkMap.has(d) ? "выходной" : d > D ? "ещё впереди" : v ? plural(v.calls, ["дозвон", "дозвона", "дозвонов"]) : "нет данных");
        tip.style.left = (box.left - wb.left + box.width / 2) + "px"; tip.style.top = "30px"; tip.classList.add("on");
      });
      r.addEventListener("mouseleave", () => tip.classList.remove("on"));
    });
  }

  function anatomy(period) {
    const cp = V.periods[period].calls;
    return cp.anatomy.map((row) => {
      const bar = row.totalAttempts ? `<div class="abar"><span class="ok" data-w="${row.okPct}"></span><span class="miss" data-w="${row.missPct}"></span><span class="tgt" style="left:${row.tgtPct}%"></span></div>`
        : `<div class="abar"><span class="tgt" style="left:${row.tgtPct}%"></span><span class="none">${row.isEarlyEmpty ? "" : "нет звонков через Битрикс"}</span></div>`;
      return `<div class="arow"><div class="who"><span class="mono-av">${esc(row.initials)}</span><span class="nm">${esc(row.name)}</span></div>${bar}<div class="astats"><span>${fmt(row.successful)} из ${fmt(row.totalAttempts)}</span><span>${row.convStr}</span><span>${row.avgStr}</span><span>${fmt(row.durationMinutes)}</span></div></div>`;
    }).join("");
  }

  /* ================= tenders ================= */
  function renderTenders(period) {
    const el = document.getElementById("tenders");
    const tp = V.periods[period].tenders;
    if (!tp) { if (el) el.remove(); return; }
    const tg = tp.totals.contracts;
    const rows = tp.managers.map((m) => {
      const id = "t-" + m.id;
      return `<div class="trow body" role="row" tabindex="0" aria-expanded="false" aria-controls="${id}" style="grid-template-columns:minmax(200px,1.5fr) minmax(0,1.5fr) minmax(0,1.5fr) 28px">
        <div class="who"><span class="mono-av">${esc(m.initials)}</span><div class="nm">${esc(m.name)}</div></div>
        ${miniCell("Подписал", m.contracts)}
        ${debtsCell(m.debts)}
        <span class="chev" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 4.5 6 8.5l4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></span>
      </div><div class="detail" id="${id}"><div>${managerDetail(m)}</div></div>`;
    }).join("");
    el.innerHTML = `
      <div class="block-head"><h2><span class="idx">05</span>${esc(tp.name)} ${tp.periodName}</h2><span class="meta">${tp.meta}</span></div>
      <div class="inst one">
        ${instrument("Подписали договоры", tg.fact, tg.target, period, tg.sub, tg)}
        <div class="team" style="margin:0">${rows}</div>
      </div>`;
    wireRows(el);
  }

  /* ================= tasks ================= */
  let taskFilter = "all", taskAll = false;
  function cleanTitle(t) {
    let s = decode(t.title || "");
    let plan = t.planNumber || "";
    const m = /^\[GZ (\d+)\]\s*/.exec(s); if (m) { plan = plan || m[1]; s = s.slice(m[0].length); }
    const m2 = /^(\d{7,9})\s+/.exec(s); if (m2) { plan = plan || m2[1]; s = s.slice(m2[0].length); }
    return { title: s, plan };
  }
  function taskStatus(t) {
    if (t.kind === "new") { const a = Math.floor(t.ageDays || 0); return { cls: "warn", text: a >= 1 ? "Новая, без звонка " + plural(a, ["день", "дня", "дней"]) : "Новая, без звонка с сегодня" }; }
    if (t.isOverdue) return { cls: "bad", text: "Просрочено на " + plural(t.overdueDays || 0, ["день", "дня", "дней"]) };
    return { cls: "", text: "Срок сегодня" };
  }
  function taskRow(t, m, own) {
    const ct = cleanTitle(t), st = taskStatus(t);
    const url = P.portal + "/crm/deal/details/" + encodeURIComponent(t.dealId) + "/";
    return `<article class="task s-${st.cls || "none"}">
      <span class="sev"></span>
      <div>
        <div class="kick"><span class="label">${esc(t.subject || "Дело")}</span>${ct.plan ? `<span class="tag">план ${esc(ct.plan)}</span>` : ""}${t.planStatus ? `<span class="tag">${esc(t.planStatus)}</span>` : ""}</div>
        <h3 class="ttl"><a href="${url}" target="_blank" rel="noopener">${esc(ct.title)}</a></h3>
        ${t.lastComment ? `<div class="cm">${esc(decode(t.lastComment))}</div>` : ""}
      </div>
      <div class="side">
        <span class="num">${money(t.amount) || "сумма не указана"}</span>
        <span class="st ${st.cls}">${st.text}</span>
        ${own ? "" : `<span class="muted" style="font-size:13px">${esc(m.name)}</span>`}
        <a class="go" href="${url}" target="_blank" rel="noopener">Открыть сделку ↗</a>
      </div>
    </article>`;
  }
  function renderTasks() {
    const all = [];
    for (const g of P.groups) for (const m of g.managers) for (const t of m.topTasks || []) all.push({ t, m });
    const el = document.getElementById("tasks");
    if (!all.length) { el.innerHTML = `<div class="block-head"><h2><span class="idx">06</span>Что сделать сегодня</h2></div><div class="mini-empty">Срочных задач нет.</div>`; return; }
    const owners = [...new Map(all.map((x) => [x.m.id, x.m])).values()];
    const list = all.filter((x) => taskFilter === "all" || x.m.id === taskFilter)
      .sort((a, b) => (a.t.group || 9) - (b.t.group || 9) || (b.t.overdueDays || 0) - (a.t.overdueDays || 0) || (b.t.amount || 0) - (a.t.amount || 0));
    const sumAmt = list.reduce((s, x) => s + (x.t.amount || 0), 0);
    el.innerHTML = `
      <div class="block-head"><h2><span class="idx">06</span>Что сделать сегодня</h2><span class="meta">${plural(list.length, ["задача", "задачи", "задач"])} · сделки на ${money(sumAmt)}</span></div>
      <div class="filters" role="group" aria-label="Фильтр по менеджеру">
        <button data-f="all" aria-pressed="${taskFilter === "all"}">Все<span class="num">${all.length}</span></button>
        ${owners.map((m) => `<button data-f="${m.id}" aria-pressed="${taskFilter === m.id}">${esc(first(m.name))}<span class="num">${all.filter((x) => x.m.id === m.id).length}</span></button>`).join("")}
      </div>
      <div>${(taskAll ? list : list.slice(0, 6)).map((x) => taskRow(x.t, x.m)).join("")}</div>
      ${!taskAll && list.length > 6 ? `<button class="btn more" id="moreTasks">Показать ещё ${list.length - 6}</button>` : ""}`;
    el.querySelectorAll(".filters button").forEach((b) => b.addEventListener("click", () => { taskFilter = b.dataset.f; taskAll = false; renderTasks(); }));
    const more = document.getElementById("moreTasks"); if (more) more.addEventListener("click", () => { taskAll = true; renderTasks(); });
  }

  /* ================= chrome ================= */
  function renderChrome() {
    document.getElementById("dateLabel").textContent = V.dateLabel;
    document.getElementById("wdLabel").textContent = V.wdLabel;
    requestAnimationFrame(() => { document.getElementById("monthFill").style.width = V.monthFillPct + "%"; });
    const live = document.getElementById("live"), liveText = document.getElementById("liveText");
    function tick() {
      const m = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(P.generatedAt);
      let ago = "";
      if (m) {
        const gen = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 5, +m[5]);
        const mins = Math.round((Date.now() - gen) / 60000);
        if (mins >= 0 && mins < 60 * 24) ago = mins < 1 ? "только что" : mins < 60 ? plural(mins, ["минуту", "минуты", "минут"]) + " назад" : plural(Math.floor(mins / 60), ["час", "часа", "часов"]) + " назад";
        live.classList.toggle("stale", mins > 90);
      }
      liveText.innerHTML = `Данные на ${V.genLabel}` + (ago ? ` <span class="ago">· ${ago}</span>` : "");
    }
    tick(); setInterval(tick, 30000);
  }

  /* ================= motion ================= */
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function countUp(el) {
    const to = parseFloat(el.dataset.count); if (isNaN(to)) return;
    if (reduce) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 1300;
    (function step(t) { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 4); el.textContent = fmt(to * e); if (p < 1) requestAnimationFrame(step); })(t0);
  }
  function animate(root) {
    root.querySelectorAll("[data-w]").forEach((b) => { b.style.width = b.dataset.w + "%"; });
    root.querySelectorAll("[data-count]").forEach(countUp);
    root.querySelectorAll(".burn-line, .burn-fc").forEach((p) => {
      if (reduce) return;
      const len = p.getTotalLength(); p.style.strokeDasharray = p.classList.contains("burn-fc") ? "" : len;
      if (!p.classList.contains("burn-fc")) { p.style.strokeDashoffset = len; p.getBoundingClientRect(); p.style.transition = "stroke-dashoffset 1.8s cubic-bezier(.2,.8,.2,1)"; p.style.strokeDashoffset = 0; }
      else { p.style.opacity = 0; p.style.transition = "opacity .6s 1.6s"; requestAnimationFrame(() => (p.style.opacity = 1)); }
    });
    root.querySelectorAll(".burn-area").forEach((a) => { if (reduce) return; a.style.opacity = 0; a.style.transition = "opacity 1s .9s"; requestAnimationFrame(() => (a.style.opacity = 1)); });
    root.querySelectorAll(".cbar").forEach((b, i) => { if (reduce) return; b.style.transform = "scaleY(0)"; b.getBoundingClientRect(); b.style.transition = `transform .9s cubic-bezier(.2,.8,.2,1) ${i * 18}ms`; b.style.transform = "scaleY(1)"; });
  }
  const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); animate(e.target); io.unobserve(e.target); } }), { threshold: 0.12 }) : null;
  function observe() { document.querySelectorAll(".reveal:not(.in)").forEach((s) => io ? io.observe(s) : (s.classList.add("in"), animate(s))); }

  /* ================= period switch ================= */
  let period = "day";
  const btns = [...document.querySelectorAll(".periods button")], ind = document.querySelector(".periods .ind");
  function moveInd() {
    const b = btns.find((x) => x.dataset.p === period);
    if (!b || !ind) return;
    ind.style.left = b.offsetLeft + 14 + "px";
    ind.style.width = b.offsetWidth - 28 + "px";
  }
  function setPeriod(p, fromUser) {
    period = p;
    btns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.p === p)));
    moveInd();
    renderSales(p); renderCalls(p); renderTenders(p);
    ["sales", "calls", "tenders"].forEach((id) => { const s = document.getElementById(id); if (s && s.classList.contains("in")) animate(s); });
    try { if (fromUser) localStorage.setItem("pult-period", p); } catch (e) {}
  }
  btns.forEach((b) => b.addEventListener("click", () => setPeriod(b.dataset.p, true)));
  addEventListener("resize", moveInd);
  addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea")) return;
    if (e.key === "1") setPeriod("day", true); else if (e.key === "2") setPeriod("week", true); else if (e.key === "3") setPeriod("month", true);
    else if (e.key === "t" || e.key === "T" || e.key === "е" || e.key === "Е") toggleTv();
  });

  /* ================= TV ================= */
  let tvTimer = null;
  const SCENES = ["month", "sales", "calls", "signals", "tenders"].filter((id) => document.getElementById(id));
  function showScene(i) {
    SCENES.forEach((id, k) => document.getElementById(id).classList.toggle("scene", k === i));
    document.getElementById("scenes").innerHTML = SCENES.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("");
    const el = document.getElementById(SCENES[i]); if (el) { el.classList.add("in"); animate(el); }
    fitTv();
    scrollTo(0, 0);
  }
  function fitTv() {
    const page = document.querySelector(".page");
    if (!page) return;
    page.style.zoom = 1; page.style.paddingLeft = page.style.paddingRight = "";
    if (!document.body.classList.contains("tv")) return;
    const bar = document.querySelector(".bar");
    const barIn = document.querySelector(".bar-in");
    const avail = innerHeight - (bar ? bar.offsetHeight : 64) - 8;
    const z = Math.max(0.7, Math.min(1.45, avail / page.scrollHeight, innerWidth / 1400));
    page.style.zoom = z;
    const gutter = parseFloat(barIn ? getComputedStyle(barIn).paddingLeft : "40") || 40;
    page.style.paddingLeft = page.style.paddingRight = gutter / z + "px";
  }
  addEventListener("resize", fitTv);
  function toggleTv() {
    const on = document.body.classList.toggle("tv");
    const tvBtn = document.getElementById("tvBtn");
    if (tvBtn) tvBtn.textContent = on ? "Выйти из ТВ" : "Режим ТВ";
    clearInterval(tvTimer);
    const bar = document.getElementById("tvCycle");
    SCENES.forEach((id) => { const el = document.getElementById(id); if (el) el.classList.remove("scene"); });
    fitTv();
    if (on) {
      if (period !== "day") setPeriod("day");
      let i = 0, t0 = Date.now(); const every = 15000;
      showScene(i);
      tvTimer = setInterval(() => {
        const p = (Date.now() - t0) / every; if (bar) bar.style.width = Math.min(100, p * 100) + "%";
        if (p >= 1) { i = (i + 1) % SCENES.length; showScene(i); t0 = Date.now(); }
      }, 200);
    } else if (bar) bar.style.width = "0";
  }
  const tvBtn = document.getElementById("tvBtn");
  if (tvBtn) tvBtn.addEventListener("click", toggleTv);

  setTimeout(() => location.reload(), 15 * 60 * 1000);

  /* ================= boot ================= */
  renderChrome(); renderSignals(); renderMonth(); renderTasks();
  let saved = null; try { saved = localStorage.getItem("pult-period"); } catch (e) {}
  setPeriod(/period=(day|week|month)/.exec(location.search)?.[1] || saved || "day");
  observe();
  if (/tv=1/.test(location.search)) toggleTv();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveInd);
})();
