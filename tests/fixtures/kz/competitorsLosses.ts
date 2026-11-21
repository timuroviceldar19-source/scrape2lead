import { loadCompetitorsConfig } from "../../../src/kz/competitors/config.js";
import { buildCompetitorsView } from "../../../src/kz/competitors/aggregate.js";
import type {
  CompetitorBid,
  CompetitorLot,
  CompetitorsConfig,
  CompetitorsView
} from "../../../src/kz/competitors/types.js";

// Все названия, БИН, номера лотов, суммы и тексты причин в этом файле выдуманные.

export const DEMO_F3_BIN = "900000000001";
export const DEMO_PARTNER_BIN = "900000000002";
export const DEMO_F3_NAME = "ТОО «Демо Ф3»";
export const DEMO_PARTNER_NAME = "ТОО «Демо Партнёр»";
export const RIVAL_GAMMA = { bin: "900000000101", name: "ТОО «Соперник Гамма»" };
export const RIVAL_DELTA = { bin: "900000000102", name: "ТОО «Соперник Дельта»" };
export const RIVAL_EPSILON = { bin: "900000000103", name: "ТОО «Соперник Эпсилон»" };

export const LOSSES_AS_OF = "2026-11-21";

/** Конфиг с выдуманными БИН группы вместо настоящих из config/*.json. */
export function demoLossesConfig(): CompetitorsConfig {
  const base = loadCompetitorsConfig({ templatesConfigPath: "tests/fixtures/kz/spec-templates.demo.json" });
  return {
    ...base,
    ourBins: new Set([DEMO_F3_BIN]),
    partnerBins: new Set([DEMO_PARTNER_BIN]),
    allOurBins: new Set([DEMO_F3_BIN, DEMO_PARTNER_BIN]),
    ourCompanyNames: { [DEMO_F3_BIN]: DEMO_F3_NAME, [DEMO_PARTNER_BIN]: DEMO_PARTNER_NAME }
  };
}

export function lossLot(overrides: Partial<CompetitorLot> & Pick<CompetitorLot, "annoId" | "lotNumber">): CompetitorLot {
  const annoUrl = `https://procurement.gov.kz/ru/announce/index/${overrides.annoId}`;
  return {
    annoNumber: `${overrides.annoId}-1`,
    annoName: "Панель (демо)",
    lotName: "Панель интерактивная (демо)",
    enstruCode: "262030.100.000021",
    group: "ИП",
    kind: "Интерактивная панель",
    diagonal: '75"',
    cpu: "",
    isCombinedLot: false,
    isKit: false,
    isLatestVersion: true,
    status: "Закупка состоялась",
    startDate: "2026-10-05",
    endDate: "2026-10-20",
    customerBin: "800000000001",
    customerName: "КГУ «Демо-школа №1»",
    qty: 1,
    plannedUnitPriceNoVat: 3000000,
    plannedSumNoVat: 3000000,
    numSubmitted: 2,
    numAdmitted: 1,
    winnerBin: RIVAL_GAMMA.bin,
    winnerName: RIVAL_GAMMA.name,
    winnerIsOurs: "",
    winnerBidUnitPriceNoVat: null,
    winnerBidTotalPriceNoVat: null,
    winnerDiscountFromPlanPct: null,
    winnerCondDiscountPct: null,
    secondBin: "",
    secondName: "",
    failureReason: "",
    lotUrl: annoUrl,
    annoUrl,
    protocolUrl: "",
    techspecUrl: "",
    hasTechspec: false,
    hasItogi: true,
    ...overrides
  };
}

export function lossBid(
  lot: CompetitorLot,
  overrides: Partial<CompetitorBid> & Pick<CompetitorBid, "bidderBin" | "bidderName">
): CompetitorBid {
  return {
    annoId: lot.annoId,
    lotNumber: lot.lotNumber,
    isLatestLotVersion: true,
    group: lot.group,
    kind: lot.kind,
    diagonal: lot.diagonal,
    cpu: lot.cpu,
    isCombinedLot: false,
    isKit: false,
    startDate: lot.startDate,
    lotStatus: lot.status,
    plannedQty: lot.qty,
    plannedUnitPriceNoVat: lot.plannedUnitPriceNoVat,
    plannedSumNoVat: lot.plannedSumNoVat,
    ourCompany: "",
    admittedStatus: "Допущен",
    rejectionShort: "",
    rejectionDetail: "",
    bidUnitPriceNoVat: null,
    bidTotalPriceNoVat: null,
    discountFromPlanPct: null,
    condDiscountPct: null,
    otpKtpPct: 0,
    condPriceNoVat: null,
    isWinner: false,
    isSecondPlace: false,
    ...overrides
  };
}

function withPrice(total: number): Pick<CompetitorBid, "bidUnitPriceNoVat" | "bidTotalPriceNoVat"> {
  return { bidUnitPriceNoVat: total, bidTotalPriceNoVat: total };
}

const f3 = { bidderBin: DEMO_F3_BIN, bidderName: DEMO_F3_NAME, ourCompany: DEMO_F3_NAME };
const partner = { bidderBin: DEMO_PARTNER_BIN, bidderName: DEMO_PARTNER_NAME, ourCompany: DEMO_PARTNER_NAME };

/**
 * Выдуманный набор для «Потерь по причинам» (asOf = 2026-11-21).
 *
 * ИП:
 * - LS-1 (окт): отклонены F3 (лицензия на ПО, 2,1 млн) и партнёр (ЭЦП, 2,2 млн), победил Гамма за 2,3 млн → один лот, ПО, дешевле.
 * - LS-2 (ноя, приём до 17.11): F3 отклонён (авторизационное письмо), 1,4 млн < 1,5 млн у Дельты → свежий, дешевле.
 * - LS-3 (ноя, приём до 14.11): партнёр отклонён (ТС), 0,9 млн < 1,0 млн у Гаммы → дешевле, на границе окна 7 дней.
 * - LS-4 (окт): не состоялась, F3 отклонён (обеспечение заявки), 3,0 млн.
 * - LS-5 (окт): F3 отклонён, но лот выиграл партнёр → это не потеря группы.
 * - LS-6 (ноя): F3 допущен 2,5 млн, Дельта победила за 2,0 млн, Гамма тоже участвовала → проигрыш по цене, разрыв 0,5 млн.
 * - LS-7 (окт): F3 допущен 1,75 млн, Гамма победила за 1,8 млн по условной скидке → разрыв −0,05 млн.
 * КТ:
 * - LK-1 (ноя, приём до 21.11): F3 отклонён (обеспечение, текст на казахском), 0,55 млн < 0,6 млн у Эпсилона.
 */
export function buildLossesSample(): { lots: CompetitorLot[]; bids: CompetitorBid[] } {
  const ls1 = lossLot({ annoId: "7001", lotNumber: "LS-1", startDate: "2026-10-05", endDate: "2026-10-20", winnerBidTotalPriceNoVat: 2300000 });
  const ls2 = lossLot({ annoId: "7002", lotNumber: "LS-2", startDate: "2026-11-02", endDate: "2026-11-17", winnerBin: RIVAL_DELTA.bin, winnerName: RIVAL_DELTA.name, winnerBidTotalPriceNoVat: 1500000 });
  const ls3 = lossLot({ annoId: "7003", lotNumber: "LS-3", startDate: "2026-11-01", endDate: "2026-11-14", winnerBidTotalPriceNoVat: 1000000 });
  const ls4 = lossLot({ annoId: "7004", lotNumber: "LS-4", startDate: "2026-10-10", endDate: "2026-10-25", status: "Закупка не состоялась", winnerBin: "", winnerName: "" });
  const ls5 = lossLot({ annoId: "7005", lotNumber: "LS-5", startDate: "2026-10-12", endDate: "2026-10-27", winnerBin: DEMO_PARTNER_BIN, winnerName: DEMO_PARTNER_NAME, winnerIsOurs: DEMO_PARTNER_NAME, winnerBidTotalPriceNoVat: 850000 });
  const ls6 = lossLot({ annoId: "7006", lotNumber: "LS-6", startDate: "2026-11-03", endDate: "2026-11-15", winnerBin: RIVAL_DELTA.bin, winnerName: RIVAL_DELTA.name, winnerBidTotalPriceNoVat: 2000000 });
  const ls7 = lossLot({ annoId: "7007", lotNumber: "LS-7", startDate: "2026-10-15", endDate: "2026-10-30", winnerBidTotalPriceNoVat: 1800000, winnerCondDiscountPct: 5 });
  const lk1 = lossLot({
    annoId: "7101", lotNumber: "LK-1", group: "КТ", kind: "Ноутбук", diagonal: "", enstruCode: "262011.100.000001",
    startDate: "2026-11-04", endDate: "2026-11-21", winnerBin: RIVAL_EPSILON.bin, winnerName: RIVAL_EPSILON.name, winnerBidTotalPriceNoVat: 600000
  });

  const bids: CompetitorBid[] = [
    lossBid(ls1, { ...f3, admittedStatus: "Отклонен", rejectionShort: "Несоответствие КД", rejectionDetail: "Не предоставлена лицензия на программное обеспечение", ...withPrice(2100000) }),
    lossBid(ls1, { ...partner, admittedStatus: "Отклонен", rejectionShort: "Заявка не подписана ЭЦП", rejectionDetail: "", ...withPrice(2200000) }),
    lossBid(ls1, { ...gammaBidder(), ...withPrice(2300000), isWinner: true }),

    lossBid(ls2, { ...f3, admittedStatus: "Отклонен", rejectionShort: "Отсутствует авторизационное письмо производителя", ...withPrice(1400000) }),
    lossBid(ls2, { bidderBin: RIVAL_DELTA.bin, bidderName: RIVAL_DELTA.name, ...withPrice(1500000), isWinner: true }),

    lossBid(ls3, { ...partner, admittedStatus: "Отклонен", rejectionShort: "Не соответствует технической спецификации", rejectionDetail: "Диагональ меньше требуемой", ...withPrice(900000) }),
    lossBid(ls3, { ...gammaBidder(), ...withPrice(1000000), isWinner: true }),

    lossBid(ls4, { ...f3, admittedStatus: "Отклонен", rejectionShort: "Не внесено обеспечение заявки", ...withPrice(3000000) }),

    lossBid(ls5, { ...f3, admittedStatus: "Отклонен", rejectionShort: "Иные основания", ...withPrice(800000) }),
    lossBid(ls5, { ...partner, ...withPrice(850000), isWinner: true }),

    lossBid(ls6, { ...f3, ...withPrice(2500000), isSecondPlace: true }),
    lossBid(ls6, { bidderBin: RIVAL_DELTA.bin, bidderName: RIVAL_DELTA.name, ...withPrice(2000000), isWinner: true }),
    lossBid(ls6, { ...gammaBidder(), ...withPrice(2600000) }),

    lossBid(ls7, { ...f3, ...withPrice(1750000), condDiscountPct: 0, isSecondPlace: true }),
    lossBid(ls7, { ...gammaBidder(), ...withPrice(1800000), condDiscountPct: 5, otpKtpPct: 5, isWinner: true }),

    lossBid(lk1, { ...f3, admittedStatus: "Отклонен", rejectionShort: "Өтінімді қамтамасыз ету енгізілмеген", ...withPrice(550000) }),
    lossBid(lk1, { bidderBin: RIVAL_EPSILON.bin, bidderName: RIVAL_EPSILON.name, ...withPrice(600000), isWinner: true })
  ];

  return { lots: [ls1, ls2, ls3, ls4, ls5, ls6, ls7, lk1], bids };
}

function gammaBidder(): Pick<CompetitorBid, "bidderBin" | "bidderName"> {
  return { bidderBin: RIVAL_GAMMA.bin, bidderName: RIVAL_GAMMA.name };
}

export function buildLossesSampleView(asOfDate = LOSSES_AS_OF): CompetitorsView {
  const { lots, bids } = buildLossesSample();
  return buildCompetitorsView({ lots, bids, templateMatches: [], asOfDate, updatedAt: asOfDate, cfg: demoLossesConfig() });
}
