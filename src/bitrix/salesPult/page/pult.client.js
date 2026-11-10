(function () {
  "use strict";

  let P = PAYLOAD;
  let V = VIEW;
  const currentMonth = PAYLOAD.asOfDate.slice(0, 7);
  let selectedMonth = currentMonth;

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
  const ddmm = (iso) => { if (!iso) return "—"; const parts = String(iso).slice(0, 10).split("-"); return parts.length === 3 ? `${parts[2]}.${parts[1]}` : iso; };

  const dealUrl = (id) => {
    const base = String(P.portal || "").replace(/\/+$/, "");
    return (base ? base : "") + "/crm/deal/details/" + encodeURIComponent(id) + "/";
  };

  function copyToClipboard(text, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    const original = btn.textContent;
    btn.textContent = "Скопировано ✓";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 2000);
  }

  /* ================= signals ================= */
  function renderSignals() {
    const isTv = document.body.classList.contains("tv");
    const myMgr = me && !isTv ? P.groups.flatMap(g => g.managers).find(m => m.id === me) : null;

    const buildMismatchesDetails = (mismatches, extraClass = "") => {
      if (!mismatches || !mismatches.length) return "";
      return `
        <details class="outcome-mismatches ${extraClass}">
          <summary class="sig s-bad"><span>Ошибка в CRM: ${plural(mismatches.length, ["сделка выиграна", "сделки выиграны", "сделок выиграно"])} на портале, но ${mismatches.length % 10 === 1 && mismatches.length % 100 !== 11 ? "закрыта" : "закрыты"} как проигрыш</span><span class="mismatch-toggle">список</span></summary>
          <div class="mismatch-content">
          <div class="mismatch-actions">
            <button type="button" class="copy-chat-btn" data-copy-mismatches>Скопировать для чата</button>
          </div>
          <div class="box-desc">
            По этим сделкам проверка портала зафиксировала действующий договор группы, но в CRM они закрыты со статусом проигрыша. Проверьте и исправьте стадию:
          </div>
          <div class="mismatches-list">
            ${mismatches.map((m) => `
              <div class="mismatch-row" data-id="${esc(m.id)}">
                <div class="info">
                  <a href="${dealUrl(m.id)}" target="_blank" rel="noopener" class="deal-link">${esc(m.title)}</a>
                  <span class="mgr">· Менеджер: ${esc(m.managerName)}</span>
                </div>
                <div class="meta">
                  <b>${money(m.amount)}</b> · ${m.portalSignDate ? `от ${ddmm(m.portalSignDate)}` : esc(m.outcome)}
                </div>
              </div>
            `).join("")}
          </div>
          </div>
        </details>
      `;
    };

    let innerHtml = "";
    if (myMgr) {
      const myMismatches = (P.outcomeMismatches || []).filter(m => m.managerId === me);
      const otherMismatches = (P.outcomeMismatches || []).filter(m => m.managerId !== me);

      const mySignals = V.signals.filter(sig => sig.text.includes(myMgr.name) || (first(myMgr.name) && sig.text.includes(first(myMgr.name))));
      const otherSignals = V.signals.filter(sig => !mySignals.includes(sig));

      const myHtml = [
        buildMismatchesDetails(myMismatches),
        mySignals.map(sig => `<div class="sig ${sig.cls}"><span>${sig.text}</span></div>`).join("")
      ].filter(Boolean).join("");

      const urgentMe = myMismatches.length + mySignals.length;
      const headHtml = urgentMe
        ? myHtml
        : `<div class="sig s-good"><span>У вас нет срочных пунктов</span></div>`;

      const otherCount = otherMismatches.length + otherSignals.length;
      const otherHtml = otherCount > 0 ? `
        <details class="other-team-signals">
          <summary>У остальных в команде: ${plural(otherCount, ["пункт", "пункта", "пунктов"])}</summary>
          <div class="other-team-content">
            ${buildMismatchesDetails(otherMismatches)}
            ${otherSignals.map(sig => `<div class="sig ${sig.cls}"><span>${sig.text}</span></div>`).join("")}
          </div>
        </details>
      ` : "";

      innerHtml = headHtml + otherHtml;
    } else {
      const mismatchesHtml = buildMismatchesDetails(P.outcomeMismatches);
      const body = V.signals.length
        ? V.signals.map(sig => `<div class="sig ${sig.cls}"><span>${sig.text}</span></div>`).join("")
        : (!V.signalsUrgent ? `<div class="sig s-good"><span>Срочного нет</span></div>` : "");
      innerHtml = mismatchesHtml + body;
    }

    document.getElementById("signals").innerHTML = `
      <div class="block-head"><h2><span class="idx">02</span>Срочно</h2><span class="meta">${esc(V.signalsMeta)}</span></div>
      <div class="signals">${innerHtml}</div>`;

    document.querySelectorAll("#signals .outcome-mismatches").forEach(errors => {
      errors.querySelector("summary")?.addEventListener("click", e => {
        if (document.body.classList.contains("tv")) e.preventDefault();
      });
      errors.addEventListener("toggle", () => {
        if (document.body.classList.contains("tv")) errors.open = false;
      });
      errors.querySelectorAll("button[data-copy-mismatches]").forEach(btn => {
        btn.addEventListener("click", () => {
          const ids = new Set([...errors.querySelectorAll(".mismatch-row")].map(r => r.dataset.id));
          const rootMismatches = (typeof PAYLOAD !== "undefined" && PAYLOAD?.outcomeMismatches) || P.outcomeMismatches || [];
          const rows = rootMismatches.filter(m => ids.has(String(m.id))).map((m, idx) => {
            const url = dealUrl(m.id);
            const amt = money(m.amount) || "сумма не указана";
            const dateStr = m.portalSignDate ? `от ${ddmm(m.portalSignDate)}` : m.outcome;
            return `${idx + 1}. ${m.title} (${amt}, ${dateStr}) — Менеджер: ${m.managerName}\n   ${url}`;
          });
          const text = `Ошибки в CRM (выиграно на портале, но закрыто как проигрыш):\n` + rows.join("\n");
          copyToClipboard(text, btn);
        });
      });
    });
  }

  /* ================= month hero ================= */
  function renderMonth(keepMoreOpen) {
    const m = V.month;
    const M = m.asOfMonth;
    const activePeriod = P.closedMonth ? "month" : period;
    const calls = V.periods[activePeriod].sales.totals.calls;
    const need = m.daysLeft > 0 ? m.left / m.daysLeft : 0;
    const revPct = m.revenuePlan && m.revenuePlan > 0 ? Math.round(m.amount / m.revenuePlan * 100) : 0;

    const allWonPortalDeals = (P.groups || []).flatMap(g => (g.managers || []).flatMap(mgr => mgr.debts?.wonOnPortalNotClosedDeals || []));
    const wonPortalDealsMap = new Map();
    for (const d of allWonPortalDeals) {
      if (d && d.dealId && !wonPortalDealsMap.has(d.dealId)) {
        wonPortalDealsMap.set(d.dealId, d);
      }
    }
    const wonPortalCount = wonPortalDealsMap.size;
    const wonPortalAmount = Array.from(wonPortalDealsMap.values()).reduce((sum, d) => sum + (d.amount || 0), 0);
    const potentialParts = [];
    if (wonPortalCount > 0) {
      potentialParts.push(`+ Ещё ${fmt(wonPortalCount)} на ${fmt1(wonPortalAmount / 1e6)} млн ₸ выиграно на портале (не закрыты в CRM)`);
    }
    if (m.awaitingRegister && m.awaitingRegister > 0) {
      potentialParts.push(`ждёт ОП: ${plural(m.awaitingRegister, ["сделка", "сделки", "сделок"])}`);
    }
    const potentialHtml = potentialParts.length
      ? `<div class="tile-potential">${potentialParts.join(" · ")}</div>`
      : "";

    const callsLabel = P.closedMonth || activePeriod === "month" ? "Дозвоны за месяц" : activePeriod === "week" ? "Дозвоны за неделю" : "Дозвоны сегодня";
    const callsPct = calls.target > 0 ? Math.round((calls.fact / calls.target) * 100) : 0;

    let meSummaryHtml = "";
    if (me && !document.body.classList.contains("tv")) {
      const myMgr = P.groups.flatMap(g => g.managers).find(mgr => mgr.id === me);
      if (myMgr) {
        const monthSalesMgr = V.periods.month.sales.managers.find(mgr => mgr.id === me);
        const monthTenderMgr = V.periods.month.tenders?.managers.find(mgr => mgr.id === me);
        const monthMgr = monthSalesMgr || monthTenderMgr;
        const myFact = monthMgr?.contracts?.fact || 0;
        const myTarget = monthMgr?.contracts?.target || V.month.targetContracts || 0;
        const myAmount = monthMgr?.contracts?.totalAmount || 0;

        const periodSalesMgr = V.periods[activePeriod].sales.managers.find(mgr => mgr.id === me);
        const myCalls = periodSalesMgr?.calls;
        const myCallsFactStr = myCalls ? fmt(myCalls.fact) : "—";
        const myCallsTargetStr = myCalls && myCalls.target ? `/ ${fmt(myCalls.target)}` : "";
        const myCallsCls = myCalls?.cls || "";
        const myCallsSub = myCalls ? (myCalls.text || myCalls.sub || "") : "не звонит через CRM";

        const d = myMgr.debts || {};
        const dOverdue = d.overdue || 0;
        const dNew = d.newDeals || 0;
        const dWon = d.wonOnPortalNotClosed || 0;
        const totalDebts = dOverdue + dNew + dWon;
        const debtsBreakdown = [dWon ? `выиграно на портале: ${fmt(dWon)}` : "", dOverdue ? plural(dOverdue, ["дело просрочено", "дела просрочены", "дел просрочено"]) : "", dNew ? `${fmt(dNew)} без звонка` : ""].filter(Boolean).join(" · ") || "долгов нет ✓";

        meSummaryHtml = `
          <div class="me-summary">
            <div class="me-summary-head">
              <div class="me-badge">Мои показатели · ${esc(myMgr.name)}</div>
              <div class="me-period-note">${P.closedMonth ? "закрытый месяц" : (activePeriod === "day" ? "сегодня" : activePeriod === "week" ? "за неделю" : "за месяц")}</div>
            </div>
            <div class="me-summary-grid">
              <div class="me-stat">
                <span class="label">Договоры за месяц</span>
                <div class="stat-v">${fmt(myFact)} <span>/ ${fmt(myTarget)}</span></div>
                <div class="stat-sub">${money(myAmount) || "0 ₸"}</div>
              </div>
              <div class="me-stat">
                <span class="label">Дозвоны ${activePeriod === "day" ? "сегодня" : activePeriod === "week" ? "за неделю" : "за месяц"}</span>
                <div class="stat-v ${myCallsCls}">${myCallsFactStr} <span>${myCallsTargetStr}</span></div>
                <div class="stat-sub">${esc(myCallsSub)}</div>
              </div>
              <div class="me-stat">
                <span class="label">Долги на сегодня</span>
                <div class="stat-v ${totalDebts > 0 ? "bad" : "good"}">${totalDebts > 0 ? fmt(totalDebts) : "0"}</div>
                <div class="stat-sub">${esc(debtsBreakdown)}</div>
              </div>
            </div>
          </div>
        `;
      }
    }

    const prevMoreOpen = keepMoreOpen && document.querySelector("#month .month-more")?.open;

    document.getElementById("month").innerHTML = `
      <div class="block-head"><h2><span class="idx">01</span>${MONTHS[M - 1]}</h2><span class="meta">план ${fmt(m.plan)} · ${m.targetContracts} на менеджера × ${m.totalActiveCount}</span></div>
      ${meSummaryHtml}
      <div class="month-tiles">
        <div class="month-tile">
          <span class="label">Договоры</span>
          <div class="tile-value">${fmt(m.fact)} <span>/ ${fmt(m.plan)}</span></div>
          <div class="hbar"><span class="ink" style="width:${Math.max(0, Math.min(100, m.pct))}%"></span></div>
          <p class="tile-note">${P.closedMonth || m.daysLeft <= 0 ? `в среднем ${fmt1(m.pacePerDay)} в день` : `темп ${fmt1(m.pacePerDay)} в день, нужно ${fmt1(need)}`}</p>
        </div>
        <div class="month-tile">
          <span class="label">Выручка</span>
          <div class="tile-value tile-money">${money(m.amount) || "0 ₸"}${m.revenuePlan !== undefined ? ` <span>/ ${money(m.revenuePlan) || "0 ₸"}</span>` : ""}</div>
          <div class="hbar"><span class="ink" style="width:${Math.max(0, Math.min(100, revPct))}%"></span></div>
          <p class="tile-note">${m.revenuePlan !== undefined ? `без НДС · ${m.revenuePlan > 0 ? Math.round(m.amount / m.revenuePlan * 100) : 0}% плана выручки` : esc(m.sourceLabel)}</p>
          ${potentialHtml}
        </div>
        <div class="month-tile">
          <span class="label">${P.closedMonth ? "Итог месяца" : `Прогноз к ${m.daysInMonth}.${String(M).padStart(2, "0")}`}</span>
          ${P.closedMonth ? `<div class="tile-value tile-result">Итог: ${m.pct}% плана</div>` : m.hasForecast ? `<div class="tile-value">≈ ${fmt(m.forecast)} <span>/ ${fmt(m.plan)}</span></div><p class="tile-note">${m.fpct}% плана при нынешнем темпе</p>` : `<div class="tile-value tile-result">—, с 3-го дня</div>`}
        </div>
        <div class="month-tile">
          <span class="label">${callsLabel}</span>
          ${P.callsAvailable ? `<div class="tile-value ${calls.cls}">${fmt(calls.fact)} <span>/ ${fmt(calls.target)}</span></div><div class="hbar"><span class="${calls.cls || ''}" style="width:${Math.max(0, Math.min(100, callsPct))}%"></span></div><p class="tile-note">${esc(calls.text ? `${calls.text}${calls.sub ? ` · ${calls.sub}` : ""}` : (calls.sub || ""))}</p>` : `<div class="tile-value tile-result muted">нет доступа</div><p class="tile-note">нет звонков через Битрикс</p>`}
        </div>
      </div>
      <details class="month-more" ${document.body.classList.contains("tv") || prevMoreOpen ? "open" : ""}>
      <summary>График и подробности месяца</summary>
      <div class="hero">
        <div>
          <span class="label">Подписано с 1 ${MONTHS_GEN[M - 1]}</span>
          <div class="hero-num"><span class="big" data-count="${m.fact}">0</span><span class="of">/ ${fmt(m.plan)}</span></div>
          <div class="hero-amt">${money(m.amount) || "0 ₸"} <span class="muted">${m.revenuePlan !== undefined ? "без НДС · " : "· "}${m.pct}% плана договоров</span></div>
          <p class="muted contract-source">${esc(m.sourceLabel)}</p>
          ${m.revenuePlan !== undefined ? `<p>План выручки: ${money(m.revenuePlan) || '0 ₸'} без НДС</p>` : ''}
          ${m.awaitingRegister !== undefined ? `<p class="muted awaiting-register">ещё ${plural(m.awaitingRegister, ["сделка", "сделки", "сделок"])} в Битриксе, ждут ОП</p>` : ''}
          <p class="muted crm-comparison">в Битриксе отмечено ${plural(m.crmFact, ["сделка", "сделки", "сделок"])} на ${fmt1(m.crmAmount / 1e6)} млн</p>
          <div class="readout" ${P.closedMonth ? "hidden" : ""}>
            <div><span class="label">Темп</span><div class="v">${m.hasForecast ? `${fmt1(m.pacePerDay)}<small> в день</small>` : "—"}</div></div>
            <div><span class="label">Прогноз</span><div class="v">${m.hasForecast ? `≈ ${fmt(m.forecast)}<small> к ${m.daysInMonth}.${String(M).padStart(2, "0")}</small>` : `—<small> с 3-го дня</small>`}</div></div>
            <div><span class="label">До плана</span><div class="v">${fmt(m.left)}<small>${m.daysLeft <= 0 ? " не добрали" : ` за ${plural(Math.ceil(m.daysLeft), ["день", "дня", "дней"])}`}</small></div></div>
          </div>
          <p class="verdict">${m.verdict}</p>
          <div class="split">${m.split.map((x) => `<div class="split-row"><span>${esc(x.name)}</span><span class="trk"><span data-w="${x.widthPct}"></span></span><span class="num">${fmt(x.c)} · ${money(x.a) || "—"}</span></div>`).join("")}</div>
        </div>
        <div>
          <div class="chart-wrap" id="burnWrap">${m.hasContractDynamics ? burnup() : `<p class="muted">Дневная разбивка реестра ОП недоступна</p>`}<div class="tip" id="burnTip"></div></div>
          <div class="legend"><span><i></i>подписано</span><span><i class="dash"></i>${P.closedMonth ? "план" : "темп плана"}</span>${P.closedMonth ? "" : `<span><i class="dot"></i>прогноз</span>`}<span><i class="band"></i>выходные</span></div>
        </div>
      </div></details>`;
    wireBurnTip();
    const more = document.querySelector("#month .month-more");
    more.addEventListener("toggle", () => {
      if (more.open) animate(more);
      if (document.body.classList.contains("tv")) fitTv();
    });
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
    s += `<text x="${nowX}" y="${T - 10}" text-anchor="middle" font-family="JetBrains Mono" font-size="11" fill="#141414">${P.closedMonth ? "итог" : "сегодня"}</text>`;
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

  /* ================= «Я — …»: только моя строка и мои задачи ================= */
  // Выбор хранится в браузере человека. В ТВ всегда показывается вся команда.
  let me = "";
  let showAllTeam = false;
  try { me = localStorage.getItem("pult-me") || ""; } catch (e) {}
  function teamPeople() {
    const day = VIEW.periods.day;
    const all = [...day.sales.managers, ...(day.tenders ? day.tenders.managers : [])];
    return [...new Map(all.map((m) => [m.id, m.name])).entries()].map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }
  function myGroup(sp, tp) {
    if (!me || showAllTeam || document.body.classList.contains("tv")) return "";
    if (sp.managers.some((m) => m.id === me)) return "sales";
    if (tp && tp.managers.some((m) => m.id === me)) return "tenders";
    return "";
  }

  /* ================= team: sales and tenders in one table ================= */
  const NA_CELL = (label) => `<div class="cell na" data-l="${label}"><span class="muted">—</span></div>`;

  // Итог группы в тех же колонках, что и строки людей: цифра, полоска с отметкой темпа и оценка темпа.
  function groupCell(label, j) {
    if (j.untracked) return `<div class="cell" data-l="${label}"><div class="top"><span class="num muted">${fmt(j.fact)}</span></div><div class="sub">в CRM пока не отмечают</div></div>`;
    const state = `<span class="group-state ${j.cls === "idle" ? "" : j.cls}">${esc(j.text)}</span>`;
    return miniCell(label, { ...j, isEarlyEmpty: false, sub: state + (j.sub ? "<br>" + esc(j.sub) : "") });
  }

  function groupRow(id, name, meta, cells) {
    return `<div class="trow group" role="row" data-group="${id}">
        <div class="who"><div><div class="nm">${esc(name)}</div><div class="rl">${esc(meta)}</div></div></div>
        ${cells}
      </div>`;
  }

  function renderSales(period) {
    const sp = V.periods[period].sales;
    const tp = V.periods[period].tenders;
    const tc = sp.totals.calls, tk = sp.totals.proposals, tg = sp.totals.contracts;
    const people = sp.managers.length + (tp ? tp.managers.length : 0);
    const mine = myGroup(sp, tp);
    const callsTotal = P.callsAvailable ? groupCell("Дозвонились", tc) : `<div class="cell" data-l="Дозвонились"><span class="muted">нет доступа</span></div>`;
    const salesRows = mine === "tenders" ? [] : sp.managers.filter((m) => mine !== "sales" || m.id === me);
    const tenderRows = !tp || mine === "sales" ? [] : tp.managers.filter((m) => mine !== "tenders" || m.id === me);
    const el = document.getElementById("sales");
    el.innerHTML = `
      <div class="block-head"><h2><span class="idx">03</span>Команда ${sp.periodName}</h2><span class="meta">${mine ? "показана только ваша строка · «Я — …» в полосе периода" : `${plural(people, ["человек", "человека", "человек"])} · строка раскрывает долги и задачи`}</span></div>
      ${sp.isEarly ? `<p class="early">${sp.earlyText}</p>` : ""}
      <div class="team" role="table" aria-label="Команда: отдел продаж и тендерный отдел">
        <div class="trow head label" role="row"><span>Менеджер</span><span>Дозвонился</span><span>КП</span><span>Подписал</span><span>Долги сегодня</span><span></span></div>
        ${mine === "tenders" ? "" : groupRow("sales", sp.name, sp.meta, callsTotal + groupCell("КП", tk) + groupCell("Подписали", tg))}
        ${salesRows.map((m) => managerRow(m, period)).join("")}
        ${tp && mine !== "sales" ? groupRow("tenders", tp.name, tp.meta, NA_CELL("Дозвонился") + NA_CELL("КП") + groupCell("Подписали", tp.totals.contracts)) : ""}
        ${tenderRows.map(tenderRow).join("")}
      </div>
      ${mine ? `<button type="button" class="btn team-all">Показать всю команду (${fmt(people)})</button>` : ""}`;
    wireRows(el);
    if (mine) {
      el.querySelector(".team-all").addEventListener("click", () => {
        showAllTeam = true;
        renderSales(period);
        if (el.classList.contains("in")) animate(el);
      });
    }
  }

  function tenderRow(m) {
    const id = "t-" + m.id;
    const isSingle = !showAllTeam && me === m.id && !document.body.classList.contains("tv");
    return `<div class="trow body tender" role="row" tabindex="0" aria-expanded="${isSingle ? "true" : "false"}" aria-controls="${id}">
        <div class="who"><span class="mono-av">${esc(m.initials)}</span><div><div class="nm">${esc(m.name)}</div><div class="rl">${m.tasksCountText || ""}</div></div></div>
        ${NA_CELL("Дозвонился")}${NA_CELL("КП")}${miniCell("Подписал", m.contracts)}${debtsCell(m.debts)}
        <span class="chev" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 4.5 6 8.5l4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></span>
      </div><div class="detail ${isSingle ? "open" : ""}" id="${id}"><div>${managerDetail(m)}</div></div>`;
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
    const badge = (key, cls, text) => P.closedMonth
      ? `<span class="${cls}">${text}</span>`
      : `<button type="button" class="debt-button ${cls}" data-debt="${key}">${text}</button>`;
    if (d.wonOnPortalNotClosed) out.push(badge("wonOnPortalNotClosedDeals", "bad", `выиграно на портале: ${fmt(d.wonOnPortalNotClosed)}`));
    if (d.overdue) out.push(badge("overdueList", "bad", plural(d.overdue, ["дело просрочено", "дела просрочены", "дел просрочено"])));
    if (d.newDeals) out.push(badge("newDealsList", "warn", `${plural(d.newDeals, ["новая", "новые", "новых"])} без звонка`));
    if (d.readyToCloseDealIds && d.readyToCloseDealIds.length) out.push(badge("readyToCloseDeals", "muted", `${fmt(d.readyToCloseDealIds.length)} пора закрыть`));
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
    const isSingle = !showAllTeam && me === m.id && !document.body.classList.contains("tv");
    return `<div class="trow body" role="row" tabindex="0" aria-expanded="${isSingle ? "true" : "false"}" aria-controls="${id}">
        <div class="who"><span class="mono-av">${esc(m.initials)}</span><div><div class="nm">${esc(m.name)}</div><div class="rl">${m.tasksCountText}</div></div></div>
        ${calls}${kp}${c}${debtsCell(m.debts)}
        <span class="chev" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 4.5 6 8.5l4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></span>
      </div>
      <div class="detail ${isSingle ? "open" : ""}" id="${id}"><div>${managerDetail(m)}</div></div>`;
  }

  function debtList(key, label, items, total) {
    const old = key === "overdueOverMonthTasks";
    if (!total || (old ? !items || !items.length : P.closedMonth)) return "";
    const list = (items || []).slice(0, 50);
    const rows = list.map((item, index) => {
      const ct = cleanTitle(item);
      const url = P.portal + "/crm/deal/details/" + encodeURIComponent(item.dealId) + "/";
      let note = "";
      if (key === "newDealsList") note = "без звонка " + plural(item.ageDays || 0, ["день", "дня", "дней"]);
      if (key === "overdueList" || key === "overdueOverMonthTasks") note = "просрочено " + plural(item.overdueDays || 0, ["день", "дня", "дней"]);
      if (key === "wonOnPortalNotClosedDeals" && item.portalSignDate) note = "подписан " + ddmm(item.portalSignDate);
      return `<div class="old-task-item debt-list-item"${index >= 10 ? " hidden" : ""}><a href="${esc(url)}" target="_blank" rel="noopener" class="old-task-link">${esc(ct.title || item.title || item.dealId)}</a><span class="old-task-meta">${esc(money(item.amount) || "сумма не указана")}${note ? " · " + esc(note) : ""}</span></div>`;
    }).join("");
    const remaining = Math.max(0, total - list.length);
    return `<details class="debt-list${old ? " old-tasks" : ""}" data-debt-list="${key}"><summary class="old-tasks-sum">${old ? "Показать список 30+ дней" : "Показать список: " + esc(label)} (${fmt(total)})</summary><div class="old-tasks-list">${rows}</div>${list.length > 10 ? `<button type="button" class="debt-more">показать ещё ${fmt(list.length - 10)}</button>` : ""}${remaining ? `<div class="muted">и ещё ${fmt(remaining)} в Битриксе</div>` : ""}</details>`;
  }

  function managerDetail(m) {
    const d = m.debts || { overdue: 0, overdueOverMonth: 0, overdueOverMonthTasks: [], newDeals: 0, newOldestAgeDays: 0, readyToCloseDealIds: [] };

    const tasks = (m.topTasks || []).map((t) => taskRow(t, m, true)).join("");
    return `<div class="detail-in">
      <div class="dstats">
        <div style="grid-column:1/-1" class="dstats-actions"><button type="button" class="copy-chat-btn" data-copy-manager="${esc(m.id)}">Скопировать для чата</button></div>
        ${d.wonOnPortalNotClosed ? `<div style="grid-column:1/-1"><span class="label">Выиграно на портале, не закрыто в CRM</span><span class="num bad">${fmt(d.wonOnPortalNotClosed)}</span></div>` : ""}
        <div><span class="label">Просрочено</span><span class="num ${d.overdue ? "bad" : ""}">${fmt(d.overdue)}</span></div>
        <div><span class="label">30+ дней</span><span class="num">${fmt(d.overdueOverMonth)}</span></div>
        <div><span class="label">Без звонка</span><span class="num ${d.newDeals ? "warn" : ""}">${fmt(d.newDeals)}</span></div>
        <div><span class="label">Самой старой</span><span class="num">${d.newDeals ? fmt(d.newOldestAgeDays) + " дн." : "—"}</span></div>
        <div style="grid-column:1/-1"><span class="label">Пора закрыть</span><span class="num">${fmt(d.readyToCloseDealIds.length)}</span></div>
      </div>
      <div class="manager-urgent">${tasks || `<div class="mini-empty">Срочных задач нет.</div>`}</div>
      ${debtList("wonOnPortalNotClosedDeals", "выиграно на портале", d.wonOnPortalNotClosedDeals, d.wonOnPortalNotClosed)}
      ${debtList("overdueList", "просрочено", d.overdueList, d.overdue)}
      ${debtList("newDealsList", "без звонка", d.newDealsList, d.newDeals)}
      ${debtList("readyToCloseDeals", "пора закрыть", d.readyToCloseDeals, d.readyToCloseDealIds.length)}
      ${debtList("overdueOverMonthTasks", "30+ дней", d.overdueOverMonthTasks, d.overdueOverMonth)}
    </div>`;
  }

  function wireRows(root) {
    root.querySelectorAll(".debt-more").forEach((button) => {
      button.addEventListener("click", () => {
        button.closest(".debt-list").querySelectorAll(".old-task-item[hidden]").forEach(item => { item.hidden = false; });
        button.hidden = true;
      });
    });
    root.querySelectorAll("button[data-copy-manager]").forEach((button) => {
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        const mgrId = button.dataset.copyManager;
        const allMgrs = P.groups.flatMap(g => g.managers);
        const mgr = allMgrs.find(x => x.id === mgrId);
        if (!mgr) return;
        const d = mgr.debts || {};
        const lines = [`${mgr.name} — проблемы по сделкам:`];
        const wonDeals = d.wonOnPortalNotClosedDeals || [];
        if (wonDeals.length) {
          lines.push(`\nВыиграно на портале, не закрыто в CRM (${wonDeals.length}):`);
          wonDeals.forEach((item, i) => {
            lines.push(`  ${i + 1}. ${item.title || item.dealId} (${money(item.amount) || "—"}) — ${dealUrl(item.dealId)}`);
          });
        }
        const overdueDeals = d.overdueList || [];
        if (overdueDeals.length) {
          lines.push(`\nПросрочено (${overdueDeals.length}):`);
          overdueDeals.forEach((item, i) => {
            lines.push(`  ${i + 1}. ${item.title || item.dealId} (${money(item.amount) || "—"}, просрочено ${item.overdueDays || 0} дн.) — ${dealUrl(item.dealId)}`);
          });
        }
        const newDeals = d.newDealsList || [];
        if (newDeals.length) {
          lines.push(`\nНовые без звонка (${newDeals.length}):`);
          newDeals.forEach((item, i) => {
            lines.push(`  ${i + 1}. ${item.title || item.dealId} (${money(item.amount) || "—"}, без звонка ${item.ageDays || 0} дн.) — ${dealUrl(item.dealId)}`);
          });
        }
        const readyDeals = d.readyToCloseDeals || [];
        if (readyDeals.length) {
          lines.push(`\nПора закрыть (${readyDeals.length}):`);
          readyDeals.forEach((item, i) => {
            lines.push(`  ${i + 1}. ${item.title || item.dealId} — ${dealUrl(item.dealId)}`);
          });
        }
        const myMismatches = (P.outcomeMismatches || []).filter(om => om.managerId === mgr.id);
        if (myMismatches.length) {
          lines.push(`\nОшибки стадии (выиграно на портале, в CRM проигрыш, ${myMismatches.length}):`);
          myMismatches.forEach((item, i) => {
            lines.push(`  ${i + 1}. ${item.title} (${money(item.amount) || "—"}) — ${dealUrl(item.id)}`);
          });
        }
        if (lines.length === 1) {
          lines.push("Проблемных сделок нет ✓");
        }
        copyToClipboard(lines.join("\n"), button);
      });
    });
    root.querySelectorAll(".trow.body").forEach((row) => {
      const toggle = () => {
        const open = row.getAttribute("aria-expanded") !== "true";
        row.setAttribute("aria-expanded", String(open));
        const target = document.getElementById(row.getAttribute("aria-controls"));
        if (target) target.classList.toggle("open", open);
      };
      row.querySelectorAll("button[data-debt]").forEach((button) => {
        button.addEventListener("click", (e) => {
          e.stopPropagation();
          if (row.getAttribute("aria-expanded") !== "true") toggle();
          const target = document.getElementById(row.getAttribute("aria-controls"));
          const list = target && target.querySelector(`details[data-debt-list="${button.dataset.debt}"]`);
          if (list) {
            list.open = true;
            // Wait for the detail's grid expansion before measuring the scroll target.
            requestAnimationFrame(() => {
              Promise.all(target.getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => {
                if (row.getAttribute("aria-expanded") === "true" && list.open) {
                  const headerBottom = document.querySelector(".dateline")?.getBoundingClientRect().bottom || 0;
                  list.style.scrollMarginTop = Math.max(0, headerBottom) + 8 + "px";
                  list.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
                }
              });
            });
          }
        });
      });
      row.addEventListener("click", (e) => { if (!e.target.closest("a, button")) toggle(); });
      row.addEventListener("keydown", (e) => {
        if (e.target.closest("a, button")) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });
  }

  /* ================= calls ================= */
  let callsMoreOpen = false;
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
      <details class="calls-more"${document.body.classList.contains("tv") || callsMoreOpen ? " open" : ""}>
      <summary>График звонков и кто как звонит</summary>
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
      </div>
      </details>`;
    document.getElementById("calls").innerHTML = html;
    wireCallsTip();
    const more = document.querySelector("#calls .calls-more");
    // Выбор человека запоминаем по клику на заголовок (Enter и пробел тоже дают click):
    // программное раскрытие в ТВ и перерисовка при смене периода его не меняют.
    more.querySelector("summary").addEventListener("click", () => { callsMoreOpen = !more.open; });
    more.addEventListener("toggle", () => {
      if (more.open) animate(more);
      if (document.body.classList.contains("tv")) fitTv();
    });
    animate(document.getElementById("calls"));
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
        <div class="kick"><span class="label">${esc(t.subject || "Дело")}</span>${ct.plan ? `<span class="tag">план ${esc(ct.plan)}</span>` : ""}${t.planStatus ? `<span class="tag">${esc(t.planStatus)}</span>` : ""}${t.passedPlanMonthNote ? `<span class="tag warn">${esc(t.passedPlanMonthNote)}</span>` : ""}${t.contactedAfterDeadlineNote ? `<span class="tag good">${esc(t.contactedAfterDeadlineNote)}</span>` : ""}${t.responsibleNote ? `<span class="tag">${esc(t.responsibleNote)}</span>` : ""}</div>
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
    if (!all.length) { el.innerHTML = `<div class="block-head"><h2><span class="idx">05</span>Что сделать сегодня</h2></div><div class="mini-empty">Срочных задач нет.</div>`; return; }
    const owners = [...new Map(all.map((x) => [x.m.id, x.m])).values()];
    if (taskFilter !== "all" && !owners.some((m) => m.id === taskFilter)) taskFilter = "all";
    const list = all.filter((x) => taskFilter === "all" || x.m.id === taskFilter)
      .sort((a, b) => (a.t.group || 9) - (b.t.group || 9) || (a.t.passedPlanMonthNote ? 1 : 0) - (b.t.passedPlanMonthNote ? 1 : 0) || (b.t.amount || 0) - (a.t.amount || 0) || String(a.t.deadline || "").localeCompare(String(b.t.deadline || "")));
    const sumAmt = list.reduce((s, x) => s + (x.t.amount || 0), 0);
    el.innerHTML = `
      <div class="block-head"><h2><span class="idx">05</span>Что сделать сегодня</h2><span class="meta">${plural(list.length, ["задача", "задачи", "задач"])} · сделки на ${money(sumAmt)}</span></div>
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
      const m = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(PAYLOAD.generatedAt);
      let ago = "";
      if (m) {
        const gen = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 5, +m[5]);
        const mins = Math.round((Date.now() - gen) / 60000);
        if (mins >= 0 && mins < 60 * 24) ago = mins < 1 ? "только что" : mins < 60 ? plural(mins, ["минуту", "минуты", "минут"]) + " назад" : plural(Math.floor(mins / 60), ["час", "часа", "часов"]) + " назад";
        live.classList.toggle("stale", mins > 90);
      }
      liveText.innerHTML = `Данные на ${VIEW.genLabel}` + (ago ? ` <span class="ago">· ${ago}</span>` : "");
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
    root.querySelectorAll("[data-h]").forEach((b) => { b.style.height = b.dataset.h + "%"; });
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
  function setPeriod(p, fromUser, keepMore = true) {
    if (P.closedMonth) p = "month";
    period = p;
    btns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.p === p)));
    moveInd();
    renderMonth(keepMore);
    renderSales(p); renderCalls(p);
    ["month", "sales", "calls"].forEach((id) => { const s = document.getElementById(id); if (s && s.classList.contains("in")) animate(s); });
    try { if (fromUser) localStorage.setItem("pult-period", p); } catch (e) {}
  }
  btns.forEach((b) => b.addEventListener("click", () => setPeriod(b.dataset.p, true)));
  addEventListener("resize", () => { moveInd(); if (typeof moveSecInd === "function") moveSecInd(); });
  addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea")) return;
    if (e.key === "1") setPeriod("day", true); else if (e.key === "2") setPeriod("week", true); else if (e.key === "3") setPeriod("month", true);
    else if (e.key === "t" || e.key === "T" || e.key === "е" || e.key === "Е") toggleTv();
  });

  /* ================= tabs ================= */
  const tabLinks = [...document.querySelectorAll(".sections a[data-t]")];
  const tabPanes = {
    pult: document.getElementById("tab-pult"),
    ip: document.getElementById("tab-ip"),
    kt: document.getElementById("tab-kt"),
    "plans-ip": document.getElementById("tab-plans-ip"),
    "plans-kt": document.getElementById("tab-plans-kt"),
    "radar-ip": document.getElementById("tab-radar-ip"),
    "radar-kt": document.getElementById("tab-radar-kt")
  };
  const secInd = document.querySelector(".sections .ind");
  const periodsNav = document.getElementById("periodsNav");
  const marketMonths = document.getElementById("marketMonths");
  const selectedMarketMonth = { ip: null, kt: null };
  const renderedMarketMonth = { ip: null, kt: null };
  const planMonths = document.getElementById("planMonths");
  const selectedPlanMonth = { "plans-ip": "all", "plans-kt": "all" };
  const isPlansTab = tab => tab === "plans-ip" || tab === "plans-kt";
  const isRadarTab = tab => tab === "radar-ip" || tab === "radar-kt";
  const plansBase = tab => tab === "plans-ip" ? PAYLOAD.plans?.ip : PAYLOAD.plans?.kt;
  const validPlanMonth = (tab, month) => window.__planMonths(plansBase(tab)).includes(month) ? month : "all";
  let currentTab = "pult";
  let preTvTab = "pult";
  // Разделы: «Сегодня», «Радар», «Выручка» (страница реестра), «Планы» и «Рынок».
  // Внутри «Радара», «Планов» и «Рынка» товар (ИП или КТ) выбирается переключателем и сохраняется при переходе между ними.
  let product = "ip";
  const productSwitch = document.getElementById("productSwitch");
  const sectionOf = tab => tab === "pult" ? "pult" : isRadarTab(tab) ? "radar" : isPlansTab(tab) ? "plans" : "market";
  const productOf = tab => tab === "kt" || tab === "plans-kt" || tab === "radar-kt" ? "kt" : "ip";
  const tabFor = (section, prod) => section === "radar" ? "radar-" + prod : section === "plans" ? "plans-" + prod : section === "market" ? prod : "pult";

  function moveSecInd() {
    const a = tabLinks.find((x) => x.dataset.t === sectionOf(currentTab));
    if (!a || !secInd) return;
    secInd.style.left = a.offsetLeft + 14 + "px";
    secInd.style.width = a.offsetWidth - 28 + "px";
  }

  function marketBase(tab) {
    return tab === "ip" ? PAYLOAD.market?.ip : PAYLOAD.market?.kt;
  }
  function validMarketMonth(tab, month) {
    const base = marketBase(tab);
    return window.__marketMonths(base).includes(month) ? month : base?.month;
  }
  function renderMarketMonths(tab) {
    if (!marketMonths) return;
    const isMarket = tab === "ip" || tab === "kt";
    const months = isMarket ? window.__marketMonths(marketBase(tab)) : [];
    marketMonths.hidden = months.length === 0;
    const multipleYears = new Set(months.map(m => m.slice(0, 4))).size > 1;
    marketMonths.innerHTML = months.map(month => {
      const name = MONTHS[Number(month.slice(5)) - 1];
      const label = name[0].toUpperCase() + name.slice(1);
      const fullLabel = `${label} ${month.slice(0, 4)}`;
      return `<button type="button" data-month="${month}" title="${fullLabel}" aria-pressed="${month === selectedMarketMonth[tab]}">${multipleYears ? fullLabel : label}</button>`;
    }).join("");
  }
  function renderTabContent(tab) {
    if (isRadarTab(tab)) {
      if (window.__renderRadarTab) window.__renderRadarTab(tab, PAYLOAD.radar, tabPanes[tab]);
      return;
    }
    if (isPlansTab(tab)) {
      window.__renderPlansTab(tab, PAYLOAD.plans, tabPanes[tab], selectedPlanMonth[tab]);
      return;
    }
    if ((tab !== "ip" && tab !== "kt") || !window.__renderMarketTab) return;
    const month = selectedMarketMonth[tab];
    if (renderedMarketMonth[tab] === month) return;
    if (io) tabPanes[tab].querySelectorAll(".reveal").forEach(el => io.unobserve(el));
    window.__renderMarketTab(tab, PAYLOAD.market, tabPanes[tab], month);
    renderedMarketMonth[tab] = month;
  }
  function selectMarketMonth(month) {
    if (currentTab !== "ip" && currentTab !== "kt") return;
    month = validMarketMonth(currentTab, month);
    if (month === selectedMarketMonth[currentTab]) return;
    selectedMarketMonth[currentTab] = month;
    renderTabContent(currentTab);
    if (marketMonths) marketMonths.querySelectorAll("button[data-month]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.month === month));
    });
    animate(tabPanes[currentTab]);
    observe();
    history.replaceState(null, "", `#${currentTab}/${month}`);
  }
  if (marketMonths) marketMonths.addEventListener("click", e => {
    const button = e.target.closest("button[data-month]");
    if (button) selectMarketMonth(button.dataset.month);
  });
  ["ip", "kt"].forEach(tab => {
    const pane = tabPanes[tab];
    if (!pane) return;
    pane.addEventListener("click", e => {
      const month = e.target.closest(".months .col[data-m], .mlabels > span[data-m]");
      if (month) selectMarketMonth(month.dataset.m);
    });
    pane.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches(".months .col[data-m], .mlabels > span[data-m]")) {
        e.preventDefault();
        selectMarketMonth(e.target.dataset.m);
      }
    });
  });

  function renderPlanMonths(tab) {
    if (!planMonths) return;
    planMonths.hidden = !isPlansTab(tab);
    planMonths.innerHTML = isPlansTab(tab) ? window.__planMonths(plansBase(tab)).map(month =>
      `<button type="button" data-month="${month}" aria-pressed="${month === selectedPlanMonth[tab]}">${month === "all" ? "Все месяцы" : MONTHS[Number(month.slice(5)) - 1] + " " + month.slice(0, 4)}</button>`
    ).join("") : "";
    window.__scrollPlanSelection(planMonths);
  }
  function selectPlanMonth(month, toggle) {
    if (!isPlansTab(currentTab)) return;
    month = validPlanMonth(currentTab, month);
    if (toggle && selectedPlanMonth[currentTab] === month) month = "all";
    selectedPlanMonth[currentTab] = month;
    renderTabContent(currentTab);
    renderPlanMonths(currentTab);
    observe();
    history.replaceState(null, "", `#${currentTab}/${month}`);
  }
  if (planMonths) planMonths.addEventListener("click", e => {
    const button = e.target.closest("button[data-month]");
    if (button) selectPlanMonth(button.dataset.month, false);
  });
  ["plans-ip", "plans-kt"].forEach(tab => {
    const pane = tabPanes[tab];
    pane.addEventListener("click", e => {
      const month = e.target.closest(".months .col[data-m], .mlabels > span[data-m]");
      if (month) selectPlanMonth(month.dataset.m, true);
    });
    pane.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches(".months .col[data-m], .mlabels > span[data-m]")) {
        e.preventDefault();
        selectPlanMonth(e.target.dataset.m, true);
      }
    });
  });

  function setTab(tab, fromUser, marketMonth) {
    if (!Object.prototype.hasOwnProperty.call(tabPanes, tab)) tab = "pult";
    if (isPlansTab(tab)) selectedPlanMonth[tab] = validPlanMonth(tab, marketMonth !== undefined ? marketMonth : selectedPlanMonth[tab]);
    if (tab === "ip" || tab === "kt") {
      selectedMarketMonth[tab] = validMarketMonth(tab, marketMonth !== undefined ? marketMonth : selectedMarketMonth[tab]);
    }
    currentTab = tab;
    if (tab !== "pult") product = productOf(tab);
    tabLinks.forEach((link) => {
      const active = link.dataset.t === sectionOf(tab);
      if (link.dataset.t !== "pult") link.setAttribute("href", "#" + tabFor(link.dataset.t, product));
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    Object.keys(tabPanes).forEach((key) => {
      const pane = tabPanes[key];
      if (pane) pane.classList.toggle("on", key === tab);
    });
    if (periodsNav) {
      if (isRadarTab(tab)) {
        periodsNav.hidden = false;
        periodsNav.classList.add("radar-mode");
      } else {
        periodsNav.classList.remove("radar-mode");
        periodsNav.hidden = tab !== "pult";
      }
    }
    if (productSwitch) {
      productSwitch.hidden = tab === "pult";
      productSwitch.querySelectorAll("button[data-product]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.product === product)));
    }
    renderTabContent(tab);
    renderMarketMonths(tab);
    renderPlanMonths(tab);
    moveSecInd();

    const srcLabel = document.getElementById("srcLabel");
    const foot = document.getElementById("foot");
    if (isPlansTab(tab)) {
      if (srcLabel) srcLabel.textContent = "CRM Битрикс24 · госзакупки";
      if (foot) foot.innerHTML = `<span>Источник: сделки планов в Битрикс24 (scrape2lead-gz-plans) и сверка с zakup.gov.kz</span>`;
    } else if (isRadarTab(tab)) {
      if (srcLabel) srcLabel.textContent = "CRM Битрикс24 · радар лотов";
      if (foot) foot.innerHTML = `<span>Источник: сделки лотов (воронка 43) и планов (9, 41, 29) Битрикс24</span>`;
    } else if (tab === "ip" || tab === "kt") {
      if (srcLabel) srcLabel.textContent = "госзакупки · zakup.gov.kz";
      if (foot) foot.innerHTML = `<span>Источник: API госзакупок, договоры по дате подписания</span><span>Обновляется раз в день, утром</span>`;
    } else {
      if (srcLabel) srcLabel.textContent = "CRM Битрикс24";
      if (foot) foot.innerHTML = `<span>Источник: Битрикс24 · ft3.bitrix24.kz</span><span>Обновляется каждый час с 09:00 до 19:00 в будни · клавиши 1 2 3 и T</span>`;
    }

    if (tab === "pult") {
      setTimeout(moveInd, 0);
    }
    observe();
    if (fromUser) {
      try { localStorage.setItem("pult-tab", tab); } catch (e) {}
      if (history.replaceState) {
        history.replaceState(null, "", `#${tab === "pult" ? "pult/" + selectedMonth : isRadarTab(tab) ? tab : tab + "/" + (isPlansTab(tab) ? selectedPlanMonth[tab] : selectedMarketMonth[tab])}`);
      } else {
        location.hash = tab;
      }
    }
  }

  tabLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      setTab(tabFor(link.dataset.t, product), true);
    });
  });
  if (productSwitch) productSwitch.addEventListener("click", (e) => {
    const button = e.target.closest("button[data-product]");
    if (button && currentTab !== "pult") setTab(tabFor(sectionOf(currentTab), button.dataset.product), true);
  });

  window.addEventListener("hashchange", () => {
    const [tab, month] = location.hash.replace(/^#/, "").split("/");
    if (tab === "ip" || tab === "kt" || isPlansTab(tab) || isRadarTab(tab)) {
      setTab(tab, false, month || null);
    } else if (tab === "pult" || tab === "reg") {
      selectMonth(tab === "pult" ? month || currentMonth : currentMonth);
      setTab("pult", false);
    }
  });

  /* ================= TV ================= */
  let tvTimer = null;
  const SCENES = ["month", "sales", "calls", "signals"].filter((id) => document.getElementById(id));
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
    const more = document.querySelector("#month .month-more");
    if (more) more.open = on;
    const callsMore = document.querySelector("#calls .calls-more");
    if (callsMore) callsMore.open = on || callsMoreOpen;
    // В ТВ — вся команда, после выхода снова «Я — …».
    renderMonth();
    renderSignals();
    renderSales(period);
    const errors = document.querySelector("#signals .outcome-mismatches");
    if (errors) errors.open = false;
    const searchModal = document.getElementById("searchModal");
    if (searchModal && searchModal.open) searchModal.close();
    const tvBtn = document.getElementById("tvBtn");
    if (tvBtn) tvBtn.textContent = on ? "Выйти из ТВ" : "Режим ТВ";
    clearInterval(tvTimer);
    const bar = document.getElementById("tvCycle");
    SCENES.forEach((id) => { const el = document.getElementById(id); if (el) el.classList.remove("scene"); });
    fitTv();
    if (on) {
      selectMonth(currentMonth);
      preTvTab = currentTab;
      if (currentTab !== "pult") setTab("pult", false);
      if (period !== "day") setPeriod("day");
      let i = 0, t0 = Date.now(); const every = 15000;
      showScene(i);
      tvTimer = setInterval(() => {
        const p = (Date.now() - t0) / every; if (bar) bar.style.width = Math.min(100, p * 100) + "%";
        if (p >= 1) { i = (i + 1) % SCENES.length; showScene(i); t0 = Date.now(); }
      }, 200);
    } else {
      if (bar) bar.style.width = "0";
      if (preTvTab && preTvTab !== "pult") {
        setTab(preTvTab, false);
      }
    }
  }
  const tvBtn = document.getElementById("tvBtn");
  if (tvBtn) tvBtn.addEventListener("click", toggleTv);

  setTimeout(() => location.reload(), 15 * 60 * 1000);

  const monthSelect = document.getElementById("monthSelect");
  const monthKeys = [0, 1, 2].map((offset) => {
    const [y, m] = currentMonth.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1 - offset, 1)).toISOString().slice(0, 7);
  });
  // Ключ месяца приходит и из адреса: служебные имена вроде "constructor" не должны находить «месяц».
  const hasClosedMonth = (key) => Object.prototype.hasOwnProperty.call(VIEW.closedMonths || {}, key) && !!VIEW.closedMonths[key];
  monthSelect.innerHTML = monthKeys.map((key) => {
    const available = key === currentMonth || hasClosedMonth(key);
    return `<option value="${esc(key)}" ${available ? "" : "disabled"}>${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}${available ? "" : " · недоступен"}</option>`;
  }).join("");
  function selectMonth(key) {
    if (document.body.classList.contains("tv")) key = currentMonth;
    if (key !== currentMonth && !hasClosedMonth(key)) key = currentMonth;
    selectedMonth = key;
    P = key === currentMonth ? PAYLOAD : PAYLOAD.closedMonths[key];
    V = key === currentMonth ? VIEW : VIEW.closedMonths[key];
    monthSelect.value = key;
    document.getElementById("dateLabel").textContent = V.dateLabel;
    document.getElementById("wdLabel").textContent = P.closedMonth ? "Закрытый месяц" : V.wdLabel;
    document.getElementById("monthFill").style.width = P.closedMonth ? "100%" : V.monthFillPct + "%";
    btns.forEach((b) => { b.hidden = !!P.closedMonth && b.dataset.p !== "month"; });
    document.getElementById("signals").hidden = !!P.closedMonth;
    document.getElementById("tasks").hidden = !!P.closedMonth;
    document.getElementById("closedNotice").hidden = !P.closedMonth;
    renderMonth(false); renderSignals(); renderTasks();
    setPeriod(P.closedMonth ? "month" : period, false, false);
    animate(document.getElementById("month"));
    observe();
  }
  monthSelect.addEventListener("change", () => {
    selectMonth(monthSelect.value);
    history.replaceState(null, "", `#pult/${selectedMonth}`);
  });
  function measureBars() {
    document.documentElement.style.setProperty("--bar-height", document.querySelector(".bar").offsetHeight + "px");
    document.documentElement.style.setProperty("--period-height", document.querySelector(".dateline").offsetHeight + "px");
  }
  const barsObserver = new ResizeObserver(measureBars);
  barsObserver.observe(document.querySelector(".bar"));
  barsObserver.observe(document.querySelector(".dateline"));
  measureBars();

  const meSelect = document.getElementById("meSelect");
  const people = teamPeople();
  if (me && !people.some((p) => p.id === me)) me = "";
  if (me) taskFilter = me;
  meSelect.innerHTML = `<option value="">вся команда</option>` + people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  meSelect.value = me;
  meSelect.addEventListener("change", () => {
    me = meSelect.value;
    showAllTeam = false;
    try { if (me) localStorage.setItem("pult-me", me); else localStorage.removeItem("pult-me"); } catch (e) {}
    taskFilter = me || "all"; taskAll = false;
    renderMonth(); renderSignals(); renderSales(period); renderTasks();
    if (isRadarTab(currentTab) || isPlansTab(currentTab)) renderTabContent(currentTab);
    ["month", "signals", "sales", "tasks"].forEach((id) => { const s = document.getElementById(id); if (s && s.classList.contains("in")) animate(s); });
  });

  /* ================= quick search ================= */
  function initQuickSearch() {
    const modal = document.getElementById("searchModal");
    const input = document.getElementById("quickSearchInput");
    const results = document.getElementById("searchResults");
    const searchBtn = document.getElementById("searchBtn");
    if (!modal || !input || !results) return;

    let selectedIndex = -1;
    let currentResults = [];

    function buildSearchIndex() {
      const items = [];
      const seenDeals = new Set();
      const root = (typeof PAYLOAD !== "undefined" && PAYLOAD) ? PAYLOAD : P;

      const addDeal = (d, mgrName, context) => {
        const id = String(d.dealId || d.id || "");
        if (!id || seenDeals.has(id)) return;
        seenDeals.add(id);
        const ct = cleanTitle(d);
        items.push({
          type: "deal",
          id,
          title: ct.title || d.title || id,
          planNumber: ct.plan || d.planNumber || "",
          manager: mgrName || d.managerName || "",
          amount: d.amount || 0,
          context: context || "Сделка",
          url: dealUrl(id)
        });
      };

      for (const g of root.groups || []) {
        for (const m of g.managers || []) {
          for (const t of m.topTasks || []) addDeal(t, m.name, "Срочная задача");
          const debts = m.debts || {};
          for (const d of debts.wonOnPortalNotClosedDeals || []) addDeal(d, m.name, "Выиграно на портале");
          for (const d of debts.overdueList || []) addDeal(d, m.name, "Просрочено");
          for (const d of debts.newDealsList || []) addDeal(d, m.name, "Новая без звонка");
          for (const d of debts.readyToCloseDeals || []) addDeal(d, m.name, "Пора закрыть");
          for (const d of debts.overdueOverMonthTasks || []) addDeal(d, m.name, "30+ дней");
        }
      }

      for (const om of root.outcomeMismatches || []) {
        addDeal(om, om.managerName, "Ошибка в CRM");
      }

      for (const group of [root.plans?.ip, root.plans?.kt]) {
        if (!group) continue;
        for (const p of group.openPlans || []) {
          items.push({
            type: "plan",
            id: String(p.id || ""),
            title: `${p.customerName || "Заказчик"} · ${p.itemName || "Товар"}`,
            planNumber: String(p.planNumber || ""),
            customerBin: String(p.customerBin || ""),
            manager: p.managerName || "",
            sum: p.sum || 0,
            context: `План ${group.group === "КТ" ? "КТ" : "ИП"} · ${p.portalStatus || "В работе"}`,
            dealUrl: p.dealUrl || dealUrl(p.id),
            planUrl: p.planUrl || ""
          });
        }
      }

      for (const [tabKey, group] of [["ip", root.market?.ip], ["kt", root.market?.kt]]) {
        if (!group) continue;
        const addCust = (c) => {
          if (!c || !c.name) return;
          items.push({
            type: "market",
            title: c.name,
            bin: String(c.bin || ""),
            manager: "",
            amount: c.sum || 0,
            context: `Рынок ${tabKey.toUpperCase()} · Заказчик`,
            tab: tabKey
          });
        };
        const addSupp = (s) => {
          if (!s || !s.name) return;
          items.push({
            type: "market",
            title: s.name,
            bin: String(s.bin || ""),
            manager: "",
            amount: s.sum || 0,
            context: `Рынок ${tabKey.toUpperCase()} · Поставщик${s.us ? " (мы)" : ""}`,
            tab: tabKey
          });
        };
        (group.customers || []).forEach(addCust);
        (group.suppliers || []).forEach(addSupp);
      }

      // 5. Radar lots
      if (root.radar) {
        for (const prodKey of ["ip", "kt"]) {
          const rGroup = root.radar[prodKey];
          if (!rGroup) continue;
          const allRadarCards = [
            ...(rGroup.submitToday || []),
            ...(rGroup.discussion || []),
            ...(rGroup.secondChance || [])
          ];
          for (const card of allRadarCards) {
            const id = String(card.id || "");
            const title = card.itemName ? `${card.itemName}${card.qty ? ` (${card.qty} шт.)` : ""}` : (card.title || id);
            const lotNo = card.lotNumber || card.planNumber || "";
            items.push({
              type: "radar",
              id,
              title: `${title}${card.customerName ? ` · ${card.customerName}` : ""}`,
              planNumber: lotNo,
              bin: String(card.customerBin || ""),
              manager: card.managerName || "",
              amount: card.sum || 0,
              context: `Радар ${prodKey.toUpperCase()} · ${card.method || "Лот"}`,
              url: card.dealUrl || (id ? dealUrl(id) : card.lotUrl || "")
            });
          }
        }
      }

      return items;
    }

    let searchItems = null;

    function openModal() {
      if (document.body.classList.contains("tv")) return;
      if (!searchItems) searchItems = buildSearchIndex();
      modal.showModal();
      input.value = "";
      renderSearchResults("");
      input.focus();
    }

    function closeModal() {
      if (modal.open) modal.close();
    }

    function renderSearchResults(query) {
      const q = String(query || "").trim().toLowerCase();
      if (!q) {
        currentResults = [];
        results.innerHTML = `<div class="search-empty">Введите номер сделки, плана, БИН или название…</div>`;
        selectedIndex = -1;
        return;
      }

      currentResults = searchItems.filter(item => {
        const hay = `${item.title} ${item.id || ""} ${item.planNumber || ""} ${item.customerBin || item.bin || ""} ${item.manager || ""} ${item.context || ""}`.toLowerCase();
        return hay.includes(q);
      }).slice(0, 25);

      if (!currentResults.length) {
        results.innerHTML = `<div class="search-empty">Ничего не найдено по запросу «${esc(query)}»</div>`;
        selectedIndex = -1;
        return;
      }

      selectedIndex = 0;
      results.innerHTML = currentResults.map((item, idx) => {
        const meta = [];
        if (item.context) meta.push(esc(item.context));
        if (item.amount || item.sum) meta.push(money(item.amount || item.sum));
        if (item.manager) meta.push(esc(item.manager));
        if (item.planNumber) meta.push(`план ${esc(item.planNumber)}`);
        if (item.customerBin || item.bin) meta.push(`БИН ${esc(item.customerBin || item.bin)}`);
        return `
          <div class="search-item ${idx === 0 ? "selected" : ""}" role="option" data-idx="${idx}" tabindex="-1">
            <div class="title">${esc(item.title)}</div>
            <div class="meta">${meta.join(" · ")}</div>
          </div>
        `;
      }).join("");
    }

    function selectResult(index) {
      const all = results.querySelectorAll(".search-item");
      all.forEach((el, i) => el.classList.toggle("selected", i === index));
      const target = all[index];
      if (target) target.scrollIntoView({ block: "nearest" });
      selectedIndex = index;
    }

    function activateResult(index) {
      const item = currentResults[index];
      if (!item) return;
      closeModal();
      if ((item.type === "deal" || item.type === "radar") && item.url) {
        window.open(item.url, "_blank", "noopener");
      } else if (item.type === "plan") {
        if (item.dealUrl) window.open(item.dealUrl, "_blank", "noopener");
      } else if (item.type === "market") {
        setTab(item.tab, true);
      }
    }

    if (searchBtn) searchBtn.addEventListener("click", openModal);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });

    input.addEventListener("input", () => {
      renderSearchResults(input.value);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (currentResults.length) {
          selectResult((selectedIndex + 1) % currentResults.length);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (currentResults.length) {
          selectResult((selectedIndex - 1 + currentResults.length) % currentResults.length);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < currentResults.length) {
          activateResult(selectedIndex);
        }
      } else if (e.key === "Escape") {
        closeModal();
      }
    });

    results.addEventListener("click", (e) => {
      const itemEl = e.target.closest(".search-item");
      if (itemEl && itemEl.dataset.idx) {
        activateResult(Number(itemEl.dataset.idx));
      }
    });

    window.addEventListener("keydown", (e) => {
      if (document.body.classList.contains("tv")) return;
      const isInput = e.target.closest("input, textarea, select") || e.target.isContentEditable;
      if (!isInput && e.key === "/") {
        e.preventDefault();
        openModal();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K" || e.key === "л" || e.key === "Л")) {
        e.preventDefault();
        openModal();
      }
    });
  }

  /* ================= boot ================= */
  renderChrome(); renderSignals(); renderMonth(); renderTasks();
  initQuickSearch();
  let saved = null; try { saved = localStorage.getItem("pult-period"); } catch (e) {}
  setPeriod(/period=(day|week|month)/.exec(location.search)?.[1] || saved || "day");
  
  let hashTab = location.hash.replace(/^#/, "").split("/")[0];
  if (hashTab === "reg") hashTab = "pult";
  let savedTab = null; try { savedTab = localStorage.getItem("pult-tab"); } catch (e) {}
  if (savedTab === "reg") savedTab = "pult";
  const hasTab = tab => Object.prototype.hasOwnProperty.call(tabPanes, tab);
  const initialTab = hasTab(hashTab) ? hashTab : (hasTab(savedTab) ? savedTab : "pult");
  setTab(initialTab, false, location.hash.split("/")[1] || null);
  selectMonth(hashTab === "pult" ? location.hash.split("/")[1] || currentMonth : currentMonth);

  observe();
  if (/tv=1/.test(location.search)) toggleTv();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { moveInd(); moveSecInd(); });
})();
