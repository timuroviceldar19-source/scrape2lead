// Выдуманные данные для вердикта «идём / осторожно / не идём» (пункт 5 RFC). Заказчики, компании, БИН и тексты
// причин придуманы; формы данных — подмножества настоящих срезов «Планов», «Рынка», «Конкурентов» и «Радара».
import type { SalesPultPayload } from "../../../src/bitrix/salesPult/types.js";
import type { RadarCard, RadarGroupView, RadarView } from "../../../src/bitrix/salesPult/radar/types.js";
import { computeRadarKpis } from "../../../src/bitrix/salesPult/radar/aggregate.js";
import { buildPlansMonitorView } from "../../../src/bitrix/salesPult/plans/aggregate.js";
import type { NormalizedPlanDeal } from "../../../src/bitrix/salesPult/plans/types.js";
import { fixture } from "./contracts.js";

export const BID_AS_OF = "2026-11-21";

/** Выдуманный текст подробной причины отклонения: в страницу и вердикт он попадать не должен. */
export const BID_SECRET_DETAIL = "Диагональ меньше требуемой (выдумано для теста)";

export const C = {
  nogo: { bin: "000000000201", name: "Школа «Пример-1»" },
  caution: { bin: "000000000202", name: "Школа «Пример-2»" },
  go: { bin: "000000000203", name: "Школа «Пример-3»" },
  unknown: { bin: "000000000204", name: "Школа «Пример-4»" },
  ours: { bin: "000000000205", name: "Школа «Пример-5»" },
  rejected: { bin: "000000000206", name: "Гимназия «Пример-6»" }
} as const;

const RIVAL = { bin: "000000000901", name: "ТОО Соперник-тест" };

function card(id: string, customer: { bin: string; name: string }, extra: Partial<RadarCard> = {}): RadarCard {
  return {
    id, dealUrl: `https://example.com/deal/${id}`, sourceType: "lot", lotNumber: `${id}-1`, title: 'Панель 75"',
    itemName: 'Панель 75"', qty: 2, sum: 200000, method: "Запрос ценовых предложений", status: "Опубликовано",
    group: "ИП", kind: "Интерактивные панели", customerName: customer.name, customerBin: customer.bin,
    managerId: "s", managerName: "Тестовый менеджер", startAt: null, endAt: "2026-11-21 18:00:00", hoursLeft: 8,
    isToday: true, isWithin48h: true, column: "submitToday", ...extra
  };
}

/** Карточки «Подать»: срочная дешёвая «осторожно» выше по сроку, дорогая «идём» — выше по ценности. */
export function bidRadarCards(): RadarCard[] {
  return [
    card("9101", C.nogo, { endAt: "2026-11-21 17:00:00", hoursLeft: 7 }),
    card("9102", C.caution, { endAt: "2026-11-21 17:30:00", hoursLeft: 7.5, sum: 220000 }),
    card("9103", C.go, { endAt: "2026-11-22 12:00:00", hoursLeft: 26, isToday: false, sum: 240000 }),
    card("9104", C.unknown, { endAt: "2026-11-22 15:00:00", hoursLeft: 29, isToday: false, kind: "Прочее", itemName: "Стенд выставочный", title: "Стенд выставочный" }),
    card("9105", C.ours, { endAt: "2026-11-23 15:00:00", hoursLeft: 53, isToday: false, isWithin48h: false }),
    card("9106", C.rejected, { endAt: "2026-11-23 16:00:00", hoursLeft: 54, isToday: false, isWithin48h: false })
  ];
}

function group(g: "ИП" | "КТ", cards: RadarCard[], missed: RadarCard[] = []): RadarGroupView {
  const out = { group: g, submitToday: cards, discussion: [], secondChance: [], missed } as unknown as RadarGroupView;
  out.kpis = computeRadarKpis(out);
  return out;
}

export function bidRadar(): RadarView {
  const missed = card("9199", C.nogo, { column: "missed", endAt: "2026-11-19 10:00:00", hoursLeft: null, isNewStage: true });
  return { asOf: BID_AS_OF, ip: group("ИП", bidRadarCards(), [missed]), kt: group("КТ", []) };
}

const planDeal = (id: string, customer: { bin: string; name: string }, extra: Partial<NormalizedPlanDeal> = {}): NormalizedPlanDeal => ({
  id, dealUrl: `https://example.com/deal/${id}`, planNumber: `P${id}`, planUrl: "", month: "2026-11",
  customerName: customer.name, customerBin: customer.bin, itemName: 'Панель 75"', truCode: "", kind: "Интерактивные панели",
  qty: 2, price: 120000, sum: 240000, method: "Конкурс", portalStatus: "Утвержден", managerName: "Тестовый менеджер",
  isNewStage: false, outcomeCategory: "open", group: "ИП", managerId: "s", dateCreate: "2026-11-01", outcomeKey: "",
  isOpen: true, isWonCrm: false, isLostCrm: false, ...extra
});

export function bidPlanDeals(): NormalizedPlanDeal[] {
  return [
    planDeal("9201", C.go),
    planDeal("9202", C.caution, { managerId: "t", managerName: "Другой менеджер", price: 0, sum: 80000 }),
    // проигрыш по CRM у «осторожного» заказчика: виден и менеджеру, это его собственные сделки
    planDeal("9203", C.caution, { isOpen: false, outcomeCategory: "lost", lostTo: { ...RIVAL, contractSum: 211200 } })
  ];
}

const lot = (customer: { bin: string; name: string }, lotNumber: string) =>
  ({ customerBin: customer.bin, customerName: customer.name, lotNumber, annoId: lotNumber.split("-")[0] });

/** «Рынок» и «Конкуренты» ИП: только поля, которые читает вердикт. */
export function bidMarket() {
  return {
    ip: {
      kinds: [{ kind: "Интерактивные панели", med: 100000, usMed: 95000 }],
      customers: [{ bin: C.go.bin, name: C.go.name, us: 1, contractList: [] }],
      suppliers: []
    }
  };
}

export function bidCompetitors() {
  return {
    asOf: BID_AS_OF, months: [],
    ip: {
      competitors: [{ ...RIVAL, us: false, lotList: [{ ...lot(C.caution, "800-1"), isWinner: true, discountPct: 12 }] }],
      headToHead: [],
      ourRejections: [1, 2].map((n) => ({
        annoId: `70${n}`, lotNumber: `70${n}-1`, ourBin: "000000000001", customerName: C.rejected.name,
        rejectionShort: "Не соответствует технической спецификации", rejectionDetail: BID_SECRET_DETAIL
      })),
      specTemplates: [
        { templateName: "Шаблон-тест Соперника", winners: [{ name: RIVAL.name, sharePct: 70, ourCompany: "" }],
          lots: [{ ...lot(C.nogo, "9101-1"), strength: "strong", sharePct: 90 }] },
        { templateName: "Шаблон-тест наш", winners: [{ name: "ТОО Наша-тест", sharePct: 65, ourCompany: "F3" }],
          lots: [{ ...lot(C.ours, "600-1"), strength: "partial", sharePct: 40 }] }
      ],
      prices: { rows: [{ label: 'Панель 75"', compWinner: { med: 100000 }, ourWinner: { med: null } }], kitsRow: null },
      monthViews: {}
    },
    kt: null
  };
}

export function bidPayload(): { payload: SalesPultPayload; planDeals: NormalizedPlanDeal[] } {
  const { payload } = fixture();
  const planDeals = bidPlanDeals();
  Object.assign(payload, {
    asOfDate: BID_AS_OF,
    generatedAt: "2026-11-21 09:49 (UTC+5)",
    plans: buildPlansMonitorView(planDeals, { asOfDate: BID_AS_OF }),
    radar: bidRadar(),
    market: bidMarket(),
    competitors: bidCompetitors()
  });
  return { payload, planDeals };
}
