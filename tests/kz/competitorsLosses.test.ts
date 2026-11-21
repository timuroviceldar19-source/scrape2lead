import { describe, expect, it } from "vitest";
import {
  LOSS_REASON_LABELS,
  buildLossBreakdown,
  classifyRejectionReason,
  summarizeRecentCheaperRejections,
  type LossBreakdownSource
} from "../../src/kz/competitors/losses.js";
import type { HeadToHeadLotItem, LossBreakdown, OurRejectionItem } from "../../src/kz/competitors/types.js";
import {
  DEMO_F3_BIN,
  DEMO_F3_NAME,
  DEMO_PARTNER_BIN,
  DEMO_PARTNER_NAME,
  LOSSES_AS_OF,
  buildLossesSampleView
} from "../fixtures/kz/competitorsLosses.js";

// Все тексты причин, номера лотов и суммы в этом файле выдуманные.

function rejection(overrides: Partial<OurRejectionItem> & Pick<OurRejectionItem, "annoId" | "lotNumber">): OurRejectionItem {
  return {
    date: "2026-10-01",
    endDate: "2026-10-15",
    ourCompany: DEMO_F3_NAME,
    ourBin: DEMO_F3_BIN,
    customerName: "КГУ «Демо-школа»",
    kind: "Интерактивная панель",
    status: "Закупка состоялась",
    rejectionShort: "Иные основания",
    rejectionDetail: "",
    ourPrice: 1000000,
    ourUnitPrice: 1000000,
    winnerName: "ТОО «Соперник»",
    winnerBin: "900000000199",
    winnerPrice: 1200000,
    winnerUnitPrice: 1200000,
    cheaperThanWinner: true,
    cheaperByPct: 16.7,
    url: `https://procurement.gov.kz/ru/announce/index/${overrides.annoId}`,
    ...overrides
  };
}

function h2hLot(overrides: Partial<HeadToHeadLotItem> & Pick<HeadToHeadLotItem, "annoId" | "lotNumber">): HeadToHeadLotItem {
  return {
    date: "2026-10-01",
    customerName: "КГУ «Демо-школа»",
    kind: "Интерактивная панель",
    status: "Закупка состоялась",
    ourCompany: DEMO_F3_NAME,
    ourAdmitted: "Допущен",
    ourPrice: 1000000,
    ourCondDisc: 0,
    winnerBin: "900000000199",
    winnerName: "ТОО «Соперник»",
    winnerPrice: 900000,
    winnerCondDisc: 0,
    rivalAdmitted: "Допущен",
    rivalPrice: 900000,
    rivalCondDisc: 0,
    rivalWon: true,
    weWon: false,
    reason: "price",
    url: `https://procurement.gov.kz/ru/announce/index/${overrides.annoId}`,
    ...overrides
  };
}

function rival(bin: string, lots: HeadToHeadLotItem[]): LossBreakdownSource["headToHead"][number] {
  return {
    bin,
    name: `ТОО «Соперник ${bin.slice(-3)}»`,
    sharedLots: lots.length,
    rivalWonOverUs: 0,
    weWonOverRival: 0,
    bothLost: 0,
    lostByPrice: 0,
    lostByCondDiscount: 0,
    lostByOurRejected: 0,
    wonByPrice: 0,
    wonByCondDiscount: 0,
    wonByRivalRejected: 0,
    lots
  };
}

function expectTotalsMatchDetail(losses: LossBreakdown): void {
  const r = losses.rejected;
  expect(r.byReason.reduce((s, x) => s + x.count, 0)).toBe(r.count);
  expect(r.byReason.reduce((s, x) => s + x.sumOur, 0)).toBe(r.sumOur);
  expect(r.byReason.reduce((s, x) => s + x.cheaperCount, 0)).toBe(r.cheaperCount);
}

describe("classifyRejectionReason", () => {
  const cases: Array<[string, string, string, string]> = [
    // [описание, short, detail, ожидаемая категория]
    ["лицензия на ПО", "Не предоставлена лицензия на программное обеспечение", "", "software_docs"],
    ["реестр доверенного ПО", "Несоответствие КД", "ПО отсутствует в реестре доверенного программного обеспечения", "software_docs"],
    ["сертификат на ПО", "Не приложен сертификат соответствия на ПО", "", "software_docs"],
    ["письмо правообладателя ПО", "Нет письма от правообладателя программного обеспечения", "", "software_docs"],
    ["авторизационное письмо", "Отсутствует авторизационное письмо", "", "manufacturer_letter"],
    ["письмо производителя", "Несоответствие КД", "Не приложено письмо от производителя товара", "manufacturer_letter"],
    ["письмо правообладателя (не ПО)", "Несоответствие КД", "Нет письма правообладателя", "manufacturer_letter"],
    ["дилерство", "Не подтверждён статус официального дилера", "", "manufacturer_letter"],
    ["несоответствие ТС", "Не соответствует технической спецификации", "Диагональ меньше требуемой", "tech_mismatch"],
    ["характеристики", "Предложенные характеристики товара не соответствуют требованиям", "", "tech_mismatch"],
    ["аббревиатура ТС", "Несоответствие ТС", "", "tech_mismatch"],
    ["ТС с упоминанием ПО в характеристиках", "Не соответствует технической спецификации", "нет встроенного ПО для рисования", "tech_mismatch"],
    ["обеспечение заявки", "Не внесено обеспечение заявки", "", "security"],
    ["обеспечение конкурсной заявки", "Несоответствие КД", "Обеспечение конкурсной заявки не внесено", "security"],
    ["банковская гарантия", "Банковская гарантия оформлена неверно", "", "security"],
    ["ЭЦП", "Заявка не подписана ЭЦП", "", "documents"],
    ["просроченная справка", "Справка об отсутствии налоговой задолженности просрочена", "", "documents"],
    ["не предоставил документы", "Не предоставил копию свидетельства о регистрации", "", "documents"],
    ["сертификат происхождения", "Не приложен сертификат о происхождении товара", "", "documents"],
    ["пустая причина", "Отклонён", "", "other"],
    ["общая формулировка", "Иные основания", "", "other"],
    ["«конкурсная документация» — не конкретный документ", "Заявка не соответствует требованиям конкурсной документации", "", "other"],
    ["«по» как предлог не считается ПО", "Отклонена по решению комиссии", "", "other"],
    // Казахские формулировки
    ["каз.: обеспечение заявки", "Өтінімді қамтамасыз ету енгізілмеген", "", "security"],
    ["каз.: лицензия на ПО (не путать с обеспечением)", "Бағдарламалық қамтамасыз етуге лицензия ұсынылмаған", "", "software_docs"],
    ["каз.: техническая спецификация", "Техникалық ерекшелікке сәйкес келмейді", "", "tech_mismatch"],
    ["каз.: письмо производителя", "Өндірушінің хаты жоқ", "", "manufacturer_letter"],
    ["каз.: неизвестная формулировка", "Комиссия шешімімен қабылданбады", "", "other"]
  ];

  for (const [name, short, detail, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyRejectionReason(short, detail)).toBe(expected);
    });
  }

  it("подписи категорий заданы в одном месте и все на русском", () => {
    expect(Object.keys(LOSS_REASON_LABELS).sort()).toEqual(
      ["documents", "manufacturer_letter", "other", "security", "software_docs", "tech_mismatch"]
    );
    for (const label of Object.values(LOSS_REASON_LABELS)) expect(label).toMatch(/[А-Яа-я]/);
  });
});

describe("buildLossBreakdown", () => {
  it("один лот считается один раз, даже если отклонили и F3, и партнёра; итоги сходятся с детализацией", () => {
    const source: LossBreakdownSource = {
      ourRejections: [
        rejection({ annoId: "1", lotNumber: "A-1", rejectionShort: "Заявка не подписана ЭЦП", ourBin: DEMO_PARTNER_BIN, ourCompany: DEMO_PARTNER_NAME, ourPrice: 1100000 }),
        rejection({ annoId: "1", lotNumber: "A-1", rejectionShort: "Не предоставлена лицензия на программное обеспечение", ourPrice: 1050000 }),
        rejection({ annoId: "2", lotNumber: "A-2", rejectionShort: "Отсутствует авторизационное письмо", ourPrice: 2000000, winnerPrice: 1900000, cheaperThanWinner: false, cheaperByPct: null })
      ],
      headToHead: []
    };
    const losses = buildLossBreakdown(source, { allOurBins: new Set([DEMO_F3_BIN, DEMO_PARTNER_BIN]) });

    expect(losses.rejected.count).toBe(2);
    // Представитель лота A-1 — самая дешёвая наша заявка (F3, 1 050 000, причина «ПО»)
    expect(losses.rejected.sumOur).toBe(1050000 + 2000000);
    expect(losses.rejected.cheaperCount).toBe(1);
    expect(losses.rejected.cheaperSumOur).toBe(1050000);
    expect(losses.rejected.byReason.map((r) => r.key)).toEqual(["manufacturer_letter", "software_docs"]);
    expect(losses.rejected.byReason.find((r) => r.key === "documents")).toBeUndefined();
    const software = losses.rejected.byReason.find((r) => r.key === "software_docs")!;
    expect(software.label).toBe(LOSS_REASON_LABELS.software_docs);
    expect(software.lots).toHaveLength(1);
    expect(software.lots[0]).toMatchObject({ lotNumber: "A-1", ourCompany: DEMO_F3_NAME, ourPrice: 1050000, cheaper: true });
    expectTotalsMatchDetail(losses);
  });

  it("лот, который всё равно выиграла компания группы, не считается потерей", () => {
    const losses = buildLossBreakdown(
      { ourRejections: [rejection({ annoId: "3", lotNumber: "A-3", winnerBin: DEMO_PARTNER_BIN, winnerName: DEMO_PARTNER_NAME })], headToHead: [] },
      { allOurBins: new Set([DEMO_F3_BIN, DEMO_PARTNER_BIN]) }
    );
    expect(losses.rejected.count).toBe(0);
    expect(losses.rejected.byReason).toEqual([]);
  });

  it("проигрыш по цене и по условной скидке: лот повторяется у разных соперников, но считается один раз", () => {
    const priceLot = h2hLot({ annoId: "10", lotNumber: "P-10", ourPrice: 2500000, winnerPrice: 2000000, reason: "price" });
    const condLot = h2hLot({ annoId: "11", lotNumber: "C-11", ourPrice: 1750000, winnerPrice: 1800000, reason: "cond_discount" });
    const rejectedLot = h2hLot({ annoId: "12", lotNumber: "R-12", ourAdmitted: "Отклонен", reason: "our_rejected" });
    const wonLot = h2hLot({ annoId: "13", lotNumber: "W-13", rivalWon: false, weWon: true, reason: "price" });
    const source: LossBreakdownSource = {
      ourRejections: [],
      headToHead: [
        rival("900000000301", [priceLot, condLot, rejectedLot, wonLot]),
        // тот же лот у второго соперника (повтор)
        rival("900000000302", [{ ...priceLot }, { ...condLot }])
      ]
    };
    const losses = buildLossBreakdown(source);
    expect(losses.lostHeadToHead.byPrice).toEqual({ count: 1, sumOur: 2500000, sumGap: 500000 });
    expect(losses.lostHeadToHead.byCondDiscount).toEqual({ count: 1, sumOur: 1750000, sumGap: -50000 });
  });

  it("на причину не больше 10 ссылок на лоты, без длинных текстов причин", () => {
    const longDetail = "Длинное пояснение комиссии ".repeat(40);
    const ourRejections = Array.from({ length: 15 }, (_, i) =>
      rejection({
        annoId: String(100 + i),
        lotNumber: `M-${100 + i}`,
        rejectionShort: "Не предоставлена лицензия на программное обеспечение",
        rejectionDetail: longDetail,
        ourPrice: 1000000 + i * 1000,
        cheaperThanWinner: i % 2 === 0
      })
    );
    const losses = buildLossBreakdown({ ourRejections, headToHead: [] });
    const row = losses.rejected.byReason[0];
    expect(row.count).toBe(15);
    expect(row.lots).toHaveLength(10);
    // сначала заявки дешевле победителя, затем по сумме
    expect(row.lots.slice(0, 8).every((l) => l.cheaper)).toBe(true);
    expect(row.lots[0].ourPrice).toBe(1014000);
    const json = JSON.stringify(losses);
    expect(json).not.toContain("Длинное пояснение");
    expect(json).not.toContain("лицензия");
  });

  it("свежие отклонения дешевле победителя — за 7 дней до asOf включительно", () => {
    const ourRejections = [
      rejection({ annoId: "20", lotNumber: "N-20", endDate: "2026-11-21", ourPrice: 500000 }),
      rejection({ annoId: "21", lotNumber: "N-21", endDate: "2026-11-15", ourPrice: 400000 }),
      rejection({ annoId: "22", lotNumber: "N-22", endDate: "2026-11-14", ourPrice: 300000 }),
      rejection({ annoId: "23", lotNumber: "N-23", endDate: "2026-11-18", ourPrice: 200000, cheaperThanWinner: false, cheaperByPct: null }),
      rejection({ annoId: "24", lotNumber: "N-24", endDate: "2026-11-22", ourPrice: 100000 })
    ];
    const losses = buildLossBreakdown({ ourRejections, headToHead: [] }, { asOfDate: "2026-11-21" });
    expect(losses.recentCheaper.days).toBe(7);
    expect(losses.recentCheaper.count).toBe(2);
    expect(losses.recentCheaper.sumOur).toBe(900000);
    expect(losses.recentCheaper.lots.map((l) => l.lotNumber)).toEqual(["N-20", "N-21"]);

    const noAsOf = buildLossBreakdown({ ourRejections, headToHead: [] });
    expect(noAsOf.recentCheaper.count).toBe(0);
  });
});

describe("losses в срезе «Конкурентов» (aggregate)", () => {
  const view = buildLossesSampleView();

  it("общий срез ИП: отклонения по причинам, проигрыши по цене и условной скидке, свежие", () => {
    const losses = view.ip!.losses;
    expect(losses.rejected).toMatchObject({ count: 4, sumOur: 7400000, cheaperCount: 3, cheaperSumOur: 4400000 });
    expect(losses.rejected.byReason.map((r) => [r.key, r.count, r.sumOur])).toEqual([
      ["security", 1, 3000000],
      ["software_docs", 1, 2100000],
      ["manufacturer_letter", 1, 1400000],
      ["tech_mismatch", 1, 900000]
    ]);
    expectTotalsMatchDetail(losses);
    // LS-1 отклонили у двух компаний группы, в ourRejections две строки, а в потерях — одна
    expect(view.ip!.ourRejections.filter((r) => r.lotNumber === "LS-1")).toHaveLength(2);
    expect(losses.rejected.byReason.flatMap((r) => r.lots).filter((l) => l.lotNumber === "LS-1")).toHaveLength(1);
    // LS-5 выиграл партнёр — не потеря
    expect(losses.rejected.byReason.flatMap((r) => r.lots).some((l) => l.lotNumber === "LS-5")).toBe(false);

    expect(losses.lostHeadToHead.byPrice).toEqual({ count: 1, sumOur: 2500000, sumGap: 500000 });
    expect(losses.lostHeadToHead.byCondDiscount).toEqual({ count: 1, sumOur: 1750000, sumGap: -50000 });

    expect(losses.recentCheaper).toMatchObject({ days: 7, count: 1, sumOur: 1400000 });
    expect(losses.recentCheaper.lots.map((l) => l.lotNumber)).toEqual(["LS-2"]);

    const kt = view.kt!.losses;
    expect(kt.rejected.byReason.map((r) => r.key)).toEqual(["security"]);
    expect(kt.recentCheaper.count).toBe(1);
  });

  it("помесячные срезы считают свои потери, а сумма месяцев равна общему итогу", () => {
    const ip = view.ip!;
    const oct = ip.monthViews["2026-10"].losses;
    const nov = ip.monthViews["2026-11"].losses;
    expect(oct.rejected.byReason.map((r) => r.key).sort()).toEqual(["security", "software_docs"]);
    expect(nov.rejected.byReason.map((r) => r.key).sort()).toEqual(["manufacturer_letter", "tech_mismatch"]);
    expect(oct.lostHeadToHead.byCondDiscount.count).toBe(1);
    expect(oct.lostHeadToHead.byPrice.count).toBe(0);
    expect(nov.lostHeadToHead.byPrice.count).toBe(1);
    expect(oct.rejected.count + nov.rejected.count).toBe(ip.losses.rejected.count);
    expect(oct.rejected.sumOur + nov.rejected.sumOur).toBe(ip.losses.rejected.sumOur);
    expect(ip.monthViews.all.losses).toEqual(ip.losses);
    expectTotalsMatchDetail(oct);
    expectTotalsMatchDetail(nov);
  });

  it("в строках отклонений есть дата окончания приёма заявок (по ней считается свежесть)", () => {
    const ls2 = view.ip!.ourRejections.find((r) => r.lotNumber === "LS-2")!;
    expect(ls2.endDate).toBe("2026-11-17");
  });
});

describe("summarizeRecentCheaperRejections", () => {
  const view = buildLossesSampleView();

  it("ИП и КТ за 7 дней до asOf включительно, без лотов, выигранных группой", () => {
    const res = summarizeRecentCheaperRejections(view, LOSSES_AS_OF);
    expect(res.count).toBe(2);
    expect(res.sumOur).toBe(550000 + 1400000);
    expect(res.items.map((i) => [i.group, i.lotNumber, i.date])).toEqual([
      ["КТ", "LK-1", "2026-11-21"],
      ["ИП", "LS-2", "2026-11-17"]
    ]);
    expect(res.items[0]).toMatchObject({ kind: "Ноутбук", ourPrice: 550000, winnerPrice: 600000 });
    expect(res.items[0].url).toMatch(/^https:\/\/procurement\.gov\.kz\//);
  });

  it("граница окна: 14.11 входит при asOf 20.11 и не входит при asOf 21.11; будущие даты не входят", () => {
    const at20 = summarizeRecentCheaperRejections(view, "2026-11-20");
    expect(at20.items.map((i) => i.lotNumber)).toEqual(["LS-2", "LS-3"]);
    const at21 = summarizeRecentCheaperRejections(view, "2026-11-21");
    expect(at21.items.map((i) => i.lotNumber)).not.toContain("LS-3");
    const wide = summarizeRecentCheaperRejections(view, "2026-11-21", 60);
    // LS-1 (дешевле, F3 и партнёр) — один раз; LS-5 выиграл партнёр — не входит
    expect(wide.items.filter((i) => i.lotNumber === "LS-1")).toHaveLength(1);
    expect(wide.items.some((i) => i.lotNumber === "LS-5")).toBe(false);
  });

  it("пустой вид без групп даёт нули", () => {
    expect(summarizeRecentCheaperRejections({ asOf: LOSSES_AS_OF, months: [], ip: null, kt: null }, LOSSES_AS_OF))
      .toEqual({ count: 0, sumOur: 0, items: [] });
  });
});
