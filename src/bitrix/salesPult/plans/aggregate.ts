import type { NormalizedPlanDeal, PlanDealItem, PlansGroupSliceView, PlansGroupView, PlansMonitorView } from "./types.js";

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
  const { group, managerId, dateCreate, outcomeKey, isOpen, isWonCrm, isLostCrm, ...item } = d;
  return item;
}
const planList = (deals: NormalizedPlanDeal[]) => largest([...deals]).slice(0, 20).map(planItem);

export function buildSingleSliceView(deals: NormalizedPlanDeal[], asOfDate: string): PlansGroupSliceView {
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
  return {
    total: { sum: sum(deals), count: deals.length, qty: deals.reduce((s, d) => s + d.qty, 0), customers: new Set(deals.map(customerKey)).size,
      openSum: sum(open), openCount: open.length, newSum: sum(fresh), newCount: fresh.length,
      publishedSum: sum(published), publishedCount: published.length, wonSum: sum(won), wonCount: won.length,
      lostSum: sum(lost), lostCount: lost.length, cancelledSum: sum(cancelled), cancelledCount: cancelled.length,
      createdLast7dSum: sum(recent), createdLast7dCount: recent.length },
    managers: largest(buckets(deals, d => d.managerId).map(ds => ({
      id: ds[0].managerId, name: ds[0].managerName, sum: sum(ds), count: ds.length,
      openSum: sum(ds.filter(d => d.isOpen)), openCount: ds.filter(d => d.isOpen).length,
      newCount: ds.filter(d => d.isNewStage).length, wonSum: sum(ds.filter(d => d.outcomeCategory === "won")),
      wonCount: ds.filter(d => d.outcomeCategory === "won").length, lostCount: ds.filter(d => d.outcomeCategory === "lost").length,
      planList: planList(ds.filter(d => d.isOpen))
    }))),
    methods: largest(buckets(deals, d => d.method).map(ds => ({ name: ds[0].method, sum: sum(ds), count: ds.length, openCount: ds.filter(d => d.isOpen).length }))),
    kinds: largest(buckets(deals, d => d.kind).map(ds => {
      const qty = ds.reduce((s, d) => s + d.qty, 0);
      return { kind: ds[0].kind, sum: sum(ds), count: ds.length, qty, avgPrice: qty > 0 ? sum(ds) / qty : 0 };
    })),
    statuses: largest(buckets(deals, d => d.portalStatus).map(ds => ({ status: ds[0].portalStatus, sum: sum(ds), count: ds.length }))),
    topOpenPlans: planList(open),
    customers: largest(buckets(deals, customerKey).map(ds => ({
      bin: ds[0].customerBin, name: ds[0].customerName, sum: sum(ds), count: ds.length,
      openSum: sum(ds.filter(d => d.isOpen)), openCount: ds.filter(d => d.isOpen).length, planList: planList(ds)
    }))).slice(0, 15)
  };
}

export function buildPlansMonitorView(deals: NormalizedPlanDeal[], options: { asOfDate: string }): PlansMonitorView {
  function groupView(group: "ИП" | "КТ"): PlansGroupView {
    const items = deals.filter(d => d.group === group);
    const all = buildSingleSliceView(items, options.asOfDate);
    const monthViews: Record<string, PlansGroupSliceView> = { all };
    const months = [...new Set(items.map(d => d.month))].sort().map(m => {
      const ds = items.filter(d => d.month === m);
      monthViews[m] = buildSingleSliceView(ds, options.asOfDate);
      return { m, sum: sum(ds), count: ds.length, activeSum: sum(ds.filter(d => d.isOpen || d.outcomeCategory === "won")),
        wonSum: monthViews[m].total.wonSum, newCount: monthViews[m].total.newCount };
    });
    return { group, ...all, months, monthViews };
  }
  return { asOf: options.asOfDate, ip: groupView("ИП"), kt: groupView("КТ") };
}
