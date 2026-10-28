import type { ManagerRollups, TopTask, TargetsConfig } from "./metrics.js";

export interface PultManagerView {
  id: string;
  name: string;
  active: boolean;
  rollups: ManagerRollups;
  topTasks: TopTask[];
}

export interface PultGroupView {
  id: string;
  name: string;
  managers: PultManagerView[];
}

export interface DayDynamic {
  date: string;
  calls: number;
  proposals: number;
  contracts: number;
  amount: number;
}

export interface SalesPultPayload {
  asOfDate: string;
  generatedAt: string;
  portal: string;
  pultUrl: string;
  targets: TargetsConfig;
  callsAvailable: boolean;
  callsError?: string;
  groups: PultGroupView[];
  dynamics: DayDynamic[];
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c] || c));
}

function fmt(n: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n || 0).replace(/\u00A0/g, " ");
}

function money(n: number): string {
  return `${fmt(n)} ₸`;
}

function renderServerTables(payload: SalesPultPayload): string {
  return payload.groups.map((g) => {
    const rows = g.managers.map((m) => {
      const day = m.rollups.day;
      const callsTarget = payload.targets.daily.calls;
      const kpTarget = payload.targets.daily.proposals;
      const contractTarget = payload.targets.daily.contracts;

      const callsCell = payload.callsAvailable
        ? `<span class="metric-pill ${day.calls.status}">${day.calls.successful} / ${callsTarget}</span><div class="metric-sub">${day.calls.totalAttempts} наб, ${day.calls.durationMinutes} мин</div>`
        : `<span class="metric-pill" style="background:rgba(255,255,255,0.05);color:var(--muted)">нет доступа</span>`;

      const isTender = g.id === "tenders";
      const kpCell = isTender
        ? `<span class="metric-sub">—</span>`
        : `<span class="metric-pill ${day.proposals.status}">${day.proposals.uniqueDealsCount} / ${kpTarget}</span>`;

      const contractCell = `<span class="metric-pill ${day.contracts.status}">${day.contracts.uniqueDealsCount} / ${contractTarget}</span>`;
      const amountCell = `<strong style="font-size:14px">${money(day.contracts.totalAmount)}</strong>`;

      return `<tr>
        <td><div class="mgr-name">${esc(m.name)}</div><div class="mgr-sub">ID: ${esc(m.id)}</div></td>
        <td>${callsCell}</td>
        <td>${kpCell}</td>
        <td>${contractCell}</td>
        <td>${amountCell}</td>
      </tr>`;
    }).join("");

    return `<div class="section-title"><h2>${esc(g.name)}</h2></div>
      <div class="table-wrap"><table>
      <thead><tr><th>Менеджер</th><th>Звонки (факт / норм)</th><th>ТС/КП (факт / норм)</th><th>Договоры (факт / норм)</th><th>Сумма договоров</th></tr></thead>
      <tbody>${rows}</tbody>
      </table></div>`;
  }).join("");
}

function renderServerTasks(payload: SalesPultPayload): string {
  const cards: string[] = [];
  for (const g of payload.groups) {
    for (const m of g.managers) {
      if (!m.topTasks || !m.topTasks.length) continue;
      const items = m.topTasks.map((t) => {
        const dealUrl = `${payload.portal}/crm/deal/details/${encodeURIComponent(t.dealId)}/`;
        const planTag = t.planNumber ? `<b>[${esc(t.planNumber)}]</b> ` : "";
        const overdueClass = t.isOverdue ? "overdue" : "";
        const overdueBadge = t.isOverdue ? '<span class="badge-overdue">ПРОСРОЧЕНО</span>' : "";
        const amountTag = t.amount > 0 ? `<span>${money(t.amount)}</span>` : "";
        const commentTag = t.lastComment ? `<div class="task-comment">💬 ${esc(t.lastComment)}</div>` : "";

        return `<div class="task-item ${overdueClass}">
          <div class="task-title-line">
            ${planTag}
            <a href="${dealUrl}" target="_blank" rel="noopener">${esc(t.title)}</a>
          </div>
          <div class="task-details">
            ${amountTag}
            ${t.deadline ? `<span>до ${esc(t.deadline.slice(11, 16))}</span>` : ""}
            ${overdueBadge}
          </div>
          ${commentTag}
        </div>`;
      }).join("");

      cards.push(`<div class="task-card">
        <div class="task-card-header">
          <h3>${esc(m.name)}</h3>
          <span class="mgr-sub">${m.topTasks.length} задач</span>
        </div>
        ${items}
      </div>`);
    }
  }
  return cards.join("");
}

export function renderPultHtml(payload: SalesPultPayload): string {
  const serverTables = renderServerTables(payload);
  const serverTasks = renderServerTasks(payload);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Пульт руководителя продаж F3</title>
<style>
:root {
  --bg: #090e17;
  --panel: #111a28;
  --panel-hover: #162235;
  --border: #1e2c42;
  --text: #f0f6fc;
  --muted: #8b9bb4;
  --green: #22c55e;
  --green-bg: rgba(34, 197, 94, 0.15);
  --yellow: #eab308;
  --yellow-bg: rgba(234, 179, 8, 0.15);
  --red: #ef4444;
  --red-bg: rgba(239, 68, 68, 0.15);
  --blue: #3b82f6;
  --blue-bg: rgba(59, 130, 246, 0.15);
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  padding: 16px;
  min-height: 100vh;
}
.shell { max-width: 1280px; margin: 0 auto; }
header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}
.brand h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
.brand .sub { color: var(--muted); font-size: 13px; }
.meta-badge {
  background: var(--panel);
  border: 1px solid var(--border);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--muted);
}
.controls {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
}
.tab-btn {
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--muted);
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.15s ease;
}
.tab-btn:hover { background: var(--panel-hover); color: var(--text); }
.tab-btn.active {
  background: var(--blue);
  border-color: var(--blue);
  color: #fff;
  font-weight: 600;
}
.signals {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 24px;
}
.signals-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--yellow);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.signal-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.signal-chip {
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.signal-chip.red { background: var(--red-bg); color: var(--red); border: 1px solid rgba(239, 68, 68, 0.3); }
.signal-chip.yellow { background: var(--yellow-bg); color: var(--yellow); border: 1px solid rgba(234, 179, 8, 0.3); }
.section-title {
  font-size: 16px;
  font-weight: 600;
  margin: 24px 0 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.table-wrap {
  overflow-x: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 24px;
  -webkit-overflow-scrolling: touch;
}
table { width: 100%; border-collapse: collapse; text-align: left; min-width: 650px; }
th, td { padding: 12px 16px; border-bottom: 1px solid var(--border); }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); background: rgba(0,0,0,0.2); }
tr:last-child td { border-bottom: none; }
tr:hover td { background: rgba(255,255,255,0.02); }
.mgr-name { font-weight: 600; font-size: 15px; }
.mgr-sub { font-size: 12px; color: var(--muted); }
.metric-pill {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 6px;
  font-weight: 600;
  font-size: 13px;
  text-align: center;
}
.metric-pill.green { background: var(--green-bg); color: var(--green); }
.metric-pill.yellow { background: var(--yellow-bg); color: var(--yellow); }
.metric-pill.red { background: var(--red-bg); color: var(--red); }
.metric-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
.chart-box {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 24px;
}
.chart-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
.chart-title { font-size: 14px; font-weight: 600; }
.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 140px;
  padding-bottom: 24px;
  position: relative;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.chart-col {
  flex: 1;
  min-width: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  justify-content: flex-end;
  position: relative;
}
.bar {
  width: 100%;
  max-width: 28px;
  background: var(--blue);
  border-radius: 4px 4px 0 0;
  transition: height 0.3s ease;
  min-height: 2px;
}
.bar-label {
  position: absolute;
  bottom: -22px;
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
}
.tasks-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 16px;
  margin-bottom: 30px;
}
.task-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.task-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}
.task-card-header h3 { font-size: 15px; font-weight: 600; }
.task-item {
  padding: 8px 10px;
  background: rgba(0,0,0,0.15);
  border-radius: 8px;
  border-left: 3px solid var(--blue);
}
.task-item.overdue { border-left-color: var(--red); }
.task-title-line { font-weight: 500; font-size: 13px; margin-bottom: 2px; }
.task-title-line a { color: var(--text); text-decoration: none; }
.task-title-line a:hover { text-decoration: underline; color: var(--blue); }
.task-details { font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 8px; }
.task-comment { font-size: 12px; color: #cbd5e1; margin-top: 4px; font-style: italic; background: rgba(255,255,255,0.03); padding: 4px 6px; border-radius: 4px; }
.badge-overdue { color: var(--red); font-weight: 600; font-size: 11px; }
@media (max-width: 768px) {
  body { padding: 12px; }
  header { flex-direction: column; align-items: flex-start; }
  .tasks-grid { grid-template-columns: 1fr; }
  th, td { padding: 10px 12px; }
}
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="brand">
      <h1>Пульт руководителя продаж F3</h1>
      <div class="sub">Оперативный контроль нормативов и сделок B2G</div>
    </div>
    <div class="meta-badge">
      данные на ${payload.generatedAt}
    </div>
  </header>

  <div class="controls">
    <button class="tab-btn active" data-period="day">Сегодня</button>
    <button class="tab-btn" data-period="week">Неделя</button>
    <button class="tab-btn" data-period="month">Месяц</button>
  </div>

  <section class="signals" id="signals-section">
    <div class="signals-title">⚡ Сигналы внимания</div>
    <div class="signal-chips" id="signals-chips"></div>
  </section>

  <section id="tables-container">${serverTables}</section>

  <section class="chart-box">
    <div class="chart-header">
      <div class="chart-title">Динамика договоров за месяц (сумма в ₸)</div>
      <div class="meta-badge" id="chart-total-amount">0 ₸</div>
    </div>
    <div class="chart-bars" id="chart-bars"></div>
  </section>

  <section>
    <div class="section-title">
      <h2>🔥 Топ-5 задач на контроле</h2>
      <span class="meta-badge">Дела из Bitrix24</span>
    </div>
    <div class="tasks-grid" id="tasks-container">${serverTasks}</div>
  </section>
</div>

<script type="application/json" id="pult-data">${safeJson(payload)}</script>
<script>
(()=>{
  const D = JSON.parse(document.getElementById('pult-data').textContent);
  let currentPeriod = 'day';

  const fmt = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n || 0).replace(/\\u00A0/g, ' ');
  const money = n => fmt(n) + ' ₸';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function getPeriodTarget(metric) {
    if (currentPeriod === 'day') return D.targets.daily[metric];
    if (currentPeriod === 'week') return D.targets.weekly[metric];
    return D.targets.monthly[metric];
  }

  function renderSignals() {
    const chips = [];
    D.groups.forEach(g => {
      g.managers.forEach(m => {
        const r = m.rollups;
        if (D.callsAvailable && r.signals.zeroBitrixCallsToday) {
          chips.push('<div class="signal-chip red">⚠️ ' + esc(m.name) + ': 0 звонков в CRM (звонит мимо Битрикса)</div>');
        }
        if (r.signals.zeroKpThreeDays) {
          chips.push('<div class="signal-chip yellow">⏳ ' + esc(m.name) + ': 0 КП за 3 рабочих дня</div>');
        }
      });
    });

    if (!D.callsAvailable) {
      chips.unshift('<div class="signal-chip yellow">ℹ️ Телефония недоступна (требуется scope telephony вебхуку)</div>');
    }

    const container = document.getElementById('signals-chips');
    container.innerHTML = chips.length ? chips.join('') : '<div class="signal-chip" style="background:var(--panel-hover);color:var(--muted)">Все нормативы в рабочем режиме, критических сигналов нет</div>';
  }

  function renderTables() {
    const container = document.getElementById('tables-container');
    container.innerHTML = D.groups.map(g => {
      const rows = g.managers.map(m => {
        const periodData = m.rollups[currentPeriod];
        const calls = periodData.calls;
        const kp = periodData.proposals;
        const contracts = periodData.contracts;

        const callsTarget = getPeriodTarget('calls');
        const kpTarget = getPeriodTarget('proposals');
        const contractTarget = getPeriodTarget('contracts');

        const callsCell = D.callsAvailable ? 
          ('<span class="metric-pill ' + calls.status + '">' + calls.successful + ' / ' + callsTarget + '</span><div class="metric-sub">' + calls.totalAttempts + ' наб, ' + calls.durationMinutes + ' мин</div>') :
          ('<span class="metric-pill" style="background:rgba(255,255,255,0.05);color:var(--muted)">нет доступа</span>');

        const isTender = g.id === 'tenders';
        const kpCell = isTender ? '<span class="metric-sub">—</span>' :
          ('<span class="metric-pill ' + kp.status + '">' + kp.uniqueDealsCount + ' / ' + kpTarget + '</span>');

        const contractCell = '<span class="metric-pill ' + contracts.status + '">' + contracts.uniqueDealsCount + ' / ' + contractTarget + '</span>';
        const amountCell = '<strong style="font-size:14px">' + money(contracts.totalAmount) + '</strong>';

        return '<tr>' +
          '<td><div class="mgr-name">' + esc(m.name) + '</div><div class="mgr-sub">ID: ' + esc(m.id) + '</div></td>' +
          '<td>' + callsCell + '</td>' +
          '<td>' + kpCell + '</td>' +
          '<td>' + contractCell + '</td>' +
          '<td>' + amountCell + '</td>' +
        '</tr>';
      }).join('');

      return '<div class="section-title"><h2>' + esc(g.name) + '</h2></div>' +
        '<div class="table-wrap"><table>' +
        '<thead><tr><th>Менеджер</th><th>Звонки (факт / норм)</th><th>ТС/КП (факт / норм)</th><th>Договоры (факт / норм)</th><th>Сумма договоров</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table></div>';
    }).join('');
  }

  function renderChart() {
    const dyn = D.dynamics || [];
    const maxAmount = Math.max(1, ...dyn.map(d => d.amount));
    const totalMonth = dyn.reduce((s, d) => s + d.amount, 0);

    document.getElementById('chart-total-amount').textContent = money(totalMonth);

    const bars = dyn.map(d => {
      const h = Math.max(4, Math.round((d.amount / maxAmount) * 100));
      const dayLabel = d.date.slice(8, 10);
      return '<div class="chart-col">' +
        '<div class="bar" style="height:' + h + '%" title="' + d.date + ': ' + money(d.amount) + ' (' + d.contracts + ' дог.)"></div>' +
        '<span class="bar-label">' + dayLabel + '</span>' +
      '</div>';
    }).join('');

    document.getElementById('chart-bars').innerHTML = bars;
  }

  function renderTasks() {
    const container = document.getElementById('tasks-container');
    const cards = [];

    D.groups.forEach(g => {
      g.managers.forEach(m => {
        if (!m.topTasks || !m.topTasks.length) return;
        const taskItems = m.topTasks.map(t => {
          const dealUrl = D.portal + '/crm/deal/details/' + encodeURIComponent(t.dealId) + '/';
          const planTag = t.planNumber ? '<b>[' + esc(t.planNumber) + ']</b> ' : '';
          const overdueClass = t.isOverdue ? 'overdue' : '';
          const overdueBadge = t.isOverdue ? '<span class="badge-overdue">ПРОСРОЧЕНО</span>' : '';
          const amountTag = t.amount > 0 ? '<span>' + money(t.amount) + '</span>' : '';
          const commentTag = t.lastComment ? '<div class="task-comment">💬 ' + esc(t.lastComment) + '</div>' : '';

          return '<div class="task-item ' + overdueClass + '">' +
            '<div class="task-title-line">' +
              planTag +
              '<a href="' + dealUrl + '" target="_blank" rel="noopener">' + esc(t.title) + '</a>' +
            '</div>' +
            '<div class="task-details">' +
              amountTag +
              (t.deadline ? '<span>до ' + esc(t.deadline.slice(11, 16)) + '</span>' : '') +
              overdueBadge +
            '</div>' +
            commentTag +
          '</div>';
        }).join('');

        cards.push('<div class="task-card">' +
          '<div class="task-card-header">' +
            '<h3>' + esc(m.name) + '</h3>' +
            '<span class="mgr-sub">' + m.topTasks.length + ' задач</span>' +
          '</div>' +
          taskItems +
        '</div>');
      });
    });

    container.innerHTML = cards.join('');
  }

  function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentPeriod = btn.dataset.period;
        renderTables();
      });
    });
  }

  renderSignals();
  renderChart();
  setupTabs();
})();
</script>
</body>
</html>`;
}
