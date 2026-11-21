import { describe, expect, it } from "vitest";
import {
  buildManagerPulse,
  buildMorningPulse,
  pulseForPayload,
  selectHotLots,
  PULSE_BIG_LOT_SUM,
  PULSE_MAX_ITEMS,
  type PulseItem
} from "../../src/bitrix/salesPult/pulse.js";
import { buildDirectorDigest, buildMorningReport } from "../../src/bitrix/salesPult/chatReport.js";
import { parseFinanceWorkbook } from "../../src/bitrix/salesPult/finance/parseReport.js";
import { buildFinanceInsights } from "../../src/bitrix/salesPult/finance/insights.js";
import { buildRegisterView } from "../../src/bitrix/salesPult/register/buildView.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { formatPultMoney } from "../../src/bitrix/salesPult/format.js";
import type { FinanceView } from "../../src/bitrix/salesPult/finance/types.js";
import type { RadarCard, RadarGroupView, RadarView } from "../../src/bitrix/salesPult/radar/types.js";
import type { RegisterRow, RegisterView } from "../../src/bitrix/salesPult/register/types.js";
import { financeWorkbook } from "../fixtures/sales-pult/financeWorkbook.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";

// Все данные выдуманные: лоты, суммы, заказчики, менеджеры.
const AS_OF = "2026-11-17";
const NOW = "2026-11-17T04:00:00.000Z"; // 09:00 Алматы

function finance(): FinanceView {
  return { report: parseFinanceWorkbook(financeWorkbook({ stockSheets: true })), snapshots: [] };
}

function card(id: string, extra: Partial<RadarCard> = {}): RadarCard {
  return {
    id, dealUrl: `https://example.invalid/crm/deal/details/${id}/`, sourceType: "lot", lotNumber: `L-${id}`,
    title: `GZ L-${id} — Панель выдуманная`, itemName: "Панель выдуманная", qty: 1, sum: 1_000_000,
    method: "Запрос ценовых предложений", status: "Опубликован (прием заявок)", group: "ИП", kind: "Интерактивные панели",
    customerName: "Школа Тест", customerBin: "000000000001", managerId: "m1", managerName: "Менеджер Тестовый",
    startAt: "2026-11-10 10:00", endAt: "2026-11-17 18:00", hoursLeft: 9, isToday: true, isWithin48h: true,
    column: "submitToday", ...extra
  };
}

const kpis = { totalCount: 0, totalSum: 0, submitCount: 0, submitSum: 0, discussionCount: 0, discussionSum: 0, secondChanceCount: 0, secondChanceSum: 0 };
const group = (g: "ИП" | "КТ", submitToday: RadarCard[]): RadarGroupView => ({ group: g, kpis, submitToday, discussion: [], secondChance: [] });
const radar = (ip: RadarCard[], kt: RadarCard[] = []): RadarView => ({ asOf: AS_OF, ip: group("ИП", ip), kt: group("КТ", kt.map((c) => ({ ...c, group: "КТ" }))) });

function regRow(extra: Partial<RegisterRow>): RegisterRow {
  return {
    date: "2026-11-10", type: "зцп", customer: "Заказчик Тест", qty: 1, product: "панель", cost: 800, extras: 0, sale: 1000,
    portal: 1120, val: 200, bonusMop: 0, bonusRop: 0, manager: "Алия", note: null, group: "ИП", kind: "Интерактивные панели",
    channel: "ЗЦП", ...extra
  };
}

function register(rows: RegisterRow[], month = "2026-11", asOf = AS_OF): RegisterView {
  return buildRegisterView({ fileName: "ОП тест.xlsx", asOf, month, rows, plans: {}, missing: [], extraDealsCount: 0 });
}

const keys = (items: PulseItem[]) => items.map((i) => i.key);

describe("утренний пульс: финансы", () => {
  it("кассовый разрыв и долги старше 60 дней — красные, суммы как на странице «Финансы»", () => {
    const fin = finance();
    const insights = buildFinanceInsights(fin, AS_OF);
    const pulse = buildMorningPulse({ asOfDate: AS_OF, nowIso: NOW, finance: fin });
    const cash = pulse.items.find((i) => i.area === "cash")!;
    expect(insights.cashGap).toBeLessThan(0);
    expect(cash).toMatchObject({ severity: "red", finance: true, href: "./fin.html#f-payments", amount: -insights.cashGap });
    expect(cash.value).toBe(`не хватает ${formatPultMoney(-insights.cashGap)}`);
    const debt = pulse.items.find((i) => i.area === "debt")!;
    expect(debt).toMatchObject({ key: "debt-60", severity: "red", finance: true, href: "./fin.html#f-debtors", amount: insights.debt.over60.total });
    expect(debt.value).toContain(formatPultMoney(insights.debt.over60.total));
    // Склад фикстуры меньше порога — шума нет.
    expect(pulse.items.some((i) => i.area === "stock")).toBe(false);
    expect(pulse.missing).toEqual([]);
    expect(pulse.asOf).toBe(AS_OF);
  });

  it("долги только 31–60 дней — жёлтые; запас денег — без пункта; крупный неподвижный склад — жёлтый", () => {
    const fin = finance();
    const report = fin.report!;
    report.debtors.rows = [{ name: "Должник Тест", company: "Альфа", amount: 4_000_000, saleDate: "2026-10-10" }];
    report.cash.total = 900_000_000;
    report.stock!.find((s) => s.hasMoves)!.warehouses[0].items.forEach((item) => { if (item.startQty > 0 && !item.outQty) item.endSum = 3_000_000; });
    const insights = buildFinanceInsights(fin, AS_OF);
    const pulse = buildMorningPulse({ asOfDate: AS_OF, nowIso: NOW, finance: fin });
    expect(pulse.items.some((i) => i.area === "cash")).toBe(false);
    expect(pulse.items.find((i) => i.area === "debt")).toMatchObject({ key: "debt-30", severity: "yellow" });
    expect(pulse.items.find((i) => i.area === "stock")).toMatchObject({
      severity: "yellow", finance: true, href: "./fin.html#f-stock", amount: insights.stock.total, value: formatPultMoney(insights.stock.total)
    });
  });

  it("без финансов пунктов нет, в missing — пояснение; ошибка загрузки — тоже", () => {
    for (const fin of [undefined, { snapshots: [], error: "нет файла" } as FinanceView]) {
      const pulse = buildMorningPulse({ asOfDate: AS_OF, nowIso: NOW, finance: fin });
      expect(pulse.items.filter((i) => i.finance)).toEqual([]);
      expect(pulse.missing).toEqual(["Финансы: нет отчёта"]);
    }
  });

  it("отчёт старше 3 дней — пометка с датой данных и в missing, и в пунктах", () => {
    const fin = finance(); // данные на 16.11
    const fresh = buildMorningPulse({ asOfDate: "2026-11-19", nowIso: NOW, finance: fin });
    expect(fresh.missing).toEqual([]);
    const stale = buildMorningPulse({ asOfDate: "2026-11-21", nowIso: NOW, finance: fin });
    expect(stale.missing).toEqual(["Финансы: отчёт на 16.11"]);
    expect(stale.items.filter((i) => i.finance).every((i) => i.detail?.includes("отчёт на 16.11"))).toBe(true);
  });
});

describe("утренний пульс: тендеры", () => {
  it("срок подачи сегодня: красный, если есть лот < 4 ч; число и сумма; ссылка на свою вкладку", () => {
    const pulse = buildMorningPulse({
      asOfDate: AS_OF, nowIso: NOW,
      radar: radar(
        [card("1", { endAt: "2026-11-17 11:30", sum: 2_000_000 }), card("2", { sum: 3_000_000 })],
        [card("3", { sum: 5_000_000 })]
      )
    });
    const ip = pulse.items.find((i) => i.key === "tender-today-ip")!;
    expect(ip).toMatchObject({ severity: "red", area: "tender", finance: false, href: "#radar-ip", amount: 5_000_000 });
    expect(ip.value).toBe(`2 лота · ${formatPultMoney(5_000_000)}`);
    expect(ip.detail).toContain("11:30");
    const kt = pulse.items.find((i) => i.key === "tender-today-kt")!;
    expect(kt).toMatchObject({ severity: "yellow", href: "#radar-kt" });
    expect(kt.value).toContain("1 лот");
  });

  it("часы считаются от nowIso: истёкший лот не попадает, лот завтра — не «сегодня»", () => {
    const pulse = buildMorningPulse({
      asOfDate: AS_OF, nowIso: "2026-11-17T10:00:00.000Z", // 15:00 Алматы
      radar: radar([
        card("1", { endAt: "2026-11-17 14:00", hoursLeft: 5 }),
        card("2", { endAt: "2026-11-18 10:00", isToday: false, sum: 70_000_000 })
      ])
    });
    expect(keys(pulse.items)).toEqual(["tender-big-ip"]);
  });

  it("крупные лоты в окне 48 ч от порога — жёлтые, мелкие и сегодняшние не дублируются", () => {
    const pulse = buildMorningPulse({
      asOfDate: AS_OF, nowIso: NOW,
      radar: radar([
        card("1", { endAt: "2026-11-18 18:00", isToday: false, sum: PULSE_BIG_LOT_SUM }),
        card("2", { endAt: "2026-11-19 08:00", isToday: false, sum: 80_000_000 }),
        card("3", { endAt: "2026-11-18 12:00", isToday: false, sum: PULSE_BIG_LOT_SUM - 1 }),
        card("4", { endAt: "2026-11-20 12:00", isToday: false, sum: 90_000_000 }),
        card("5", { sum: 60_000_000 })
      ])
    });
    const big = pulse.items.find((i) => i.key === "tender-big-ip")!;
    expect(big).toMatchObject({ severity: "yellow", amount: PULSE_BIG_LOT_SUM + 80_000_000, href: "#radar-ip" });
    expect(big.value).toContain("2 лота");
    expect(pulse.items.find((i) => i.key === "tender-today-ip")!.amount).toBe(60_000_000);
  });

  it("радар не загрузился или его нет — пояснение в missing", () => {
    expect(buildMorningPulse({ asOfDate: AS_OF, nowIso: NOW, finance: finance(), radar: null }).missing).toEqual(["Радар: не загружен"]);
    const failed = { ...radar([card("1")]), error: "сбой" };
    const pulse = buildMorningPulse({ asOfDate: AS_OF, nowIso: NOW, radar: failed });
    expect(pulse.items).toEqual([]);
    expect(pulse.missing).toEqual(["Финансы: нет отчёта", "Радар: не загрузился"]);
    // Радар не передан вовсе (утренний режим без него) — не пропуск.
    expect(buildMorningPulse({ asOfDate: AS_OF, nowIso: NOW, finance: finance() }).missing).toEqual([]);
  });
});

describe("утренний пульс: маржа и CRM", () => {
  it("продажи ниже себестоимости — красные с суммой убытка, низкая маржа — жёлтая, ссылка на риски реестра", () => {
    const reg = register([
      regRow({ customer: "Минус", cost: 1500, sale: 1000, val: -500 }),
      regRow({ customer: "Тонко", cost: 950, sale: 1000, val: 50 }),
      regRow({ customer: "Норма" })
    ]);
    const pulse = buildMorningPulse({ asOfDate: AS_OF, nowIso: NOW, register: reg });
    expect(pulse.items.find((i) => i.key === "margin-below-cost")).toMatchObject({
      severity: "red", area: "margin", finance: true, href: "./reg.html#r-risks", amount: 500, value: `убыток ${formatPultMoney(500)}`
    });
    expect(pulse.items.find((i) => i.key === "margin-low")).toMatchObject({ severity: "yellow", finance: true, amount: 1000 });
  });

  it("реестр за прошлый месяц или с ошибкой — пунктов нет, в missing пояснение", () => {
    const old = register([regRow({ cost: 1500, val: -500 })], "2026-10", "2026-10-31");
    expect(buildMorningPulse({ asOfDate: AS_OF, nowIso: NOW, register: old })).toMatchObject({ items: [], missing: ["Финансы: нет отчёта", "Реестр: файла за ноябрь ещё нет"] });
    expect(buildMorningPulse({ asOfDate: AS_OF, nowIso: NOW, register: { error: "сбой" } })).toMatchObject({ items: [], missing: ["Финансы: нет отчёта", "Реестр: не загрузился"] });
  });

  it("ошибки CRM: сигналы договоров и расхождения итогов — один жёлтый пункт со ссылкой на «Срочно»", () => {
    const pulse = buildMorningPulse({
      asOfDate: AS_OF, nowIso: NOW, outcomeMismatchesCount: 2,
      contractSignals: [{ color: "red", text: "<b>Тест</b>: x" }, { color: "yellow", text: "<b>Тест</b>: y" }]
    });
    expect(pulse.items).toEqual([expect.objectContaining({ key: "crm-errors", severity: "yellow", area: "crm", href: "#signals", finance: false, value: "4 сделки" })]);
  });
});

describe("утренний пульс: порядок, лимит, extraItems", () => {
  const extra = (key: string, severity: PulseItem["severity"], amount: number): PulseItem =>
    ({ key, severity, area: "losses", title: key, value: formatPultMoney(amount), href: "./#competitors-ip", finance: false, amount });

  it("сначала цвет, потом деньги; не больше 6 пунктов, остаток — в more", () => {
    const pulse = buildMorningPulse({
      asOfDate: AS_OF, nowIso: NOW, finance: finance(), outcomeMismatchesCount: 1,
      extraItems: [extra("y-big", "yellow", 900_000_000), extra("r-small", "red", 1), extra("r-huge", "red", 800_000_000),
        extra("g", "green", 5), extra("y-small", "yellow", 10), extra("y-mid", "yellow", 1_000)]
    });
    expect(pulse.items).toHaveLength(PULSE_MAX_ITEMS);
    expect(keys(pulse.items)).toEqual(["r-huge", "debt-60", "cash-gap", "r-small", "y-big", "y-mid"]);
    expect(pulse.more).toBe(3);
  });

  it("extraItems без суммы встают в конец своего цвета", () => {
    const pulse = buildMorningPulse({ asOfDate: AS_OF, nowIso: NOW, extraItems: [{ ...extra("a", "yellow", 0), amount: undefined }, extra("b", "yellow", 5)] });
    expect(keys(pulse.items)).toEqual(["b", "a"]);
    expect(pulse.more).toBeUndefined();
  });
});

describe("пульс для главной и для менеджера", () => {
  it("pulseForPayload: берёт радар, сигналы договоров и ошибки CRM из payload; закрытого месяца пульса нет", () => {
    const { payload } = fixture();
    payload.radar = radar([card("1", { endAt: "2026-10-28 10:00" })]);
    payload.outcomeMismatches = [{ id: "d", title: "Тест", amount: 1, managerId: "s", managerName: "Тест", outcome: "lost:other" }];
    const pulse = pulseForPayload(payload, { finance: finance(), nowIso: "2026-10-28T04:00:00.000Z" })!;
    expect(keys(pulse.items)).toContain("tender-today-ip");
    expect(keys(pulse.items)).toContain("crm-errors");
    expect(keys(pulse.items)).toContain("cash-gap");
    expect(pulseForPayload({ ...payload, closedMonth: true }, { nowIso: NOW })).toBeNull();
  });

  it("buildManagerPulse: только тендеры его радара, без финансов; без радара — пусто", () => {
    const empty = buildManagerPulse(null, AS_OF, NOW);
    expect(empty.items).toEqual([]);
    const pulse = buildManagerPulse(radar([card("1", { endAt: "2026-11-17 11:00" })]), AS_OF, "2026-11-17 09:00 (UTC+5)");
    expect(pulse.items.map((i) => [i.area, i.finance, i.severity])).toEqual([["tender", false, "red"]]);
  });

  it("selectHotLots: свои лоты из «Подать» со сроком до 24 ч, ближайшие первыми", () => {
    const view = radar(
      [card("1", { endAt: "2026-11-18 08:00", isToday: false }), card("2", { managerId: "m2" }), card("3", { endAt: "2026-11-18 12:00", isToday: false })],
      [card("4", { endAt: "2026-11-17 12:00" })]
    );
    expect(selectHotLots(view, "m1", AS_OF, NOW).map((c) => c.id)).toEqual(["4", "1"]);
    expect(selectHotLots(null, "m1", AS_OF, NOW)).toEqual([]);
  });

  it("вид менеджера: в payload и HTML нет финансовых пунктов и сумм полного пульса", () => {
    const f = fixture();
    const fin = finance();
    const insights = buildFinanceInsights(fin, f.payload.asOfDate);
    f.payload.pulse = pulseForPayload(f.payload, { finance: fin, register: f.register, nowIso: "2026-10-28T04:00:00.000Z" });
    expect(f.payload.pulse!.items.some((i) => i.finance)).toBe(true);
    const variant = buildManagerVariant({
      pult: f.payload, reg: { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, register: f.register },
      planDeals: null, managerId: "s", aliases: f.aliases
    })!;
    expect(variant.pult.pulse).toEqual({ asOf: f.payload.asOfDate, items: [], missing: ["Радар: не загружен"] });
    const html = renderManagerVariant(variant).index;
    for (const leak of ["Кассовый разрыв", "Долги старше", "fin.html#", formatPultMoney(-insights.cashGap), formatPultMoney(insights.debt.over60.total)]) {
      expect(html, leak).not.toContain(leak);
    }
  });
});

describe("дайджест директору и горящие лоты в утреннем отчёте", () => {
  it("первая строка — маркер, пункты с цветом, пропуски и ссылка на пульт", () => {
    const pulse = buildMorningPulse({ asOfDate: "2026-11-21", nowIso: NOW, finance: finance(), radar: null });
    const text = buildDirectorDigest(pulse, "https://example-pult.test");
    const lines = text.split("\n");
    expect(lines[0]).toBe("#дайджест 2026-11-21 директор");
    expect(text).toContain("🔴 Кассовый разрыв");
    expect(text).toContain("Нет данных: Финансы: отчёт на 16.11; Радар: не загружен");
    expect(lines.at(-1)).toBe("🔗 Пульт: https://example-pult.test");
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it("пустой пульс — «Всё спокойно»", () => {
    const text = buildDirectorDigest({ asOf: AS_OF, items: [], missing: [] }, "https://example-pult.test");
    expect(text).toContain("✅ Всё спокойно");
    expect(text).not.toContain("Нет данных");
  });

  const base = {
    managerId: "m1", managerName: "Менеджер Тестовый", date: AS_OF, targets: { calls: 15, proposals: 3, contracts: 1 },
    tasks: [], pultUrl: "https://example-pult.test"
  };

  it("hotLots: строки «🔥 Срок подачи сегодня» и «завтра»; без параметра отчёт прежний", () => {
    const lots = selectHotLots(radar([card("1", { endAt: "2026-11-17 15:00", sum: 6_500_000 }), card("2", { endAt: "2026-11-18 08:00", isToday: false })]), "m1", AS_OF, NOW);
    const text = buildMorningReport({ ...base, hotLots: lots });
    expect(text).toContain("🔥 Срок подачи сегодня: [L-1] Панель выдуманная — 6 500 000 ₸, до 15:00");
    expect(text).toContain("🔥 Срок подачи завтра: [L-2] Панель выдуманная — 1 000 000 ₸, до 18.11 08:00");
    expect(buildMorningReport({ ...base, hotLots: [] })).toBe(buildMorningReport(base));
    expect(buildMorningReport(base)).not.toContain("🔥 Срок подачи");
  });
});
