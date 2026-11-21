import { describe, expect, it } from "vitest";
import { withBids, parseBidSources, formatBidSummary, BID_VALUE_WEIGHTS } from "../../src/bitrix/salesPult/bid/assess.js";
import type { BidAssessment } from "../../src/bitrix/salesPult/bid/types.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { renderPultHtml } from "../../src/bitrix/salesPult/site.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";
import { BID_SECRET_DETAIL, bidPayload } from "../fixtures/sales-pult/bid.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";

// Пункт 5 RFC: вердикт «идём / осторожно / не идём» считается на сервере из тех же данных, что уходят в страницу.
// Все данные выдуманные (tests/fixtures/sales-pult/bid.ts).

function bids(payload: SalesPultPayload): Record<string, BidAssessment> {
  const out: Record<string, BidAssessment> = {};
  for (const c of payload.radar!.ip.submitToday) out[c.id] = c.bid!;
  return out;
}

const texts = (b: BidAssessment) => b.reasons.map((r) => r.text);

describe("вердикт по лоту", () => {
  const { payload } = bidPayload();
  const b = bids(withBids(payload));

  it("ТС лота сильно совпадает с шаблоном конкурента — «не идём»", () => {
    expect(b["9101"].verdict).toBe("nogo");
    expect(texts(b["9101"]).join(" ")).toContain("Шаблон ТС: Шаблон-тест Соперника · побеждал ТОО Соперник-тест (70%) · сильное совпадение");
  });

  it("конкурент забирал заказчика по протоколу и по CRM — «осторожно», проигрыш считается один раз на сделку", () => {
    expect(b["9102"].verdict).toBe("caution");
    expect(texts(b["9102"])).toContain("забирал ТОО Соперник-тест · 2× · −12%");
    expect(b["9102"].price).toEqual({ unit: 110000, winMedian: 100000, status: "" });
  });

  it("покупал у нас и цена с запасом к победам — «идём»", () => {
    expect(b["9103"].verdict).toBe("go");
    expect(texts(b["9103"])).toContain("покупал у нас");
    expect(b["9103"].price).toEqual({ unit: 120000, winMedian: 100000, status: "good" });
  });

  it("нет ни одного сигнала — вердикт не выносится", () => {
    expect(b["9104"]).toMatchObject({ verdict: "unknown", reasons: [] });
    expect(b["9104"].price).toBeUndefined();
  });

  it("шаблон ТС, где чаще побеждала наша компания, — плюс, а не риск", () => {
    expect(b["9105"].verdict).toBe("go");
    const template = b["9105"].reasons.find((r) => r.kind === "template")!;
    expect(template).toMatchObject({ tone: "good", title: "Ранее найден у этого заказчика" });
    expect(template.text).toContain("Шаблон-тест наш");
  });

  it("нас дважды отклоняли у заказчика — причина категорией, без текста протокола", () => {
    expect(b["9106"].verdict).toBe("caution");
    expect(texts(b["9106"])).toContain("нас отклоняли: Несоответствие ТС · 2×");
    // текст протокола есть только в самих «Конкурентах» полного пульта, в вердикты он не копируется
    const out = withBids(payload);
    const allBids = [...out.radar!.ip.submitToday.map((c) => c.bid), ...out.plans!.ip!.openPlans.map((d) => d.bid)];
    expect(JSON.stringify(allBids)).not.toContain(BID_SECRET_DETAIL);
  });

  it("ценность — сумма × вес вердикта", () => {
    expect(BID_VALUE_WEIGHTS).toEqual({ go: 1, unknown: 0.5, caution: 0.5, nogo: 0.1 });
    expect(b["9101"].value).toBe(20000);
    expect(b["9102"].value).toBe(110000);
    expect(b["9103"].value).toBe(240000);
    expect(b["9104"].value).toBe(100000);
  });

  it("открытые планы получают вердикт; пропущенные сроки — нет", () => {
    const out = withBids(payload);
    const plan = out.plans!.ip!.openPlans.find((d) => d.id === "9201")!;
    expect(plan.bid).toMatchObject({ verdict: "go", price: { unit: 120000, winMedian: 100000, status: "good" } });
    expect(out.radar!.ip.missed[0].bid).toBeUndefined();
  });

  it("входной payload не меняется", () => {
    const { payload: p } = bidPayload();
    withBids(p);
    expect(p.radar!.ip.submitToday.every((c) => c.bid === undefined)).toBe(true);
    expect(p.plans!.ip!.openPlans.every((d) => d.bid === undefined)).toBe(true);
  });
});

describe("лог сборки", () => {
  it("только числа: вердикты по группам и битые записи", () => {
    const { payload } = bidPayload();
    // радар: nogo, caution, go, unknown, go, caution; планы: 9201 go, 9202 caution
    expect(formatBidSummary(payload)).toBe("ИП: идём 3, осторожно 3, не идём 1, без вердикта 1; КТ: идём 0, осторожно 0, не идём 0, без вердикта 0");
    (payload.competitors as unknown as { ip: { specTemplates: unknown[] } }).ip.specTemplates.push(null);
    expect(formatBidSummary(payload)).toMatch(/; пропущено битых записей источников: 1$/);
  });
});

describe("zod на входе вердикта", () => {
  it("битые записи источников пропускаются и считаются, остальные сигналы работают", () => {
    const { payload } = bidPayload();
    const comp = payload.competitors as unknown as { ip: { competitors: Array<{ lotList: unknown[] }>; specTemplates: unknown[] } };
    comp.ip.competitors[0].lotList.push(null, "не лот");
    comp.ip.specTemplates.push(42);
    (payload.market as unknown as { ip: { kinds: unknown } }).ip.kinds = "сломано";
    const { dropped } = parseBidSources(payload);
    // два битых лота, битый шаблон и список видов «Рынка» не того типа
    expect(dropped).toBe(4);
    const b = bids(withBids(payload));
    expect(b["9101"].verdict).toBe("nogo");
    expect(texts(b["9102"])).toContain("забирал ТОО Соперник-тест · 2× · −12%");
    // цена побед для панелей осталась из «Конкурентов»
    expect(b["9103"].price?.winMedian).toBe(100000);
  });

  it("без «Конкурентов» по группе вердикт не выносится, метки и цена остаются", () => {
    const { payload } = bidPayload();
    payload.competitors = null;
    const b = bids(withBids(payload));
    expect(Object.values(b).map((x) => x.verdict)).toEqual(Array(6).fill("unknown"));
    expect(texts(b["9103"])).toContain("покупал у нас");
    // без «Конкурентов» ориентир — медиана всего вида «Рынка»: справка без цвета
    expect(b["9103"].price).toEqual({ unit: 120000, winMedian: 100000, status: "" });
  });
});

describe("ориентир цены побед", () => {
  it("выборка меньше 3 побед не используется — берётся медиана вида, без цвета", () => {
    const { payload } = bidPayload();
    const comp = payload.competitors as unknown as { ip: { prices: { rows: unknown[] } } };
    comp.ip.prices.rows = [{ label: 'Панель 75"', compWinner: { med: 50000, n: 1 }, ourWinner: { med: null, n: 0 } }];
    const b = bids(withBids(payload));
    expect(b["9103"].price).toEqual({ unit: 120000, winMedian: 100000, status: "" });
    expect(b["9103"].reasons.some((r) => r.kind === "price")).toBe(false);
  });

  it("панель без диагонали: цена — справка, «низкая цена» и вердикт по ней не ставятся", () => {
    const { payload } = bidPayload();
    const card = payload.radar!.ip.submitToday.find((c) => c.id === "9104")!;
    Object.assign(card, { kind: "Интерактивные панели", itemName: "Интерактивная панель", sum: 40000 });
    const b = bids(withBids(payload));
    expect(b["9104"]).toMatchObject({ verdict: "unknown", reasons: [], price: { unit: 20000, winMedian: 100000, status: "" } });
  });

  it("точная низкая цена — минус один балл: с одним проигрышем это «осторожно», не «не идём»", () => {
    const { payload } = bidPayload();
    const plan = withBids(payload).plans!.ip!.openPlans.find((d) => d.id === "9202")!;
    expect(plan.bid).toMatchObject({ verdict: "caution", price: { unit: 40000, winMedian: 100000, status: "bad" } });
  });
});

describe("изоляция ролей", () => {
  function embedded(html: string): SalesPultPayload {
    const m = html.match(/const PAYLOAD = (\{[\s\S]*?\});\n/);
    if (!m) throw new Error("PAYLOAD не найден");
    return JSON.parse(m[1]) as SalesPultPayload;
  }

  it("all: вердикты встроены в страницу", () => {
    const { payload } = bidPayload();
    const page = embedded(renderPultHtml(payload));
    expect(bids(page)["9101"].verdict).toBe("nogo");
    expect(page.plans!.ip!.openPlans[0].bid).toBeDefined();
  });

  it("manager: вердикт из его данных — без «Конкурентов», без чужих сделок и без вердикта", () => {
    const { payload, planDeals } = bidPayload();
    const reg = { asOfDate: payload.asOfDate, generatedAt: payload.generatedAt, register: fixture().register };
    const v = buildManagerVariant({ pult: payload, reg, planDeals, managerId: "s" })!;
    const html = renderManagerVariant(v).index;
    const page = embedded(html);
    expect(page.competitors).toBeNull();
    const b = bids(page);
    expect(Object.values(b).every((x) => x.verdict === "unknown")).toBe(true);
    expect(Object.values(b).flatMap((x) => x.reasons).some((r) => r.kind === "template" || r.kind === "rejections")).toBe(false);
    // свой проигрыш по CRM виден (его сделка), протокольный — нет
    expect(texts(b["9102"])).toContain("забирал ТОО Соперник-тест · 1× · −12%");
    expect(page.plans!.ip!.openPlans.map((d) => d.id)).toEqual(["9201"]);
    for (const secret of ["Шаблон-тест Соперника", "Шаблон-тест наш", "Несоответствие ТС", BID_SECRET_DETAIL]) {
      expect(html).not.toContain(secret);
    }
  });
});
