import type { ManagerRollups, TopTask, TargetsConfig } from "./metrics.js";
import type { ManagerDebts } from "./debts.js";
import { decodeHtmlEntities } from "./site.js";

export function formatMoney(amount: number): string {
  if (!amount || Number.isNaN(amount)) return "0 ₸";
  const rounded = Math.round(amount);
  const formatted = new Intl.NumberFormat("ru-RU").format(rounded).replace(/\u00A0/g, " ");
  return `${formatted} ₸`;
}

export function formatDeadline(isoDeadline: string, reportDate?: string): string {
  if (!isoDeadline) return "";
  try {
    let dateStr = isoDeadline;
    if (dateStr.includes("T") && !dateStr.includes("Z") && !dateStr.match(/[+-]\d\d(?::?\d\d)?$/)) {
      dateStr += "+03:00";
    }
    const d = new Date(Date.parse(dateStr) + 5 * 3600000);
    if (Number.isNaN(d.getTime())) return "";

    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const hours = String(d.getUTCHours()).padStart(2, "0");
    const minutes = String(d.getUTCMinutes()).padStart(2, "0");

    const taskDate = `${year}-${month}-${day}`;
    const timeStr = `${hours}:${minutes}`;

    if (reportDate && taskDate !== reportDate) {
      return `${day}.${month} ${timeStr}`;
    }
    return timeStr;
  } catch {
    return "";
  }
}

export function buildMorningReport(params: {
  managerId: string;
  managerName: string;
  date: string;
  targets: { calls: number; proposals: number; contracts: number };
  tasks: TopTask[];
  debts?: ManagerDebts;
  pultUrl: string;
  taskError?: string | null;
}): string {
  const { managerId, managerName, date, targets, tasks, debts, pultUrl, taskError } = params;

  const lines: string[] = [
    `#автоотчёт ${date} утро ${managerId}`,
    `📋 План на день | ${managerName}`,
    "",
    "Нормативы на день:",
    `• Звонки: ${targets.calls}`,
    `• ТС/КП: ${targets.proposals}`,
    `• Договоры: ${targets.contracts}`,
    ""
  ];

  const hasNewDeals = Boolean(debts && debts.newDeals > 0);
  if (hasNewDeals && debts) {
    const oldestStr = debts.newOldestAgeDays >= 1 ? ` (самой старой ${debts.newOldestAgeDays} дн.)` : "";
    lines.push(`🆕 Новых сделок без звонка: ${debts.newDeals}${oldestStr}`);
    if (tasks.length > 0 || taskError) {
      lines.push("");
    }
  }

  if (taskError) {
    lines.push("🔥 Топ-5 задач: ⚠️ не удалось загрузить задачи (ошибка API)");
  } else if (tasks.length > 0) {
    lines.push("🔥 Топ-5 задач на сегодня:");
    tasks.forEach((t, i) => {
      const planTag = t.planNumber ? `[${t.planNumber}] ` : "";
      const moneyTag = t.amount > 0 ? ` — ${formatMoney(t.amount)}` : "";
      // A "new" activity has deadline == creation time: the time is noise and it is not an overdue debt.
      const isNew = t.kind === "new";
      const timeTag = t.deadline && !isNew ? ` [до ${formatDeadline(t.deadline, date)}]` : "";
      const overdueTag = t.isOverdue ? " ⚠️ (просрочено)" : "";
      const newTag = isNew ? ` 🆕 (новая, без звонка ${Math.max(1, Math.floor(t.ageDays ?? 0))} дн.)` : "";
      lines.push(`${i + 1}. ${planTag}${t.title}${moneyTag}${timeTag}${overdueTag}${newTag}`);
      if (t.lastComment?.trim()) {
        lines.push(`   💬 ${decodeHtmlEntities(t.lastComment.trim())}`);
      }
    });
  } else if (!hasNewDeals) {
    lines.push("🔥 Топ-5 задач: нет открытых задач на сегодня");
  }

  lines.push("");
  lines.push(`🔗 Пульт руководителя: ${pultUrl}`);

  return lines.join("\n");
}

export function buildEveningReport(params: {
  managerId: string;
  managerName: string;
  rollups: ManagerRollups;
  targets: TargetsConfig;
  pultUrl: string;
  callsAvailable?: boolean;
  callsError?: string;
}): string {
  const {
    managerId,
    managerName,
    rollups,
    targets,
    pultUrl,
    callsAvailable = true,
    callsError
  } = params;
  const { day, week, month, asOfDate, signals } = rollups;

  const lines: string[] = [
    `#автоотчёт ${asOfDate} вечер ${managerId}`,
    `📊 Отчёт за день | ${managerName}`,
    "",
    "День:"
  ];

  // Day calls
  if (!callsAvailable) {
    if (callsError?.includes("insufficient_scope")) {
      lines.push("• Звонки: нет доступа (требуется scope telephony)");
    } else {
      lines.push("• Звонки: нет доступа");
    }
  } else if (signals.zeroBitrixCallsToday) {
    lines.push(`• Звонки: ${targets.daily.calls}/0 ⚠️ (звонит мимо Битрикса)`);
  } else {
    const minStr = day.calls.durationMinutes > 0 ? `, ${day.calls.durationMinutes} мин` : "";
    lines.push(
      `• Звонки: ${targets.daily.calls}/${day.calls.successful} (наборов: ${day.calls.totalAttempts}${minStr})`
    );
  }

  lines.push(`• ТС/КП выставлено: ${targets.daily.proposals}/${day.proposals.uniqueDealsCount}`);
  const dayContractSum = formatMoney(day.contracts.totalAmount);
  lines.push(
    `• Договоров заключено: ${targets.daily.contracts}/${day.contracts.uniqueDealsCount} — ${dayContractSum}`
  );

  lines.push("");
  lines.push("Неделя:");
  if (!callsAvailable) {
    lines.push("• Звонки: нет доступа");
  } else {
    lines.push(`• Звонки: ${targets.weekly.calls}/${week.calls.successful}`);
  }
  lines.push(`• ТС/КП выставлено: ${targets.weekly.proposals}/${week.proposals.uniqueDealsCount}`);
  lines.push(
    `• Договоров заключено: ${targets.weekly.contracts}/${week.contracts.uniqueDealsCount} — ${formatMoney(week.contracts.totalAmount)}`
  );

  lines.push("");
  lines.push("Месяц:");
  if (!callsAvailable) {
    lines.push("• Звонки: нет доступа");
  } else {
    lines.push(`• Звонки: ${targets.monthly.calls}/${month.calls.successful}`);
  }
  lines.push(`• ТС/КП выставлено: ${targets.monthly.proposals}/${month.proposals.uniqueDealsCount}`);
  lines.push(
    `• Договоров заключено: ${targets.monthly.contracts}/${month.contracts.uniqueDealsCount} — ${formatMoney(month.contracts.totalAmount)}`
  );

  lines.push("");
  lines.push(`🔗 Пульт руководителя: ${pultUrl}`);

  return lines.join("\n");
}

export function isReportAlreadySent(
  messages: Array<{ text?: string | null }>,
  date: string,
  mode: "утро" | "вечер",
  userId: string
): boolean {
  const marker = `#автоотчёт ${date} ${mode} ${userId}`;
  return messages.some((m) => Boolean(m.text && m.text.includes(marker)));
}

export interface ParsedManualSection {
  plan?: number;
  amountFact: number;
  callsPlan: number;
  callsFact: number;
  proposalsPlan: number;
  proposalsFact: number;
  contractsPlan: number;
  contractsFact: number;
}

export interface ParsedManualReport {
  rawText: string;
  managerName?: string;
  date?: string;
  day: ParsedManualSection;
  week: ParsedManualSection;
  month: ParsedManualSection;
}

function cleanNumber(str: string): number {
  if (!str) return 0;
  const cleaned = str.replace(/[\s\u00A0]+/g, "").replace(",", ".");
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? 0 : num;
}

function parseSection(text: string): ParsedManualSection {
  const section: ParsedManualSection = {
    amountFact: 0,
    callsPlan: 0,
    callsFact: 0,
    proposalsPlan: 0,
    proposalsFact: 0,
    contractsPlan: 0,
    contractsFact: 0
  };

  // Amount in square brackets: [35 224 582] or [9 785 517,22]
  const amountMatch = text.match(/\[\s*([0-9\s\u00A0.,]+)\s*\]/);
  if (amountMatch) {
    section.amountFact = cleanNumber(amountMatch[1]);
  }

  // Calls: Звонки: 15/13 or Звонки: 15 / 13
  const callsMatch = text.match(/Звонки:\s*(\d+)\s*\/\s*(\d+)/i);
  if (callsMatch) {
    section.callsPlan = parseInt(callsMatch[1], 10);
    section.callsFact = parseInt(callsMatch[2], 10);
  }

  // Proposals: ТС/КП выставлено: 3/4 or ТС/КП: 3/0
  const kpMatch = text.match(/ТС\/КП(?:\s*выставлено)?:\s*(\d+)\s*\/\s*(\d+)/i);
  if (kpMatch) {
    section.proposalsPlan = parseInt(kpMatch[1], 10);
    section.proposalsFact = parseInt(kpMatch[2], 10);
  }

  // Contracts: Договоров заключено: 1/2 or Договоров заключено: (6) or 0
  const contractMatch = text.match(/Договоров(?:\s*заключено)?:\s*(?:(\d+)\s*\/\s*)?\(?(\d+)\)?/i);
  if (contractMatch) {
    if (contractMatch[1]) {
      section.contractsPlan = parseInt(contractMatch[1], 10);
      section.contractsFact = parseInt(contractMatch[2], 10);
    } else {
      section.contractsFact = parseInt(contractMatch[2], 10);
    }
  }

  return section;
}

export function parseManualReport(rawText: string): ParsedManualReport {
  // 1. Manager name
  let managerName: string | undefined;
  const nameMatch = rawText.match(/Менеджер:\s*([^\r\n]+)/i);
  if (nameMatch) {
    managerName = nameMatch[1].trim();
  } else {
    const inlineNameMatch = rawText.match(/\d{2}[./\u04af]\d{2}[./]\d{4}\s+([A-ZА-ЯЁa-zа-яё]+)/);
    if (inlineNameMatch) {
      managerName = inlineNameMatch[1].trim();
    }
  }

  // 2. Date: support 28.10.2026, 28/10/2026, and typo like 2ү/10/2026
  let date: string | undefined;
  const dateMatch = rawText.match(/(\d{1,2})[./\u04af](\d{1,2})[./](\d{4})/);
  if (dateMatch) {
    const day = dateMatch[1].padStart(2, "0");
    const month = dateMatch[2].padStart(2, "0");
    const year = dateMatch[3];
    date = `${year}-${month}-${day}`;
  }

  // 3. Sections
  const dayTextMatch = rawText.match(/Ежедневный\s+(?:план|отч[её]т)[\s\S]*?(?=Еженедельный|Ежемесячный|Топ|$)/i);
  const weekTextMatch = rawText.match(/Еженедельный\s+(?:план|отч[её]т)[\s\S]*?(?=Ежемесячный|Топ|$)/i);
  const monthTextMatch = rawText.match(/Ежемесячный\s+(?:план|отч[её]т)[\s\S]*?(?=Топ|$)/i);

  const day = parseSection(dayTextMatch ? dayTextMatch[0] : "");
  const week = parseSection(weekTextMatch ? weekTextMatch[0] : "");
  const month = parseSection(monthTextMatch ? monthTextMatch[0] : "");

  return {
    rawText,
    managerName,
    date,
    day,
    week,
    month
  };
}
