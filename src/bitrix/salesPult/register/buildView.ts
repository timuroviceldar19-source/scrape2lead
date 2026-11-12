import type {
  RegisterRow,
  RegisterContract,
  RegisterView,
  RegisterDailyPoint,
  RegisterManagerSummary,
  RegisterMixItem,
  RegisterChannelItem,
  RegisterGroupItem,
  RegisterTotal,
  RegisterHistoryPayload,
  RegisterPartnerSales
} from "./types.js";
import { isPartnerSale } from "./parseExcel.js";

function sumBy<T>(items: T[], fn: (item: T) => number | null | undefined): number {
  return items.reduce((s, x) => s + (fn(x) || 0), 0);
}

function countUniqueContracts(rows: RegisterRow[]): number {
  const set = new Set<string>();
  for (const r of rows) {
    set.add(`${r.date}|${r.customer}|${r.manager}`);
  }
  return set.size;
}

/** B2B и скрытые менеджеры входят в план отдела, но своей строки в списке не получают. */
export function listedPlanManagers(plans: Record<string, number>, hiddenManagers: string[] = []): string[] {
  return Object.keys(plans).filter((n) => n !== "B2B" && !hiddenManagers.includes(n));
}

function buildDailyPoints(rows: RegisterRow[]): RegisterDailyPoint[] {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.sale);
  }
  const sortedDates = [...byDay.keys()].sort();
  let acc = 0;
  return sortedDates.map((d) => {
    acc += byDay.get(d) ?? 0;
    return { d, sale: acc };
  });
}

function buildManagersSummary(
  rows: RegisterRow[],
  plans: Record<string, number>,
  missing: RegisterContract[],
  hasVal: boolean,
  hiddenManagers?: string[]
): RegisterManagerSummary[] {
  const missingByManager = new Map<string, RegisterContract[]>();
  for (const m of missing) {
    const arr = missingByManager.get(m.manager) ?? [];
    arr.push(m);
    missingByManager.set(m.manager, arr);
  }

  const allNames = new Set<string>([
    ...listedPlanManagers(plans, hiddenManagers),
    ...rows.map((r) => r.manager)
  ]);

  const summaries: RegisterManagerSummary[] = [];

  for (const name of allNames) {
    const ownRows = rows.filter((r) => r.manager === name);
    const sale = sumBy(ownRows, (r) => r.sale);
    const val = hasVal ? sumBy(ownRows, (r) => r.val) : null;
    const bonus = sumBy(ownRows, (r) => r.bonusMop);
    const plan = plans[name] ?? 0;
    const contracts = countUniqueContracts(ownRows);
    const ownMiss = missingByManager.get(name) ?? [];
    const missCount = ownMiss.length;
    const missSum = sumBy(ownMiss, (m) => m.sale);
    const margin = (hasVal && sale > 0 && val !== null) ? val / sale : null;

    summaries.push({
      name,
      sale,
      val,
      margin,
      bonus,
      plan,
      contracts,
      missCount,
      missSum,
      rows: [...ownRows].sort((a, b) => b.date.localeCompare(a.date) || b.sale - a.sale)
    });
  }

  return summaries.sort((a, b) => b.sale - a.sale);
}

function buildMixItems(rows: RegisterRow[], hasVal: boolean): RegisterMixItem[] {
  const byKind = new Map<string, RegisterRow[]>();
  for (const r of rows) {
    const arr = byKind.get(r.kind) ?? [];
    arr.push(r);
    byKind.set(r.kind, arr);
  }

  const items: RegisterMixItem[] = [];
  for (const [kind, kindRows] of byKind.entries()) {
    items.push({
      kind,
      group: kindRows[0]?.group ?? "Прочее",
      sale: sumBy(kindRows, (r) => r.sale),
      val: hasVal ? sumBy(kindRows, (r) => r.val) : null,
      qty: sumBy(kindRows, (r) => r.qty),
      contracts: countUniqueContracts(kindRows)
    });
  }

  return items.sort((a, b) => b.sale - a.sale);
}

function buildChannelItems(rows: RegisterRow[], hasVal: boolean): RegisterChannelItem[] {
  const byChannel = new Map<string, RegisterRow[]>();
  for (const r of rows) {
    const arr = byChannel.get(r.channel) ?? [];
    arr.push(r);
    byChannel.set(r.channel, arr);
  }

  const items: RegisterChannelItem[] = [];
  for (const [name, chRows] of byChannel.entries()) {
    items.push({
      name,
      sale: sumBy(chRows, (r) => r.sale),
      val: hasVal ? sumBy(chRows, (r) => r.val) : null,
      contracts: countUniqueContracts(chRows)
    });
  }

  return items.sort((a, b) => b.sale - a.sale);
}

function buildPartnerSales(rows: RegisterRow[], hasVal: boolean): RegisterPartnerSales | undefined {
  if (!rows.length) return undefined;
  const sale = sumBy(rows, (r) => r.sale);
  const val = hasVal ? sumBy(rows, (r) => r.val) : null;
  return {
    sale,
    val,
    margin: val !== null && sale > 0 ? val / sale : null,
    bonusMop: sumBy(rows, (r) => r.bonusMop),
    bonusRop: sumBy(rows, (r) => r.bonusRop),
    contracts: countUniqueContracts(rows),
    kinds: [...new Set(rows.map((r) => r.kind))],
    rows: [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.sale - a.sale)
  };
}

export function buildRegisterView(params: {
  rows: RegisterRow[];
  plans: Record<string, number>;
  missing: RegisterContract[];
  extraDealsCount: number;
  fileName: string;
  asOf: string;
  month: string;
  hasValColumn?: boolean;
  hiddenManagers?: string[];
  history?: RegisterHistoryPayload;
  historyError?: string;
  error?: string;
}): RegisterView {
  const { rows: allRows, plans, missing, extraDealsCount, fileName, asOf, month, hasValColumn, hiddenManagers, history, historyError, error } = params;
  const hasVal = hasValColumn ?? (allRows.length === 0 || allRows.some((r) => r.val !== null));
  // Итоги, план и разбивки отдела — без партнёрских продаж; сверка с CRM и общий список — по всем строкам.
  const rows = allRows.filter((r) => !isPartnerSale(r));
  const partner = buildPartnerSales(allRows.filter(isPartnerSale), hasVal);

  const totalSale = sumBy(rows, (r) => r.sale);
  const totalVal = hasVal ? sumBy(rows, (r) => r.val) : null;
  const totalBonusMop = sumBy(rows, (r) => r.bonusMop);
  const totalBonusRop = sumBy(rows, (r) => r.bonusRop);
  const totalContracts = countUniqueContracts(rows);
  const totalPlan = Object.values(plans).reduce((s, p) => s + p, 0);
  const b2bPlan = plans.B2B ?? 0;
  const b2bSale = sumBy(
    rows.filter((r) => r.type.toLowerCase() === "b2b"),
    (r) => r.sale
  );

  const total: RegisterTotal = {
    sale: totalSale,
    val: totalVal,
    hasVal,
    margin: (hasVal && totalSale > 0 && totalVal !== null) ? totalVal / totalSale : null,
    bonusMop: totalBonusMop,
    bonusRop: totalBonusRop,
    contracts: totalContracts,
    plan: totalPlan,
    b2bPlan,
    b2bSale
  };

  const groups: RegisterGroupItem[] = (["ИП", "КТ"] as const).map((g) => {
    const gRows = rows.filter((r) => r.group === g);
    return {
      g,
      sale: sumBy(gRows, (r) => r.sale),
      val: hasVal ? sumBy(gRows, (r) => r.val) : null
    };
  });

  const sortedMissing = [...missing]
    .sort((a, b) => b.sale - a.sale)
    .map((m) => ({
      date: m.date,
      manager: m.manager,
      customer: m.customer,
      sale: m.sale,
      products: m.products,
      type: m.type
    }));

  return {
    file: fileName,
    asOf,
    month,
    total,
    daily: buildDailyPoints(rows),
    managers: buildManagersSummary(rows, plans, missing, hasVal, hiddenManagers),
    mix: buildMixItems(rows, hasVal),
    channels: buildChannelItems(rows, hasVal),
    groups,
    ...(partner ? { partner } : {}),
    missing: sortedMissing,
    crmExtra: extraDealsCount,
    rows: [...allRows].sort((a, b) => b.date.localeCompare(a.date) || b.sale - a.sale),
    history,
    historyError,
    error
  };
}
