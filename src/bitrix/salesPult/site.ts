import fs from "node:fs";
import path from "node:path";
import type { ManagerRollups, TopTask, TargetsConfig, MetricStatus } from "./metrics.js";

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
  proposalsTracked?: boolean;
}

export function cleanFirstName(fullName: string): string {
  const clean = String(fullName ?? "").replace(/<[^>]*>/g, "").trim();
  return clean.split(/\s+/)[0] || clean;
}

export function cleanFullName(fullName: string): string {
  return String(fullName ?? "").replace(/<[^>]*>/g, "").trim();
}

export function formatMoney(n: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    const rounded = Math.round(millions * 10) / 10;
    const str = Number.isInteger(rounded)
      ? String(rounded)
      : rounded.toFixed(1).replace(".", ",");
    return `${str} млн ₸`;
  }
  const formatted = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n).replace(/\u00A0/g, " ");
  return `${formatted} ₸`;
}

export function pluralDeals(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 19) return `${n} договоров`;
  if (rem10 === 1) return `${n} договор`;
  if (rem10 >= 2 && rem10 <= 4) return `${n} договора`;
  return `${n} договоров`;
}

export function pluralDays(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 19) return `${n} дней`;
  if (rem10 === 1) return `${n} день`;
  if (rem10 >= 2 && rem10 <= 4) return `${n} дня`;
  return `${n} дней`;
}

export function formatUpdatedTime(generatedAt: string): string {
  const match = generatedAt.match(/(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (match) {
    const [, , m, d, hh, mm] = match;
    const months = [
      "января", "февраля", "марта", "апреля", "мая", "июня",
      "июля", "августа", "сентября", "октября", "ноября", "декабря"
    ];
    const monthName = months[parseInt(m, 10) - 1] || m;
    const dayNum = parseInt(d, 10);
    return `Обновлено ${dayNum} ${monthName} в ${hh}:${mm}`;
  }
  return `Обновлено ${generatedAt}`;
}

export function formatTaskDeadline(deadlineStr?: string | null): string {
  if (!deadlineStr) return "";
  const match = deadlineStr.match(/(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
  if (!match) return `до ${deadlineStr}`;
  const [, , m, d, hh, mm] = match;
  const months = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"
  ];
  const monthName = months[parseInt(m, 10) - 1] || m;
  const dayNum = parseInt(d, 10);
  if (hh && mm) {
    return `до ${dayNum} ${monthName}, ${hh}:${mm}`;
  }
  return `до ${dayNum} ${monthName}`;
}

export function formatChartDate(dateStr: string): string {
  const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return dateStr;
  const [, , m, d] = match;
  const shortMonths = [
    "янв", "фев", "мар", "апр", "мая", "июн",
    "июл", "авг", "сен", "окт", "ноя", "дек"
  ];
  const monthName = shortMonths[parseInt(m, 10) - 1] || m;
  const dayNum = parseInt(d, 10);
  return `${dayNum} ${monthName}`;
}

export function getAlmatyHour(generatedAt: string): number {
  const match = generatedAt.match(/[T\s](\d{2}):(\d{2})/);
  if (match) {
    return parseInt(match[1], 10);
  }
  const d = new Date(generatedAt);
  if (!isNaN(d.getTime())) {
    return new Date(d.getTime() + 5 * 3600000).getUTCHours();
  }
  return 12;
}

function loadProposalsTracked(payload: SalesPultPayload): boolean {
  if (typeof payload.proposalsTracked === "boolean") {
    return payload.proposalsTracked;
  }
  try {
    const configPath = path.resolve("config/sales-pult.json");
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (typeof parsed.proposalsTracked === "boolean") {
        return parsed.proposalsTracked;
      }
    }
  } catch {
    // fallback
  }
  return false;
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

function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} и ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} и ${names[names.length - 1]}`;
}

function getPeriodTarget(targets: TargetsConfig, period: "day" | "week" | "month", metric: "calls" | "proposals" | "contracts"): number {
  if (period === "day") return targets.daily[metric];
  if (period === "week") return targets.weekly[metric];
  return targets.monthly[metric];
}

interface SignalItem {
  color: "red" | "yellow" | "green" | "gray";
  text: string;
}

export function buildSignals(payload: SalesPultPayload): SignalItem[] {
  const items: SignalItem[] = [];

  // 1. Red signals: zeroBitrixCallsToday (only if callsAvailable)
  if (payload.callsAvailable) {
    const zeroCallsNames: string[] = [];
    for (const g of payload.groups) {
      if (g.id !== "sales") continue;
      for (const m of g.managers) {
        if (m.rollups.signals?.zeroBitrixCallsToday) {
          zeroCallsNames.push(cleanFirstName(m.name));
        }
      }
    }
    if (zeroCallsNames.length > 0) {
      const phrase = zeroCallsNames.length === 1
        ? `${zeroCallsNames[0]} сегодня не звонил через Битрикс`
        : `${joinNames(zeroCallsNames)} сегодня не звонили через Битрикс`;
      items.push({ color: "red", text: phrase });
    }
  }

  // 2. Yellow signals: low calls (calls.status === "red" after 14:00 Almaty)
  const hour = getAlmatyHour(payload.generatedAt);
  if (payload.callsAvailable && hour >= 14) {
    const lowCallsList: Array<{ name: string; fact: number; target: number }> = [];
    const dailyCallsTarget = payload.targets.daily.calls;
    for (const g of payload.groups) {
      if (g.id !== "sales") continue;
      for (const m of g.managers) {
        const dayCalls = m.rollups.day.calls;
        if (!m.rollups.signals?.zeroBitrixCallsToday && dayCalls.status === "red") {
          lowCallsList.push({
            name: cleanFirstName(m.name),
            fact: dayCalls.successful,
            target: dailyCallsTarget
          });
        }
      }
    }
    if (lowCallsList.length > 0) {
      const formatted = lowCallsList.map((x) => `${x.name} — ${x.fact} из ${x.target}`).join(", ");
      items.push({ color: "yellow", text: `Мало звонков: ${formatted}` });
    }
  }

  // 3. Green signals: signed contracts today (both sales and tenders)
  for (const g of payload.groups) {
    for (const m of g.managers) {
      const dayContracts = m.rollups.day.contracts;
      if (dayContracts.uniqueDealsCount > 0) {
        const count = dayContracts.uniqueDealsCount;
        const amtStr = formatMoney(dayContracts.totalAmount);
        const amtPart = amtStr ? ` на ${amtStr}` : "";
        const phrase = `${cleanFirstName(m.name)} подписал ${pluralDeals(count)}${amtPart}`;
        items.push({ color: "green", text: phrase });
      }
    }
  }

  // 4. Telephony warning (if unavailable)
  if (!payload.callsAvailable) {
    items.push({
      color: "gray",
      text: "Звонки сейчас не загружаются, цифры по звонкам неполные"
    });
  }

  // If completely empty:
  if (items.length === 0) {
    items.push({ color: "gray", text: "Сегодня без происшествий" });
  }

  return items;
}

function renderSignalsSection(payload: SalesPultPayload): string {
  const signals = buildSignals(payload);
  const rows = signals.map((s) => {
    return `<div class="signal-row ${s.color}">
      <span class="signal-dot ${s.color}"></span>
      <span class="signal-text">${esc(s.text)}</span>
    </div>`;
  }).join("");

  return `<section class="signals-section">
    <div class="signals-header">
      <h2>На что обратить внимание</h2>
      <span class="signals-badge">Сегодня</span>
    </div>
    <div class="signals-list">${rows}</div>
  </section>`;
}

function renderDepartmentSummary(
  g: PultGroupView,
  period: "day" | "week" | "month",
  payload: SalesPultPayload,
  proposalsTracked: boolean
): string {
  const activeManagers = g.managers.filter((m) => m.active);
  const activeCount = activeManagers.length || 1;

  const targetCalls = getPeriodTarget(payload.targets, period, "calls") * activeCount;
  const targetProposals = getPeriodTarget(payload.targets, period, "proposals") * activeCount;
  const targetContracts = getPeriodTarget(payload.targets, period, "contracts") * activeCount;

  let callsFact = 0;
  let kpFact = 0;
  let contractsFact = 0;
  let contractsAmount = 0;

  for (const m of activeManagers) {
    const p = m.rollups[period];
    callsFact += p.calls.successful;
    kpFact += p.proposals.uniqueDealsCount;
    contractsFact += p.contracts.uniqueDealsCount;
    contractsAmount += p.contracts.totalAmount;
  }

  if (g.id === "tenders") {
    // Only contracts tile
    const pct = targetContracts > 0 ? Math.min(100, Math.round((contractsFact / targetContracts) * 100)) : 0;
    const status = contractsFact >= targetContracts ? "green" : (contractsFact >= Math.ceil(targetContracts * 0.6) ? "yellow" : "red");
    const amtStr = formatMoney(contractsAmount);
    const contractsDesc = contractsFact > 0
      ? `${pluralDeals(contractsFact)}${amtStr ? ` на ${amtStr}` : ""}`
      : "0 договоров";

    return `<div class="summary-tiles one-tile">
      <div class="summary-tile">
        <div class="tile-caption">Подписали</div>
        <div class="tile-value ${status}">${contractsDesc}</div>
        <div class="tile-bar"><div class="tile-bar-fill ${status}" style="width:${pct}%"></div></div>
      </div>
    </div>`;
  }

  // Sales department: 3 tiles
  const callsPct = targetCalls > 0 ? Math.min(100, Math.round((callsFact / targetCalls) * 100)) : 0;
  const callsStatus = callsFact >= targetCalls ? "green" : (callsFact >= Math.ceil(targetCalls * 0.6) ? "yellow" : "red");

  const kpPct = targetProposals > 0 ? Math.min(100, Math.round((kpFact / targetProposals) * 100)) : 0;
  const kpStatus = proposalsTracked
    ? (kpFact >= targetProposals ? "green" : (kpFact >= Math.ceil(targetProposals * 0.6) ? "yellow" : "red"))
    : "gray";

  const contractsPct = targetContracts > 0 ? Math.min(100, Math.round((contractsFact / targetContracts) * 100)) : 0;
  const contractsStatus = contractsFact >= targetContracts ? "green" : (contractsFact >= Math.ceil(targetContracts * 0.6) ? "yellow" : "red");

  const amtStr = formatMoney(contractsAmount);
  const contractsDesc = contractsFact > 0
    ? `${pluralDeals(contractsFact)}${amtStr ? ` на ${amtStr}` : ""}`
    : "0 договоров";

  const kpSub = !proposalsTracked
    ? `<div class="tile-sub">в CRM пока не отмечают</div>`
    : "";

  return `<div class="summary-tiles">
    <div class="summary-tile">
      <div class="tile-caption">Дозвонились</div>
      <div class="tile-value ${callsStatus}">${callsFact} из ${targetCalls}</div>
      <div class="tile-bar"><div class="tile-bar-fill ${callsStatus}" style="width:${callsPct}%"></div></div>
    </div>
    <div class="summary-tile">
      <div class="tile-caption">Отправили КП</div>
      <div class="tile-value ${kpStatus}">${kpFact} из ${targetProposals}</div>
      <div class="tile-bar"><div class="tile-bar-fill ${kpStatus}" style="width:${kpPct}%"></div></div>
      ${kpSub}
    </div>
    <div class="summary-tile">
      <div class="tile-caption">Подписали</div>
      <div class="tile-value ${contractsStatus}">${contractsDesc}</div>
      <div class="tile-bar"><div class="tile-bar-fill ${contractsStatus}" style="width:${contractsPct}%"></div></div>
    </div>
  </div>`;
}

function renderDepartmentTable(
  g: PultGroupView,
  period: "day" | "week" | "month",
  payload: SalesPultPayload,
  proposalsTracked: boolean
): string {
  const isTender = g.id === "tenders";
  const targetCalls = getPeriodTarget(payload.targets, period, "calls");
  const targetProposals = getPeriodTarget(payload.targets, period, "proposals");
  const targetContracts = getPeriodTarget(payload.targets, period, "contracts");

  const statusWeight: Record<MetricStatus, number> = { red: 0, yellow: 1, green: 2 };

  const sortedManagers = [...g.managers].sort((a, b) => {
    if (isTender) {
      const sA = a.rollups[period].contracts.status;
      const sB = b.rollups[period].contracts.status;
      const diff = statusWeight[sA] - statusWeight[sB];
      if (diff !== 0) return diff;
    } else {
      const sA = a.rollups[period].calls.status;
      const sB = b.rollups[period].calls.status;
      const diff = statusWeight[sA] - statusWeight[sB];
      if (diff !== 0) return diff;
    }
    return cleanFullName(a.name).localeCompare(cleanFullName(b.name), "ru");
  });

  const headerHtml = isTender
    ? `<thead><tr><th>Менеджер</th><th>Подписал</th></tr></thead>`
    : `<thead><tr><th>Менеджер</th><th>Дозвонился</th><th>Отправил КП</th><th>Подписал</th></tr></thead>`;

  const rows = sortedManagers.map((m) => {
    const p = m.rollups[period];
    const nameCell = `<td class="cell-manager"><div class="mgr-name">${esc(cleanFullName(m.name))}</div></td>`;

    // Contract cell
    let contractCell = "";
    if (p.contracts.uniqueDealsCount === 0) {
      contractCell = `<td data-label="Подписал"><span class="metric-empty">—</span></td>`;
    } else {
      const amtStr = formatMoney(p.contracts.totalAmount);
      const amtPart = amtStr ? ` · ${amtStr}` : "";
      const pct = targetContracts > 0 ? Math.min(100, Math.round((p.contracts.uniqueDealsCount / targetContracts) * 100)) : 0;
      contractCell = `<td data-label="Подписал">
        <div class="metric-cell">
          <div class="metric-num ${p.contracts.status}">${p.contracts.uniqueDealsCount}${amtPart}</div>
          <div class="mini-bar"><div class="mini-bar-fill ${p.contracts.status}" style="width:${pct}%"></div></div>
        </div>
      </td>`;
    }

    if (isTender) {
      return `<tr>${nameCell}${contractCell}</tr>`;
    }

    // Calls cell
    let callsCell = "";
    if (!payload.callsAvailable) {
      callsCell = `<td data-label="Дозвонился"><span class="metric-num muted">нет доступа</span></td>`;
    } else if (p.calls.totalAttempts === 0) {
      callsCell = `<td data-label="Дозвонился"><span class="metric-num red">не звонил через Битрикс</span></td>`;
    } else {
      const pct = targetCalls > 0 ? Math.min(100, Math.round((p.calls.successful / targetCalls) * 100)) : 0;
      callsCell = `<td data-label="Дозвонился">
        <div class="metric-cell">
          <div class="metric-num ${p.calls.status}">${p.calls.successful} из ${targetCalls}</div>
          <div class="mini-bar"><div class="mini-bar-fill ${p.calls.status}" style="width:${pct}%"></div></div>
          <div class="metric-sub">набирал ${p.calls.totalAttempts} раз, говорил ${p.calls.durationMinutes} мин</div>
        </div>
      </td>`;
    }

    // KP cell
    let kpCell = "";
    const kpPct = targetProposals > 0 ? Math.min(100, Math.round((p.proposals.uniqueDealsCount / targetProposals) * 100)) : 0;
    if (!proposalsTracked) {
      kpCell = `<td data-label="Отправил КП">
        <div class="metric-cell">
          <div class="metric-num muted">${p.proposals.uniqueDealsCount} из ${targetProposals}</div>
          <div class="mini-bar"><div class="mini-bar-fill gray" style="width:${kpPct}%"></div></div>
          <div class="metric-sub">в CRM пока не отмечают</div>
        </div>
      </td>`;
    } else {
      kpCell = `<td data-label="Отправил КП">
        <div class="metric-cell">
          <div class="metric-num ${p.proposals.status}">${p.proposals.uniqueDealsCount} из ${targetProposals}</div>
          <div class="mini-bar"><div class="mini-bar-fill ${p.proposals.status}" style="width:${kpPct}%"></div></div>
        </div>
      </td>`;
    }

    return `<tr>${nameCell}${callsCell}${kpCell}${contractCell}</tr>`;
  }).join("");

  return `<div class="table-card">
    <table class="pult-table">
      ${headerHtml}
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderPeriodView(
  period: "day" | "week" | "month",
  payload: SalesPultPayload,
  proposalsTracked: boolean
): string {
  const displayStyle = period === "day" ? "" : ' style="display:none"';
  const deptsHtml = payload.groups.map((g) => {
    const summaryHtml = renderDepartmentSummary(g, period, payload, proposalsTracked);
    const tableHtml = renderDepartmentTable(g, period, payload, proposalsTracked);

    return `<div class="dept-section">
      <div class="dept-header">
        <h2>${esc(g.name)}</h2>
      </div>
      ${summaryHtml}
      ${tableHtml}
    </div>`;
  }).join("");

  return `<div class="period-view" data-period="${period}"${displayStyle}>
    ${deptsHtml}
  </div>`;
}

function renderTasksSection(payload: SalesPultPayload): string {
  const cards: string[] = [];

  for (const g of payload.groups) {
    for (const m of g.managers) {
      if (!m.topTasks || !m.topTasks.length) continue;

      const items = m.topTasks.map((t) => {
        const dealUrl = `${payload.portal}/crm/deal/details/${encodeURIComponent(t.dealId)}/`;
        const planTag = t.planNumber ? `<b>[${esc(t.planNumber)}]</b> ` : "";
        const overdueClass = t.isOverdue ? "overdue" : "";

        let overdueBadge = "";
        if (t.isOverdue) {
          const diffDays = Math.max(1, Math.round((Date.parse(payload.asOfDate) - Date.parse(t.deadline.slice(0, 10))) / 86400000));
          overdueBadge = `<span class="badge-overdue">просрочено на ${pluralDays(diffDays)}</span>`;
        }

        const amtStr = formatMoney(t.amount);
        const amountTag = amtStr ? `<span>${amtStr}</span>` : "";
        const deadlineTag = t.deadline ? `<span>${esc(formatTaskDeadline(t.deadline))}</span>` : "";
        const commentTag = t.lastComment ? `<div class="task-comment">${esc(t.lastComment)}</div>` : "";

        return `<div class="task-item ${overdueClass}">
          <div class="task-title-line">
            ${planTag}
            <a href="${dealUrl}" target="_blank" rel="noopener">${esc(t.title)}</a>
          </div>
          <div class="task-details">
            ${amountTag}
            ${deadlineTag}
            ${overdueBadge}
          </div>
          ${commentTag}
        </div>`;
      }).join("");

      cards.push(`<div class="task-card">
        <div class="task-card-header">
          <h3>${esc(cleanFullName(m.name))}</h3>
          <span class="task-count">${m.topTasks.length} ${pluralDeals(m.topTasks.length).replace("договор", "задач").replace("договора", "задачи").replace("договоров", "задач")}</span>
        </div>
        ${items}
      </div>`);
    }
  }

  if (cards.length === 0) {
    return "";
  }

  return `<section class="tasks-section">
    <div class="section-header">
      <h2>Что сделать сегодня</h2>
      <span class="meta-badge">Задачи из Битрикс24</span>
    </div>
    <div class="tasks-grid">${cards.join("")}</div>
  </section>`;
}

function renderChartSection(payload: SalesPultPayload): string {
  const dyn = payload.dynamics || [];
  const maxAmount = Math.max(1, ...dyn.map((d) => d.amount));
  const totalMonth = dyn.reduce((s, d) => s + d.amount, 0);
  const totalFormatted = formatMoney(totalMonth);
  const totalBadge = totalFormatted ? `<span class="meta-badge">${totalFormatted}</span>` : `<span class="meta-badge">—</span>`;

  const bars = dyn.map((d) => {
    const h = Math.max(4, Math.round((d.amount / maxAmount) * 100));
    const dayLabel = formatChartDate(d.date);
    const amtStr = formatMoney(d.amount);
    const amtDesc = amtStr ? `${amtStr} · ` : "";
    const tooltip = `${dayLabel}: ${amtDesc}${pluralDeals(d.contracts)}`;

    return `<div class="chart-col">
      <div class="bar" style="height:${h}%" title="${esc(tooltip)}"></div>
      <span class="bar-label">${esc(dayLabel)}</span>
    </div>`;
  }).join("");

  return `<section class="chart-box">
    <div class="chart-header">
      <h2>Договоры по дням за месяц</h2>
      ${totalBadge}
    </div>
    <div class="chart-bars">${bars}</div>
  </section>`;
}

export function renderPultHtml(payload: SalesPultPayload): string {
  const proposalsTracked = loadProposalsTracked(payload);

  const updatedTime = formatUpdatedTime(payload.generatedAt);
  const signalsHtml = renderSignalsSection(payload);
  const dayView = renderPeriodView("day", payload, proposalsTracked);
  const weekView = renderPeriodView("week", payload, proposalsTracked);
  const monthView = renderPeriodView("month", payload, proposalsTracked);
  const tasksHtml = renderTasksSection(payload);
  const chartHtml = renderChartSection(payload);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Пульт продаж F3</title>
<style>
:root {
  --bg: #090d16;
  --panel: #111827;
  --panel-subtle: #172134;
  --border: #1f293d;
  --border-subtle: #182234;
  --text: #f3f4f6;
  --text-muted: #8b99ae;
  --bar-bg: #1a2436;

  --green: #22c55e;
  --green-bg: rgba(34, 197, 94, 0.14);
  --yellow: #eab308;
  --yellow-bg: rgba(234, 179, 8, 0.14);
  --red: #ef4444;
  --red-bg: rgba(239, 68, 68, 0.14);
  --gray: #64748b;
  --gray-bg: rgba(100, 116, 139, 0.14);

  --blue: #3b82f6;
  --blue-hover: #2563eb;

  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #f8fafc;
    --panel: #ffffff;
    --panel-subtle: #f1f5f9;
    --border: #e2e8f0;
    --border-subtle: #edf2f7;
    --text: #0f172a;
    --text-muted: #64748b;
    --bar-bg: #e2e8f0;

    --green: #16a34a;
    --green-bg: rgba(22, 163, 74, 0.12);
    --yellow: #ca8a04;
    --yellow-bg: rgba(202, 138, 4, 0.12);
    --red: #dc2626;
    --red-bg: rgba(220, 38, 38, 0.12);
    --gray: #64748b;
    --gray-bg: rgba(100, 116, 139, 0.1);

    --blue: #2563eb;
    --blue-hover: #1d4ed8;
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  padding: 20px 16px;
  min-height: 100vh;
}
.shell { max-width: 1200px; margin: 0 auto; }

header.pult-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
}
.brand h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 2px; }
.brand .updated-time { color: var(--text-muted); font-size: 13px; }

.controls { display: flex; gap: 8px; }
.tab-btn {
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text-muted);
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 400;
  transition: all 0.15s ease;
}
.tab-btn:hover { background: var(--panel-subtle); color: var(--text); }
.tab-btn.active {
  background: var(--blue);
  border-color: var(--blue);
  color: #fff;
  font-weight: 600;
}

.signals-section {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 28px;
}
.signals-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.signals-header h2 { font-size: 15px; font-weight: 600; }
.signals-badge {
  background: var(--panel-subtle);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 6px;
}
.signals-list { display: flex; flex-direction: column; gap: 10px; }
.signal-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  line-height: 1.4;
}
.signal-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.signal-dot.red { background: var(--red); }
.signal-dot.yellow { background: var(--yellow); }
.signal-dot.green { background: var(--green); }
.signal-dot.gray { background: var(--gray); }

.dept-section { margin-bottom: 32px; }
.dept-header {
  margin-bottom: 14px;
}
.dept-header h2 { font-size: 18px; font-weight: 600; }

.summary-tiles {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}
.summary-tiles.one-tile {
  grid-template-columns: 1fr;
  max-width: 380px;
}
.summary-tile {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tile-caption { font-size: 13px; color: var(--text-muted); }
.tile-value {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.tile-value.green { color: var(--green); }
.tile-value.yellow { color: var(--yellow); }
.tile-value.red { color: var(--red); }
.tile-value.gray { color: var(--text-muted); }
.tile-bar {
  height: 4px;
  background: var(--bar-bg);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 2px;
}
.tile-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
}
.tile-bar-fill.green { background: var(--green); }
.tile-bar-fill.yellow { background: var(--yellow); }
.tile-bar-fill.red { background: var(--red); }
.tile-bar-fill.gray { background: var(--gray); }
.tile-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

.table-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
table.pult-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}
table.pult-table th {
  padding: 12px 16px;
  background: var(--panel-subtle);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
}
table.pult-table td {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: middle;
}
table.pult-table tr:last-child td { border-bottom: none; }
table.pult-table tr:hover td { background: var(--panel-subtle); }

.mgr-name { font-weight: 600; font-size: 14px; }
.metric-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.metric-num {
  font-size: 14px;
  font-weight: 600;
}
.metric-num.green { color: var(--green); }
.metric-num.yellow { color: var(--yellow); }
.metric-num.red { color: var(--red); }
.metric-num.muted { color: var(--text-muted); }
.metric-empty { color: var(--text-muted); font-size: 14px; }
.mini-bar {
  width: 100%;
  max-width: 160px;
  height: 3px;
  background: var(--bar-bg);
  border-radius: 2px;
  overflow: hidden;
}
.mini-bar-fill {
  height: 100%;
  border-radius: 2px;
}
.mini-bar-fill.green { background: var(--green); }
.mini-bar-fill.yellow { background: var(--yellow); }
.mini-bar-fill.red { background: var(--red); }
.mini-bar-fill.gray { background: var(--gray); }
.metric-sub { font-size: 12px; color: var(--text-muted); }

.tasks-section { margin-bottom: 32px; }
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.section-header h2 { font-size: 18px; font-weight: 600; }
.meta-badge {
  background: var(--panel);
  border: 1px solid var(--border);
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.tasks-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
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
.task-count { font-size: 12px; color: var(--text-muted); }
.task-item {
  padding: 10px 12px;
  background: var(--panel-subtle);
  border-radius: 8px;
  border-left: 3px solid var(--blue);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.task-item.overdue { border-left-color: var(--red); }
.task-title-line { font-weight: 600; font-size: 13px; line-height: 1.4; }
.task-title-line a { color: var(--text); text-decoration: none; }
.task-title-line a:hover { color: var(--blue); text-decoration: underline; }
.task-details { font-size: 12px; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 8px; }
.task-comment {
  font-size: 12px;
  color: var(--text-muted);
  border-top: 1px dashed var(--border);
  padding-top: 4px;
  margin-top: 2px;
}
.badge-overdue { color: var(--red); font-weight: 600; font-size: 11px; }

.chart-box {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 32px;
}
.chart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
.chart-header h2 { font-size: 16px; font-weight: 600; }
.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 150px;
  padding-bottom: 26px;
  position: relative;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.chart-col {
  flex: 1;
  min-width: 28px;
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
  bottom: -24px;
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}

@media (max-width: 680px) {
  body { padding: 14px 10px; }
  header.pult-header { flex-direction: column; align-items: flex-start; gap: 12px; }
  .summary-tiles { grid-template-columns: 1fr; }
  .summary-tiles.one-tile { max-width: 100%; }
  .tasks-grid { grid-template-columns: 1fr; }

  /* Mobile card table */
  table.pult-table,
  table.pult-table thead,
  table.pult-table tbody,
  table.pult-table th,
  table.pult-table td,
  table.pult-table tr {
    display: block;
  }
  table.pult-table thead { display: none; }
  table.pult-table tr {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 12px;
    padding: 12px 14px;
  }
  table.pult-table tr:hover td { background: transparent; }
  table.pult-table td {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  table.pult-table td:last-child { border-bottom: none; }
  table.pult-table td::before {
    content: attr(data-label);
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 400;
    margin-right: 12px;
    flex-shrink: 0;
  }
  table.pult-table td.cell-manager {
    display: block;
    font-size: 15px;
    font-weight: 600;
    padding-bottom: 10px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }
  table.pult-table td.cell-manager::before { display: none; }
  .mini-bar { max-width: 120px; }
}
</style>
</head>
<body>
<div class="shell">
  <header class="pult-header">
    <div class="brand">
      <h1>Пульт продаж F3</h1>
      <div class="updated-time">${esc(updatedTime)}</div>
    </div>
    <div class="controls">
      <button class="tab-btn active" data-period="day">Сегодня</button>
      <button class="tab-btn" data-period="week">Неделя</button>
      <button class="tab-btn" data-period="month">Месяц</button>
    </div>
  </header>

  ${signalsHtml}

  ${dayView}
  ${weekView}
  ${monthView}

  ${tasksHtml}

  ${chartHtml}
</div>

<script type="application/json" id="pult-data">${safeJson(payload)}</script>
<script>
(function() {
  var buttons = document.querySelectorAll('.tab-btn');
  var views = document.querySelectorAll('.period-view');

  buttons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      buttons.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var period = btn.dataset.period;
      views.forEach(function(v) {
        v.style.display = v.dataset.period === period ? 'block' : 'none';
      });
    });
  });
})();
</script>
</body>
</html>`;
}
