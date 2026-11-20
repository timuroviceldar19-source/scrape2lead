export type PlanOutcome = "open" | "won" | "lost" | "cancelled" | "published";
export interface PlanDealItem {
  id: string;
  dealUrl: string;
  planNumber: string;
  planUrl: string;
  month: string;
  customerName: string;
  customerBin: string;
  itemName: string;
  truCode: string;
  kind: string;
  qty: number;
  price: number;
  sum: number;
  method: string;
  portalStatus: string;
  managerName: string;
  isNewStage: boolean;
  outcomeCategory: PlanOutcome;
}
export interface NormalizedPlanDeal extends PlanDealItem {
  group: "ИП" | "КТ";
  managerId: string;
  dateCreate: string;
  outcomeKey: string;
  isOpen: boolean;
  isWonCrm: boolean;
  isLostCrm: boolean;
  /** Победитель из комментария робота «Итог закупки: выиграл …»; только у проигранных сделок. */
  lostTo?: PlanLostTo;
}
export interface PlanLostTo { name: string; bin: string; contractSum: number | null }
export interface PlanLostDealItem {
  id: string; dealUrl: string; planNumber: string; planUrl: string; month: string;
  customerName: string; itemName: string; managerName: string; planSum: number; contractSum: number | null;
}
export interface PlanCompetitorItem {
  bin: string; name: string; count: number; planSum: number;
  /** Сумма известных договоров и число сделок, у которых сумма договора известна. */
  contractSum: number; knownSumCount: number;
  /** Договор меньше суммы плана больше чем на 0,5%. */
  cheaperCount: number;
  deals: PlanLostDealItem[];
}
export interface PlanLostToView {
  lostCount: number; companies: number; unknownCount: number;
  competitors: PlanCompetitorItem[];
}
export interface PlanManagerItem {
  id: string; name: string; sum: number; count: number;
  openCount: number; openSum: number; newCount: number;
  wonCount: number; wonSum: number; lostCount: number; planList: PlanDealItem[];
}
export interface PlanMethodItem { name: string; sum: number; count: number; openCount: number }
export interface PlanKindItem { kind: string; sum: number; count: number; qty: number; avgPrice: number }
export interface PlanStatusItem { status: string; sum: number; count: number }
export interface PlanCustomerItem { bin: string; name: string; sum: number; count: number; openSum: number; openCount: number; planList: PlanDealItem[] }
export interface PlanMonthBarItem { m: string; sum: number; count: number; activeSum: number; wonSum: number; newCount: number }
export interface PlanTotals {
  sum: number; count: number; qty: number; customers: number;
  openSum: number; openCount: number; newSum: number; newCount: number;
  publishedSum: number; publishedCount: number; createdLast7dCount: number; createdLast7dSum: number;
  wonSum: number; wonCount: number; lostSum: number; lostCount: number; cancelledSum: number; cancelledCount: number;
}
/** Закупки ушедших сотрудников: в таблице менеджеров их строк нет, в итогах страницы они есть. */
export interface PlanFormerManagersItem { people: number; count: number; sum: number; openCount: number; openSum: number }
export interface PlansGroupSliceView {
  total: PlanTotals;
  managers: PlanManagerItem[];
  /** Есть, только если в срезе есть закупки ушедших сотрудников. */
  formerManagers?: PlanFormerManagersItem;
  methods: PlanMethodItem[];
  kinds: PlanKindItem[];
  statuses: PlanStatusItem[];
  customers: PlanCustomerItem[];
  lostTo: PlanLostToView;
}
export interface PlansGroupView extends PlansGroupSliceView {
  openPlans: Array<PlanDealItem & { managerId: string }>;
  group: "ИП" | "КТ";
  months: PlanMonthBarItem[];
  monthViews: Record<string, PlansGroupSliceView>;
}
export interface PlansMonitorView { asOf: string; error?: string; ip?: PlansGroupView; kt?: PlansGroupView }
