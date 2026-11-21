import type { FinancePayment, FinanceStockItem, FinanceView } from "./types.js";

const DAY = 86_400_000;
const elapsed = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);
const metrics = ["cash", "paymentsDue", "debtors", "payables", "loans", "inventory"] as const;

export function parsePaymentDueHint(payment: Pick<FinancePayment, "tag" | "payee">, asOfDate: string) {
  const base = new Date(asOfDate);
  if (!Number.isFinite(base.getTime())) return null;
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const candidates: string[] = [];
  for (const text of [payment.tag ?? "", payment.payee]) {
    for (const match of text.matchAll(/(?<![\d.])(\d{1,2})\.(\d{1,2})(?!\d|[.,]\d)|(?<![\p{L}\d])(?:до\s+(\d{1,2})(?!\d|[.,]\d)|(\d{1,2})\s*[-–‑]\s*[еe](?!\p{L}))/giu)) {
      const day = Number(match[1] ?? match[3] ?? match[4]);
      const explicitMonth = match[2] ? Number(match[2]) - 1 : undefined;
      if (day < 1 || day > 31 || (explicitMonth !== undefined && (explicitMonth < 0 || explicitMonth > 11))) continue;
      const attempts = explicitMonth === undefined ? 12 : 9;
      for (let offset = 0; offset < attempts; offset++) {
        const date = explicitMonth === undefined
          ? new Date(Date.UTC(year, month + offset, day))
          : new Date(Date.UTC(year + offset, explicitMonth, day));
        if (date.getUTCDate() !== day) continue;
        const iso = date.toISOString().slice(0, 10);
        if (elapsed(asOfDate, iso) < 0) continue;
        candidates.push(iso);
        break;
      }
    }
  }
  const date = candidates.sort()[0];
  if (!date) return null;
  const days = elapsed(asOfDate, date);
  return { date, days, isSoon: days <= 5 };
}

export function isStockStagnant(hasMoves: boolean, item: FinanceStockItem): boolean {
  return hasMoves === true && item.startQty > 0 && !((item.outQty ?? 0) > 0) && item.endSum > 0;
}

export function buildFinanceInsights(finance: FinanceView, asOfDate?: string) {
  const { report } = finance;
  const history = [...finance.snapshots].sort((a, b) => a.dataDate.localeCompare(b.dataDate));
  const latest = history.at(-1);
  const older = latest ? history.filter((entry) => entry.dataDate < latest.dataDate) : [];
  const delta = (key: typeof metrics[number]) => {
    const current = latest?.[key];
    if (current === undefined || !latest) return {};
    const date = latest.dataDate;
    const entries = older.flatMap((entry) => {
      const value = entry[key];
      return value === undefined ? [] : [{ days: elapsed(entry.dataDate, date), change: current - value }];
    });
    const nearest = entries.at(-1);
    const prevDay = nearest && nearest.days <= 5 ? nearest : undefined;
    const week = entries.filter((entry) => entry.days >= 5 && entry.days <= 10)
      .sort((a, b) => Math.abs(a.days - 7) - Math.abs(b.days - 7))[0] ?? entries[0];
    return { prevDay, week };
  };
  const deltas = Object.fromEntries(metrics.map((key) => [key, delta(key)]));
  const date = asOfDate || report?.dataDate || "";
  const due = report?.payments[0]?.total ?? 0;
  const totalWithTax = due + (report?.tax?.total ?? 0);
  const aged = (report?.debtors.rows ?? []).flatMap((row) => {
    if (!row.saleDate) return [];
    const days = elapsed(row.saleDate, date);
    return days > 30 ? [{ ...row, saleDate: row.saleDate, days }] : [];
  }).sort((a, b) => Number(b.days > 60) - Number(a.days > 60) || b.amount - a.amount);
  const summarize = (rows: typeof aged) => ({ count: rows.length, total: rows.reduce((sum, row) => sum + row.amount, 0) });
  const sheets = report?.stock ?? [];
  const stagnant = sheets.flatMap((sheet) => sheet.warehouses.flatMap((warehouse) =>
    warehouse.items.filter((item) => isStockStagnant(sheet.hasMoves, item))
      .map((item) => ({ ...item, company: sheet.company, warehouse: warehouse.name }))
  )).sort((a, b) => b.endSum - a.endSum);
  const statementTotal = sheets.reduce((sum, sheet) => sum + sheet.total.end, 0);
  const diff = statementTotal - (report?.cash.inventory ?? 0);
  return {
    deltas,
    totalWithTax,
    cashGap: (report?.cash.total ?? 0) - totalWithTax,
    paymentHints: (report?.payments ?? []).map((list) => list.items.map((item) => parsePaymentDueHint(item, date))),
    debt: { over30: summarize(aged), over60: summarize(aged.filter((row) => row.days > 60)), top5: aged.slice(0, 5), top10: aged.slice(0, 10) },
    stock: { count: stagnant.length, total: stagnant.reduce((sum, item) => sum + item.endSum, 0), top5: stagnant.slice(0, 5), statementTotal, diff, mismatch: sheets.length > 0 && Math.abs(diff) > 1000 }
  };
}
