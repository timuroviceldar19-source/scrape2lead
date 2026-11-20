import type { NormalizedPlanDeal, PlanDealItem, PlanFormerManagersItem, PlanLostToView, PlansGroupSliceView, PlansGroupView, PlansMonitorView } from "./types.js";

const sum = (deals: NormalizedPlanDeal[]) => deals.reduce((s, d) => s + d.sum, 0);
const largest = <T extends { sum: number }>(items: T[]) => items.sort((a, b) => b.sum - a.sum);
const customerKey = (d: NormalizedPlanDeal) => d.customerBin || d.customerName || `deal:${d.id}`;
function buckets(deals: NormalizedPlanDeal[], key: (d: NormalizedPlanDeal) => string): NormalizedPlanDeal[][] {
  const map = new Map<string, NormalizedPlanDeal[]>();
  for (const d of deals) { const k = key(d); const list = map.get(k) || []; list.push(d); map.set(k, list); }
  return [...map.values()];
}
// В списки UI передаём только поля карточки, без служебных признаков агрегации.
function planItem(d: NormalizedPlanDeal): PlanDealItem {
  const { group, managerId, dateCreate, outcomeKey, isOpen, isWonCrm, isLostCrm, lostTo, ...item } = d;
  return item;
}
const planList = (deals: NormalizedPlanDeal[]) => largest([...deals]).slice(0, 20).map(planItem);

const LOST_TO_TOP = 15;
// Договор считается дешевле плана, если он меньше суммы плана больше чем на 0,5%.
const CHEAPER_THAN_PLAN = 0.995;
function lostToView(lost: NormalizedPlanDeal[]): PlanLostToView {
  const known = lost.filter((d) => d.lostTo);
  const competitors = buckets(known, (d) => d.lostTo!.bin).map((ds) => {
    const withSum = ds.filter((d) => d.lostTo!.contractSum !== null);
    return {
      bin: ds[0].lostTo!.bin, name: ds[0].lostTo!.name, count: ds.length, planSum: sum(ds),
      contractSum: withSum.reduce((s, d) => s + d.lostTo!.contractSum!, 0), knownSumCount: withSum.length,
      cheaperCount: withSum.filter((d) => d.sum > 0 && d.lostTo!.contractSum! < d.sum * CHEAPER_THAN_PLAN).length,
      deals: largest([...ds]).slice(0, 20).map((d) => ({
        id: d.id, dealUrl: d.dealUrl, planNumber: d.planNumber, planUrl: d.planUrl, month: d.month,
        customerName: d.customerName, itemName: d.itemName, managerName: d.managerName,
        planSum: d.sum, contractSum: d.lostTo!.contractSum
      }))
    };
  });
  competitors.sort((a, b) => b.count - a.count || b.planSum - a.planSum || a.bin.localeCompare(b.bin));
  return { lostCount: lost.length, companies: competitors.length, unknownCount: lost.length - known.length, competitors: competitors.slice(0, LOST_TO_TOP) };
}

// Ушедшие: строки в таблице менеджеров не получают, но их закупки остаются в итогах и списках.
function formerView(deals: NormalizedPlanDeal[]): PlanFormerManagersItem | undefined {
  if (!deals.length) return undefined;
  const open = deals.filter(d => d.isOpen);
  return { people: new Set(deals.map(d => d.managerId)).size, count: deals.length, sum: sum(deals), openCount: open.length, openSum: sum(open) };
}

export function buildSingleSliceView(deals: NormalizedPlanDeal[], asOfDate: string, formerManagerIds: ReadonlySet<string> = new Set()): PlansGroupSliceView {
  const open = deals.filter(d => d.isOpen);
  const fresh = open.filter(d => d.isNewStage);
  const won = deals.filter(d => d.outcomeCategory === "won");
  const lost = deals.filter(d => d.outcomeCategory === "lost");
  const cancelled = deals.filter(d => d.outcomeCategory === "cancelled");
  const published = deals.filter(d => d.outcomeCategory === "published");
  const from = new Date(`${asOfDate}T00:00:00+05:00`).getTime() - 6 * 86400000;
  const to = new Date(`${asOfDate}T23:59:59.999+05:00`).getTime();
  const recent = deals.filter(d => {
    const date = new Date(d.dateCreate.length === 10 ? `${d.dateCreate}T00:00:00+05:00` : d.dateCreate).getTime();
    return date >= from && date <= to;
  });
  const formerManagers = formerView(deals.filter(d => formerManagerIds.has(d.managerId)));
  return {
    total: { sum: sum(deals), count: deals.length, qty: deals.reduce((s, d) => s + d.qty, 0), customers: new Set(deals.map(customerKey)).size,
      openSum: sum(open), openCount: open.length, newSum: sum(fresh), newCount: fresh.length,
      publishedSum: sum(published), publishedCount: published.length, wonSum: sum(won), wonCount: won.length,
      lostSum: sum(lost), lostCount: lost.length, cancelledSum: sum(cancelled), cancelledCount: cancelled.length,
      createdLast7dSum: sum(recent), createdLast7dCount: recent.length },
    managers: largest(buckets(deals.filter(d => !formerManagerIds.has(d.managerId)), d => d.managerId).map(ds => ({
      id: ds[0].managerId, name: ds[0].managerName, sum: sum(ds), count: ds.length,
      openSum: sum(ds.filter(d => d.isOpen)), openCount: ds.filter(d => d.isOpen).length,
      newCount: ds.filter(d => d.isNewStage).length, wonSum: sum(ds.filter(d => d.outcomeCategory === "won")),
      wonCount: ds.filter(d => d.outcomeCategory === "won").length, lostCount: ds.filter(d => d.outcomeCategory === "lost").length,
      planList: planList(ds.filter(d => d.isOpen))
    }))),
    ...(formerManagers ? { formerManagers } : {}),
    methods: largest(buckets(deals, d => d.method).map(ds => ({ name: ds[0].method, sum: sum(ds), count: ds.length, openCount: ds.filter(d => d.isOpen).length }))),
    kinds: largest(buckets(deals, d => d.kind).map(ds => {
      const qty = ds.reduce((s, d) => s + d.qty, 0);
      return { kind: ds[0].kind, sum: sum(ds), count: ds.length, qty, avgPrice: qty > 0 ? sum(ds) / qty : 0 };
    })),
    statuses: largest(buckets(deals, d => d.portalStatus).map(ds => ({ status: ds[0].portalStatus, sum: sum(ds), count: ds.length }))),
    customers: largest(buckets(deals, customerKey).map(ds => ({
      bin: ds[0].customerBin, name: ds[0].customerName, sum: sum(ds), count: ds.length,
      openSum: sum(ds.filter(d => d.isOpen)), openCount: ds.filter(d => d.isOpen).length, planList: planList(ds)
    }))).slice(0, 15),
    lostTo: lostToView(lost)
  };
}

function buildGroupView(group: "ИП" | "КТ", deals: NormalizedPlanDeal[], asOfDate: string, former: ReadonlySet<string>): PlansGroupView {
  const items = deals.filter(d => d.group === group);
  const all = buildSingleSliceView(items, asOfDate, former);
  const monthViews: Record<string, PlansGroupSliceView> = { all };
  const months = [...new Set(items.map(d => d.month))].sort().map(m => {
    const ds = items.filter(d => d.month === m);
    monthViews[m] = buildSingleSliceView(ds, asOfDate, former);
    return { m, sum: sum(ds), count: ds.length, activeSum: sum(ds.filter(d => d.isOpen || d.outcomeCategory === "won")),
      wonSum: monthViews[m].total.wonSum, newCount: monthViews[m].total.newCount };
  });
  return { group, ...all, months, monthViews, openPlans: largest(items.filter(d => d.isOpen)).map(d => ({ ...planItem(d), managerId: d.managerId })) };
}

/** `formerManagerIds` — ушедшие сотрудники: из таблицы менеджеров убираются, итоги не меняются. */
export function buildPlansMonitorView(deals: NormalizedPlanDeal[], options: { asOfDate: string; formerManagerIds?: Iterable<string> }): PlansMonitorView {
  const former = new Set([...(options.formerManagerIds ?? [])].map(String));
  return { asOf: options.asOfDate, ip: buildGroupView("ИП", deals, options.asOfDate, former), kt: buildGroupView("КТ", deals, options.asOfDate, former) };
}
