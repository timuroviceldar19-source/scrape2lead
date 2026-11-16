import { describe, expect, it } from "vitest";
import { loadCompetitorsConfig } from "../../src/kz/competitors/config.js";
import { buildCompetitorsView } from "../../src/kz/competitors/aggregate.js";
import type { CompetitorBid, CompetitorLot, LotTemplateMatch } from "../../src/kz/competitors/types.js";

// Все данные в этом файле выдуманные. БИН наших компаний берутся из config/*.json.

function makeLot(overrides: Partial<CompetitorLot>): CompetitorLot {
  return {
    annoId: "100",
    annoNumber: "100-1",
    annoName: "Панель",
    lotNumber: "L-1",
    lotName: "Панель интерактивная",
    enstruCode: "262030.100.000021",
    group: "ИП",
    kind: "Интерактивная панель",
    diagonal: '75"',
    cpu: "",
    isCombinedLot: false,
    isKit: false,
    isLatestVersion: true,
    status: "Закупка состоялась",
    startDate: "2026-05-10",
    endDate: "2026-05-20",
    customerBin: "888888888888",
    customerName: 'КГУ "Тестовая школа"',
    qty: 2,
    plannedUnitPriceNoVat: 1200000,
    plannedSumNoVat: 2400000,
    numSubmitted: 2,
    numAdmitted: 2,
    winnerBin: "333333333333",
    winnerName: "ТОО «Соперник А»",
    winnerIsOurs: "",
    winnerBidUnitPriceNoVat: 1100000,
    winnerBidTotalPriceNoVat: 2200000,
    winnerDiscountFromPlanPct: 8.33,
    winnerCondDiscountPct: 4,
    secondBin: "",
    secondName: "",
    failureReason: "",
    lotUrl: "https://procurement.gov.kz/ru/announce/index/100",
    annoUrl: "https://procurement.gov.kz/ru/announce/index/100",
    protocolUrl: "",
    techspecUrl: "https://v3bl.goszakup.gov.kz/files/download_file/1/2/",
    hasTechspec: true,
    hasItogi: true,
    ...overrides
  };
}

function makeBid(overrides: Partial<CompetitorBid>): CompetitorBid {
  return {
    annoId: "100",
    lotNumber: "L-1",
    isLatestLotVersion: true,
    group: "ИП",
    kind: "Интерактивная панель",
    diagonal: '75"',
    cpu: "",
    isCombinedLot: false,
    isKit: false,
    startDate: "2026-05-10",
    lotStatus: "Закупка состоялась",
    plannedQty: 2,
    plannedUnitPriceNoVat: 1200000,
    plannedSumNoVat: 2400000,
    bidderBin: "333333333333",
    bidderName: "ТОО «Соперник А»",
    ourCompany: "",
    admittedStatus: "Допущен",
    rejectionShort: "",
    rejectionDetail: "",
    bidUnitPriceNoVat: 1100000,
    bidTotalPriceNoVat: 2200000,
    discountFromPlanPct: 8.33,
    condDiscountPct: 4,
    otpKtpPct: 0,
    condPriceNoVat: 2112000,
    isWinner: false,
    isSecondPlace: false,
    ...overrides
  };
}

describe("competitors aggregator", () => {
  it("computes all 6 blocks, excludes typo prices, tracks head-to-head causes and cheaper rejections", () => {
    const cfg = loadCompetitorsConfig({ templatesConfigPath: "tests/fixtures/kz/spec-templates.demo.json" });
    const ourBin = [...cfg.ourBins][0];
    const partnerBin = [...cfg.partnerBins][0];
    const ourName = cfg.ourCompanyNames[ourBin] || "F3";
    const partnerName = cfg.ourCompanyNames[partnerBin] || "Amanat Asia";

    const lots: CompetitorLot[] = [
      // Lot 1 (May): Rival wins over F3 via conditional discount (F3 raw price was cheaper!)
      makeLot({
        annoId: "101",
        lotNumber: "L-101",
        startDate: "2026-05-10",
        winnerBin: "333333333333",
        winnerName: "ТОО «Соперник А»",
        winnerBidUnitPriceNoVat: 1100000,
        winnerBidTotalPriceNoVat: 2200000,
        winnerCondDiscountPct: 4,
        secondBin: ourBin,
        secondName: ourName
      }),
      // Lot 2 (May): Partner rejected, even though partner's price was lower than winner
      makeLot({
        annoId: "102",
        lotNumber: "L-102",
        startDate: "2026-05-15",
        winnerBin: "444444444444",
        winnerName: "ТОО «Соперник Б»",
        winnerBidUnitPriceNoVat: 1150000,
        winnerBidTotalPriceNoVat: 2300000
      }),
      // Lot 3 (June): F3 wins, includes typo bid of 110 KZT by rejected rival & kit lot
      makeLot({
        annoId: "103",
        lotNumber: "L-103",
        startDate: "2026-06-05",
        winnerBin: ourBin,
        winnerName: ourName,
        winnerIsOurs: ourName,
        winnerBidUnitPriceNoVat: 1000000,
        winnerBidTotalPriceNoVat: 2000000
      }),
      // Lot 4 (June): Kit lot (must be separated in prices)
      makeLot({
        annoId: "104",
        lotNumber: "L-104",
        startDate: "2026-06-08",
        kind: "Учебный комплект",
        diagonal: "",
        isKit: true,
        qty: 1,
        plannedUnitPriceNoVat: 5000000,
        plannedSumNoVat: 5000000,
        winnerBin: "333333333333",
        winnerName: "ТОО «Соперник А»",
        winnerBidUnitPriceNoVat: 4500000,
        winnerBidTotalPriceNoVat: 4500000
      }),
      // Lot 5 (June): KT MFP with typo bid 110 KZT
      makeLot({
        annoId: "105",
        lotNumber: "L-105",
        group: "КТ",
        kind: "МФУ",
        diagonal: "",
        startDate: "2026-06-12",
        qty: 10,
        plannedUnitPriceNoVat: 234627,
        plannedSumNoVat: 2346270,
        winnerBin: "555555555555",
        winnerName: "ТОО «Принт Тест»",
        winnerBidUnitPriceNoVat: 200000,
        winnerBidTotalPriceNoVat: 2000000
      })
    ];

    const bids: CompetitorBid[] = [
      // L-101: Rival A 2.2M (4% disc) beats F3 2.15M (1% disc) via conditional discount
      makeBid({
        annoId: "101",
        lotNumber: "L-101",
        startDate: "2026-05-10",
        bidderBin: "333333333333",
        bidderName: "ТОО «Соперник А»",
        bidUnitPriceNoVat: 1100000,
        bidTotalPriceNoVat: 2200000,
        condDiscountPct: 4,
        otpKtpPct: 2,
        isWinner: true
      }),
      makeBid({
        annoId: "101",
        lotNumber: "L-101",
        startDate: "2026-05-10",
        bidderBin: ourBin,
        bidderName: ourName,
        ourCompany: ourName,
        bidUnitPriceNoVat: 1075000,
        bidTotalPriceNoVat: 2150000,
        condDiscountPct: 1,
        otpKtpPct: 0,
        isSecondPlace: true
      }),
      // L-102: Partner rejected with cheaper price (2.1M < 2.3M)
      makeBid({
        annoId: "102",
        lotNumber: "L-102",
        startDate: "2026-05-15",
        bidderBin: partnerBin,
        bidderName: partnerName,
        ourCompany: partnerName,
        admittedStatus: "Отклонен",
        rejectionShort: "Несоответствие КД",
        rejectionDetail: "Нет письма правообладателя",
        bidUnitPriceNoVat: 1050000,
        bidTotalPriceNoVat: 2100000
      }),
      makeBid({
        annoId: "102",
        lotNumber: "L-102",
        startDate: "2026-05-15",
        bidderBin: "444444444444",
        bidderName: "ТОО «Соперник Б»",
        bidUnitPriceNoVat: 1150000,
        bidTotalPriceNoVat: 2300000,
        isWinner: true
      }),
      // L-103: F3 wins against Rival A
      makeBid({
        annoId: "103",
        lotNumber: "L-103",
        startDate: "2026-06-05",
        bidderBin: ourBin,
        bidderName: ourName,
        ourCompany: ourName,
        bidUnitPriceNoVat: 1000000,
        bidTotalPriceNoVat: 2000000,
        discountFromPlanPct: 16.67,
        condDiscountPct: 3,
        otpKtpPct: 2,
        isWinner: true
      }),
      makeBid({
        annoId: "103",
        lotNumber: "L-103",
        startDate: "2026-06-05",
        bidderBin: "333333333333",
        bidderName: "ТОО «Соперник А»",
        bidUnitPriceNoVat: 1050000,
        bidTotalPriceNoVat: 2100000,
        isSecondPlace: true
      }),
      // L-104: Kit
      makeBid({
        annoId: "104",
        lotNumber: "L-104",
        startDate: "2026-06-08",
        kind: "Учебный комплект",
        diagonal: "",
        isKit: true,
        plannedQty: 1,
        plannedUnitPriceNoVat: 5000000,
        plannedSumNoVat: 5000000,
        bidderBin: "333333333333",
        bidderName: "ТОО «Соперник А»",
        bidUnitPriceNoVat: 4500000,
        bidTotalPriceNoVat: 4500000,
        isWinner: true
      }),
      // L-105: KT МФУ with typo 110 KZT
      makeBid({
        annoId: "105",
        lotNumber: "L-105",
        group: "КТ",
        kind: "МФУ",
        diagonal: "",
        startDate: "2026-06-12",
        plannedQty: 10,
        plannedUnitPriceNoVat: 234627,
        plannedSumNoVat: 2346270,
        bidderBin: "555555555555",
        bidderName: "ТОО «Принт Тест»",
        bidUnitPriceNoVat: 200000,
        bidTotalPriceNoVat: 2000000,
        isWinner: true
      }),
      makeBid({
        annoId: "105",
        lotNumber: "L-105",
        group: "КТ",
        kind: "МФУ",
        diagonal: "",
        startDate: "2026-06-12",
        plannedQty: 10,
        plannedUnitPriceNoVat: 234627,
        plannedSumNoVat: 2346270,
        bidderBin: "666666666666",
        bidderName: "ТОО «Опечатка»",
        admittedStatus: "Отклонен",
        bidUnitPriceNoVat: 110,
        bidTotalPriceNoVat: 1100,
        discountFromPlanPct: 99.95
      })
    ];

    const matches: LotTemplateMatch[] = [
      {
        annoId: "102",
        lotNumber: "L-102",
        templateId: "demo",
        templateName: "Шаблон «Демо»",
        note: "выдуманная пометка",
        share: 0.72,
        strength: "strong",
        matchedPhrases: ["полив по лунному календарю"],
        coreMatchesCount: 2
      }
    ];

    const view = buildCompetitorsView({
      lots,
      bids,
      templateMatches: matches,
      asOfDate: "2026-06-15",
      updatedAt: "2026-06-10",
      cfg
    });

    // 2026-06-10 is older than previous workday of 2026-06-15 (Friday 2026-06-12) -> stale = true
    expect(view.stale).toBe(true);
    expect(view.months).toEqual(["2026-05", "2026-06"]);

    const ipAll = view.ip!;
    expect(ipAll.summary.lotsTotal).toBe(4);
    expect(ipAll.summary.wonLots).toBe(4);
    expect(ipAll.summary.ourWinsCount).toBe(1);
    expect(ipAll.summary.ourWinsSum).toBe(2000000);

    // Competitor A: 3 bids, 1 win (L-101) + 1 win (L-104) = 6.7M, otpKtpCount = 1
    const rivalA = ipAll.competitors.find((c) => c.bin === "333333333333")!;
    expect(rivalA.wins).toBe(2);
    expect(rivalA.wonSum).toBe(6700000);
    expect(rivalA.otpKtpCount).toBe(1);

    // Head-to-head: Rival A faced us twice (L-101 won by cond_discount, L-103 we won)
    const h2hA = ipAll.headToHead.find((r) => r.bin === "333333333333")!;
    expect(h2hA.sharedLots).toBe(2);
    expect(h2hA.rivalWonOverUs).toBe(1);
    expect(h2hA.lostByCondDiscount).toBe(1);
    expect(h2hA.weWonOverRival).toBe(1);

    // Rival B faced us on L-102 where our partner was rejected
    const h2hB = ipAll.headToHead.find((r) => r.bin === "444444444444")!;
    expect(h2hB.lostByOurRejected).toBe(1);

    // Our rejections: L-102 flagged cheaperThanWinner!
    expect(ipAll.ourRejections).toHaveLength(1);
    expect(ipAll.ourRejections[0].cheaperThanWinner).toBe(true);
    expect(ipAll.ourRejectionsCheaperCount).toBe(1);

    // Prices ИП: 75" excludes kit L-104; kitsRow has 4_500_000
    const row75 = ipAll.prices.rows.find((r) => r.label === 'Панель 75"')!;
    expect(row75.lotsCount).toBe(3);
    expect(row75.compWinner.med).toBe(1125000);
    expect(ipAll.prices.kitsRow?.compWinner.med).toBe(4500000);

    // Spec templates: L-102 matched the demo template
    expect(ipAll.specTemplates[0].totalLots).toBe(1);
    expect(ipAll.specTemplates[0].winners[0].bin).toBe("444444444444");

    // Monthly slice filtering
    expect(ipAll.monthViews["2026-05"].summary.lotsTotal).toBe(2);
    expect(ipAll.monthViews["2026-06"].summary.lotsTotal).toBe(2);

    // КТ: typo 110 KZT excluded from prices & median discount
    const ktAll = view.kt!;
    expect(ktAll.prices.rows[0].compAdmitted.med).toBe(200000);
    const typoRow = ktAll.competitors.find((c) => c.bin === "666666666666")!;
    expect(typoRow.medianDiscountPct).toBeNull();
  });
});
