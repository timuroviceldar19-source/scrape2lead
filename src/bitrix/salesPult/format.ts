import type { TopTask, ManagerDebts, DebtLine } from "./types.js";

export const MONTHS_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря"
];

export const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"
];

export const DOW = [
  "воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"
];

export function toIsoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function fmtNumber(n: number): string {
  return Math.round(n || 0).toLocaleString("ru-RU").replace(/\s/g, " ");
}

export function fmtNumber1(n: number): string {
  const rounded = Math.round((n || 0) * 10) / 10;
  return rounded.toFixed(1).replace(".", ",");
}

export function fmtNumberNbsp(n: number): string {
  return Math.round(n || 0).toLocaleString("ru-RU").replace(/\s/g, "\u00A0");
}

export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(Math.round(n || 0));
  const a = abs % 100;
  const b = a % 10;
  let word: string;
  if (a > 10 && a < 20) {
    word = forms[2];
  } else if (b > 1 && b < 5) {
    word = forms[1];
  } else if (b === 1) {
    word = forms[0];
  } else {
    word = forms[2];
  }
  return `${fmtNumber(n)} ${word}`;
}

export function pluralNbsp(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(Math.round(n || 0));
  const a = abs % 100;
  const b = a % 10;
  let word: string;
  if (a > 10 && a < 20) {
    word = forms[2];
  } else if (b > 1 && b < 5) {
    word = forms[1];
  } else if (b === 1) {
    word = forms[0];
  } else {
    word = forms[2];
  }
  return `${fmtNumberNbsp(n)}\u00A0${word}`;
}

export function pluralDeals(n: number): string {
  return plural(n, ["договор", "договора", "договоров"]);
}

export function pluralDays(n: number): string {
  return plural(n, ["день", "дня", "дней"]);
}

export function formatMoney(n: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1e9) {
    const billions = n / 1e9;
    const rounded = Math.round(billions * 10) / 10;
    const str = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
    return `${str} млрд ₸`;
  }
  if (n >= 1e6) {
    const millions = n / 1e6;
    const rounded = Math.round(millions * 10) / 10;
    const str = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
    return `${str} млн ₸`;
  }
  return `${fmtNumber(n)} ₸`;
}

export function formatPultMoney(n: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1e9) {
    return `${fmtNumber1(n / 1e9)} млрд ₸`;
  }
  if (n >= 1e6) {
    return `${fmtNumber1(n / 1e6)} млн ₸`;
  }
  if (n >= 1e3) {
    return `${fmtNumberNbsp(n / 1e3)} тыс ₸`;
  }
  return `${fmtNumberNbsp(n)} ₸`;
}

export function decodeHtmlEntities(str: string): string {
  if (!str) return "";
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);|&#x([0-9a-fA-F]+);/g, (match, dec, hex) => {
      const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      if (!Number.isNaN(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    })
    .replace(/&amp;/g, "&");
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c] || c));
}

export function cleanFirstName(fullName: string): string {
  const clean = String(fullName ?? "").replace(/<[^>]*>/g, "").trim();
  return clean.split(/\s+/)[0] || clean;
}

export function cleanFullName(fullName: string): string {
  return String(fullName ?? "").replace(/<[^>]*>/g, "").trim();
}

export function initials(fullName: string): string {
  return String(fullName ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function cleanTaskTitle(task: { title?: string; planNumber?: string }): { title: string; plan: string } {
  let s = decodeHtmlEntities(task.title || "");
  let plan = task.planNumber || "";
  const m = /^\[GZ (\d+)\]\s*/.exec(s);
  if (m) {
    plan = plan || m[1];
    s = s.slice(m[0].length);
  }
  const m2 = /^(\d{7,9})\s+/.exec(s);
  if (m2) {
    plan = plan || m2[1];
    s = s.slice(m2[0].length);
  }
  return { title: s, plan };
}

export function getTaskStatus(task: Partial<TopTask>): { cls: string; text: string } {
  if (task.kind === "new") {
    const a = Math.floor(task.ageDays || 0);
    return {
      cls: "warn",
      text: a >= 1 ? `Новая, без звонка ${pluralDays(a)}` : "Новая, без звонка с сегодня"
    };
  }
  if (task.isOverdue) {
    return {
      cls: "bad",
      text: `Просрочено на ${pluralDays(task.overdueDays || 0)}`
    };
  }
  return { cls: "", text: "Срок сегодня" };
}

export function formatDebtLines(debts: ManagerDebts | undefined): DebtLine[] {
  if (!debts) return [];
  const lines: DebtLine[] = [];
  if (debts.overdue > 0) {
    const parts = [`просрочено ${debts.overdue}`];
    if (debts.overdueOverMonth > 0) parts.push(`больше месяца ${debts.overdueOverMonth}`);
    lines.push({ color: "red", text: parts.join(" · ") });
  }
  if (debts.newDeals > 0) {
    const oldest = debts.newOldestAgeDays >= 1 ? ` (самой старой ${pluralDays(debts.newOldestAgeDays)})` : "";
    lines.push({ color: "yellow", text: `новых без звонка ${debts.newDeals}${oldest}` });
  }
  const readyToClose = debts.readyToCloseDealIds.length;
  if (readyToClose > 0) lines.push({ color: "gray", text: `пора закрыть ${readyToClose}` });
  return lines;
}

function parseBitrixDate(str: string): number {
  let s = str.trim();
  if (s && !/[Z+-]\d{2}(?::?\d{2})?$/i.test(s)) {
    if (/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(s)) {
      s = s.replace(" ", "T") + "+03:00";
    }
  }
  return Date.parse(s);
}

export function formatTaskDeadline(deadlineStr?: string | null): string {
  if (!deadlineStr) return "";
  const ms = parseBitrixDate(deadlineStr);
  if (Number.isNaN(ms)) {
    return `до ${deadlineStr}`;
  }

  const shifted = new Date(ms + 5 * 3600000);
  const iso = shifted.toISOString();
  const datePart = iso.slice(0, 10);
  const timePart = iso.slice(11, 16);

  const [, m, d] = datePart.split("-");
  const monthName = MONTHS_GEN[parseInt(m, 10) - 1] || m;
  const dayNum = parseInt(d, 10);

  const hasTime = deadlineStr.includes(":") || timePart !== "00:00";
  if (hasTime) {
    return `до ${dayNum} ${monthName}, ${timePart}`;
  }
  return `до ${dayNum} ${monthName}`;
}

export function formatOverdue(deadlineStr: string, asOfDate: string): string {
  if (!deadlineStr) return "";
  const ms = parseBitrixDate(deadlineStr);
  let deadlineAlmatyDate = "";
  if (!Number.isNaN(ms)) {
    deadlineAlmatyDate = new Date(ms + 5 * 3600000).toISOString().slice(0, 10);
  } else {
    deadlineAlmatyDate = deadlineStr.slice(0, 10);
  }

  const diffDays = Math.round(
    (Date.parse(asOfDate) - Date.parse(deadlineAlmatyDate)) / 86400000
  );

  if (diffDays <= 0) {
    return "просрочено сегодня";
  }
  return `просрочено на ${plural(diffDays, ["день", "дня", "дней"])}`;
}

export function formatTaskLine(
  task: {
    subject?: string;
    title: string;
    amount?: number;
    deadline?: string;
    isOverdue?: boolean;
    kind?: string;
    ageDays?: number;
  },
  asOfDate: string
): string {
  let statusText = "";
  if (task.kind === "new") {
    const age = Math.floor(task.ageDays ?? 0);
    statusText = age >= 1 ? `новая, без звонка ${pluralDays(age)}` : "новая, без звонка сегодня";
  } else if (task.isOverdue && task.deadline) {
    statusText = formatOverdue(task.deadline, asOfDate);
  } else if (task.deadline) {
    statusText = formatTaskDeadline(task.deadline);
  }
  const parts = [task.subject?.trim(), task.title, formatMoney(task.amount || 0), statusText];
  return parts.filter(Boolean).join(" · ");
}

export function formatUpdatedTime(generatedAt: string): string {
  const match = /(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/.exec(generatedAt);
  if (match) {
    const [, , m, d, hh, mm] = match;
    const monthName = MONTHS_GEN[parseInt(m, 10) - 1] || m;
    const dayNum = parseInt(d, 10);
    return `Обновлено ${dayNum} ${monthName} в ${hh}:${mm}`;
  }
  return `Обновлено ${generatedAt}`;
}

export function getAlmatyHour(generatedAt: string): number {
  const match = /(\d{2}):(\d{2})/.exec(generatedAt);
  return match ? parseInt(match[1], 10) : 12;
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}
