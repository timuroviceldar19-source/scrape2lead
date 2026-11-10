import type { SalesPultPayload, SignalItem } from "./types.js";
import type { DealInfo } from "./metrics.js";
import type { RegisterView, RegisterMonthSummary } from "./register/types.js";
import { groupRegisterContracts, matchRegisterWithCrm, settleUnmatched } from "./register/matchCrm.js";
import { isWorkDay, DEFAULT_HOLIDAYS } from "./pace.js";
import { escapeHtml, MONTHS } from "./format.js";

type ManagerTotal = Pick<RegisterMonthSummary["byManager"][number], "name" | "contracts" | "sale">;

export interface ContractReconciliation {
  closedNotInRegister: Array<{ dealId: string; title: string; manager: string; amount: number; date: string }>;
  possibleDuplicates: Array<{ dealId: string; title: string; manager: string; registerManager: string }>;
}

export interface PultContractSource {
  reconciliation: ContractReconciliation;
  available: boolean;
  label: string;
  fact?: number;
  amount?: number;
  revenuePlan?: number;
  byManager: Array<ManagerTotal & { id?: string; groupId?: string }>;
  daily?: Array<{ date: string; contracts: number; amount: number }>;
  awaiting?: number;
  crmFact: number;
  crmAmount: number;
  signals: SignalItem[];
}

function workingDaysAfter(date: string, asOfDate: string, holidays: Set<string>): number {
  let count = 0;
  const end = Date.parse(`${asOfDate}T12:00:00Z`);
  for (let time = Date.parse(`${date}T12:00:00Z`) + 86400000; time <= end; time += 86400000) {
    const day = new Date(time);
    if (isWorkDay(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), holidays)) count++;
  }
  return count;
}

/** Только нужные пульту данные: без себестоимости, маржи и премий реестра. */
export function attachRegisterContracts(
  payload: SalesPultPayload, register: RegisterView, deals: Map<string, DealInfo>,
  aliases: Record<string, string> = {},
  ownerNames: ReadonlyMap<string, { name: string }> = new Map()
): void {
  const month = payload.asOfDate.slice(0, 7);
  const managers = payload.groups.flatMap(g => g.managers.map(m => ({ ...m, groupId: g.id })));
  const crmIds = new Set(managers.flatMap(m => m.rollups.month.contracts.dealIds));
  const source: PultContractSource = {
    available: false,
    label: payload.closedMonth
      ? "реестр ОП за месяц недоступен, цифры по Битриксу"
      : "реестр ОП недоступен, цифры по Битриксу",
    byManager: [],
    crmFact: managers.reduce((sum, m) => sum + m.rollups.month.contracts.uniqueDealsCount, 0),
    crmAmount: managers.reduce((sum, m) => sum + m.rollups.month.contracts.totalAmount, 0),
    signals: [],
    reconciliation: { closedNotInRegister: [], possibleDuplicates: [] }
  };
  payload.contractSource = source;

  const normalize = (name: string) => name.trim().toLocaleLowerCase("ru");
  const findManager = (name: string) => {
    const full = normalize(aliases[name] ?? name);
    const exact = managers.find(m => normalize(m.name) === full);
    if (exact) return exact;
    const first = managers.filter(m => normalize(m.name).split(/\s+/)[0] === full);
    // Совпадение только имени допустимо, если оно однозначно в настройках.
    return first.length === 1 ? first[0] : undefined;
  };
  const setManagers = (items: ManagerTotal[]) => {
    source.byManager = items.map(m => {
      const manager = findManager(m.name);
      return { ...m, id: manager?.id, groupId: manager?.groupId };
    });
  };

  if (!register.error && register.month === month && register.rows) {
    const rows = register.rows.filter(r => r.date.startsWith(month) && r.date <= payload.asOfDate);
    const contracts = groupRegisterContracts(rows);
    source.available = true;
    source.label = `по реестру ОП, файл «${register.file}»`;
    source.fact = contracts.length;
    source.amount = rows.reduce((sum, r) => sum + r.sale, 0);
    source.revenuePlan = register.total!.plan;
    setManagers([...new Set(rows.map(r => r.manager))].map(name => ({
      name,
      contracts: contracts.filter(c => c.manager === name).length,
      sale: rows.filter(r => r.manager === name).reduce((sum, r) => sum + r.sale, 0)
    })));
    source.daily = [...new Set(rows.map(r => r.date))].sort().map(date => ({
      date,
      contracts: contracts.filter(c => c.date === date).length,
      amount: rows.filter(r => r.date === date).reduce((sum, r) => sum + r.sale, 0)
    }));

    if (!payload.closedMonth) {
      const companies = new Map(register.crmDeals?.map(d => [d.id, d.company]));
      const crm = [...crmIds].flatMap(id => {
        const deal = deals.get(id);
        if (!deal) return [];
        return [{
          id, title: deal.title, company: companies.get(id) ?? "", amount: deal.amount,
          manager: managers.find(m => m.id === deal.assignedById)?.name ?? ownerNames.get(deal.assignedById)?.name ?? `сотрудник ID ${deal.assignedById}`,
          // Дата перехода предпочтительнее планового CLOSEDATE.
          date: deal.contractDate || deal.portalSignDate || deal.closeDate?.slice(0, 10)
        }];
      });
      const result = matchRegisterWithCrm(contracts, crm, { managerAliases: aliases });
      const settled = settleUnmatched(result, contracts, aliases);
      const pending = settled.extra;
      source.awaiting = pending.length;
      const holidays = new Set(payload.holidays ?? DEFAULT_HOLIDAYS);
      for (const deal of pending) {
        if (!deal.date || !/^\d{4}-\d{2}-\d{2}$/.test(deal.date)) continue;
        if (workingDaysAfter(deal.date, payload.asOfDate, holidays) > 2) {
          source.reconciliation.closedNotInRegister.push({
            dealId: deal.id, title: deal.title, manager: deal.manager, amount: deal.amount, date: deal.date
          });
        }
      }
      for (const { deal, contract } of settled.repeats) {
        source.reconciliation.possibleDuplicates.push({
          dealId: deal.id, title: deal.title, manager: deal.manager, registerManager: contract.manager
        });
      }
    }
  } else {
    const summary = register.history?.months.find(m => m.month === month);
    if (summary) {
      source.available = true;
      source.label = `по реестру ОП, файл «${summary.fileName}»`;
      source.fact = summary.contracts;
      source.amount = summary.sale;
      source.revenuePlan = summary.plan;
      source.daily = summary.dailyContracts;
      setManagers(summary.byManager.map(({ name, contracts, sale }) => ({ name, contracts, sale })));
    } else if (!register.error && register.month && register.month < month) {
      // В первые дни месяца последний файл ОП ещё за прошлый месяц — это не сбой.
      source.label = `файла ОП за ${MONTHS[Number(month.slice(5, 7)) - 1].toLocaleLowerCase("ru")} ещё нет, цифры по Битриксу`;
    }
  }

  if (payload.closedMonth) return;
  for (const deal of deals.values()) {
    const manager = managers.find(m => m.id === deal.assignedById)?.name ?? ownerNames.get(deal.assignedById)?.name ?? `сотрудник ID ${deal.assignedById}`;
    if (crmIds.has(deal.id) && deal.amount === 0) {
      source.signals.push({
        color: "yellow",
        text: `<b>${escapeHtml(manager)}</b>: Сумма сделки 0 — ${escapeHtml(deal.title)} (${escapeHtml(deal.id)})`
      });
    }
    const wonInCrm = deal.stageSemanticId === "S" || /(?:^|:)WON$/.test(deal.stageId ?? "");
    if (wonInCrm && deal.outcome?.startsWith("lost:")) {
      source.signals.push({
        color: "red",
        text: `<b>${escapeHtml(manager)}</b>: Успешна в Битриксе, а на портале договор у другого поставщика — ${escapeHtml(deal.title)} (${escapeHtml(deal.id)})`
      });
    }
  }
}
