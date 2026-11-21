import { calculateQuantile, getPreviousWorkday } from "../market/aggregate.js";
import { loadCompetitorsConfig } from "./config.js";
import { buildLossBreakdown } from "./losses.js";
import { summarizeTemplateWinners } from "./specTemplates.js";
import type {
  CompetitorBid,
  CompetitorGroup,
  CompetitorLot,
  CompetitorLotEntry,
  CompetitorTableRow,
  CompetitorsConfig,
  CompetitorsGroupSliceView,
  CompetitorsGroupView,
  CompetitorsMonthBarItem,
  CompetitorsSummaryBlock,
  CompetitorsView,
  HeadToHeadLotItem,
  HeadToHeadReason,
  HeadToHeadRivalRow,
  LotTemplateMatch,
  OurRejectionItem,
  PriceBenchmarkRow,
  PriceStatsTuple
} from "./types.js";

const MAX_LOTS_PER_COMPETITOR = 50;
const MAX_COMPETITORS_IN_TABLE = 1000;

function cleanEntityName(s: string): string {
  return s.replace(/""+/g, '"').replace(/\s+/g, " ").trim();
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(calculateQuantile(values, 0.5) * 100) / 100;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((s, x) => s + x, 0) / values.length) * 100) / 100;
}

function priceStats(values: number[]): PriceStatsTuple {
  if (values.length === 0) return { min: null, med: null, max: null, n: 0 };
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    min: Math.round(min),
    med: Math.round(calculateQuantile(values, 0.5)),
    max: Math.round(max),
    n: values.length
  };
}

/**
 * Guards medians and min/max against participant typos (e.g. "110 ₸" when plan is 234 627 ₸).
 */
export function isTypoUnitPrice(bidUnitPrice: number | null, plannedUnitPrice: number | null, isKit: boolean): boolean {
  if (bidUnitPrice === null || !Number.isFinite(bidUnitPrice) || bidUnitPrice <= 0) return true;
  if (!isKit && bidUnitPrice < 1000) return true;
  if (plannedUnitPrice !== null && plannedUnitPrice >= 50000 && bidUnitPrice < plannedUnitPrice * 0.05) {
    return true;
  }
  return false;
}

function canonicalNameByBin(bids: readonly CompetitorBid[], cfg: CompetitorsConfig): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const b of bids) {
    if (!b.bidderBin || !b.bidderName) continue;
    let map = counts.get(b.bidderBin);
    if (!map) {
      map = new Map<string, number>();
      counts.set(b.bidderBin, map);
    }
    const clean = cleanEntityName(b.bidderName);
    map.set(clean, (map.get(clean) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [bin, map] of counts) {
    const topName = [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? bin;
    out.set(bin, topName);
  }
  for (const bin of cfg.allOurBins) {
    if (cfg.ourCompanyNames[bin] && !out.has(bin)) {
      out.set(bin, cfg.ourCompanyNames[bin]);
    }
  }
  return out;
}

function buildGroupSlice(
  group: CompetitorGroup,
  period: string,
  lots: readonly CompetitorLot[],
  bids: readonly CompetitorBid[],
  templateMatches: readonly LotTemplateMatch[],
  canonNames: ReadonlyMap<string, string>,
  cfg: CompetitorsConfig,
  asOfDate?: string
): CompetitorsGroupSliceView {
  const lotMap = new Map(lots.map((l) => [`${l.annoId}:${l.lotNumber}`, l]));
  const bidsByLot = new Map<string, CompetitorBid[]>();
  for (const b of bids) {
    const key = `${b.annoId}:${b.lotNumber}`;
    if (!lotMap.has(key)) continue;
    const arr = bidsByLot.get(key) ?? [];
    arr.push(b);
    bidsByLot.set(key, arr);
  }

  // 1. Summary
  const wonLotsList = lots.filter((l) => l.status === "Закупка состоялась");
  const failedLots = lots.filter((l) => l.status === "Закупка не состоялась").length;
  const cancelledLots = lots.filter((l) => l.status === "Отменен" || l.status === "Отказ от лота").length;
  const activeLots = lots.length - wonLotsList.length - failedLots - cancelledLots;

  const bidsAdmitted = bids.filter((b) => b.admittedStatus === "Допущен").length;
  const bidsRejected = bids.filter((b) => b.admittedStatus === "Отклонен").length;

  let wonSum = 0;
  let wonPlanSum = 0;
  let ourWinsCount = 0;
  let ourWinsSum = 0;
  const wonDiscounts: number[] = [];

  for (const l of wonLotsList) {
    const wSum = l.winnerBidTotalPriceNoVat ?? 0;
    const pSum = l.plannedSumNoVat ?? 0;
    wonSum += wSum;
    wonPlanSum += pSum;
    if (l.winnerDiscountFromPlanPct !== null) wonDiscounts.push(l.winnerDiscountFromPlanPct);
    if (l.winnerBin && cfg.allOurBins.has(l.winnerBin)) {
      ourWinsCount++;
      ourWinsSum += wSum;
    }
  }

  const avgDiscountPct = wonPlanSum > 0 ? Math.round(((wonPlanSum - wonSum) / wonPlanSum) * 10000) / 100 : null;
  const summary: CompetitorsSummaryBlock = {
    lotsTotal: lots.length,
    wonLots: wonLotsList.length,
    failedLots,
    cancelledLots,
    activeLots,
    bidsTotal: bids.length,
    bidsAdmitted,
    bidsRejected,
    rejectedSharePct: bids.length > 0 ? Math.round((bidsRejected / bids.length) * 1000) / 10 : 0,
    wonSum: Math.round(wonSum),
    wonPlanSum: Math.round(wonPlanSum),
    avgDiscountPct,
    medianDiscountPct: median(wonDiscounts),
    ourWinsCount,
    ourWinsSum: Math.round(ourWinsSum)
  };

  // 2. Competitors table (including our companies with `us: true`)
  const byBidder = new Map<string, CompetitorBid[]>();
  for (const b of bids) {
    if (!b.bidderBin) continue;
    const arr = byBidder.get(b.bidderBin) ?? [];
    arr.push(b);
    byBidder.set(b.bidderBin, arr);
  }

  const allCompetitorRows: CompetitorTableRow[] = [];
  for (const [bin, bList] of byBidder) {
    const isUs = cfg.allOurBins.has(bin);
    const adm = bList.filter((b) => b.admittedStatus === "Допущен");
    const rej = bList.filter((b) => b.admittedStatus === "Отклонен");
    const wins = bList.filter((b) => b.isWinner);
    const secs = bList.filter((b) => b.isSecondPlace);
    const bWonSum = wins.reduce((s, b) => s + (b.bidTotalPriceNoVat ?? 0), 0);

    const validDiscounts = bList
      .filter((b) => {
        if (b.discountFromPlanPct === null) return false;
        if (b.bidUnitPriceNoVat !== null && isTypoUnitPrice(b.bidUnitPriceNoVat, b.plannedUnitPriceNoVat, b.isKit)) {
          return false;
        }
        return true;
      })
      .map((b) => b.discountFromPlanPct!);
    const condDiscs = adm.filter((b) => b.condDiscountPct !== null).map((b) => b.condDiscountPct!);
    const otpKtpCount = adm.filter((b) => b.otpKtpPct > 0).length;

    const lotEntries: CompetitorLotEntry[] = bList
      .map((b) => {
        const lot = lotMap.get(`${b.annoId}:${b.lotNumber}`);
        return {
          annoId: b.annoId,
          lotNumber: b.lotNumber,
          date: b.startDate,
          customerName: lot?.customerName ?? "",
          customerBin: lot?.customerBin || undefined,
          kind: b.kind,
          status: b.lotStatus,
          admittedStatus: b.admittedStatus,
          rejectionShort: b.rejectionShort,
          bidUnitPrice: b.bidUnitPriceNoVat,
          bidTotalPrice: b.bidTotalPriceNoVat,
          plannedSum: b.plannedSumNoVat,
          discountPct: b.discountFromPlanPct,
          condDiscountPct: b.condDiscountPct,
          otpKtpPct: b.otpKtpPct,
          isWinner: b.isWinner,
          isSecond: b.isSecondPlace,
          url: lot?.annoUrl ?? `https://procurement.gov.kz/ru/announce/index/${b.annoId}`
        };
      })
      .sort((a, b) => Number(b.isWinner) - Number(a.isWinner) || (b.bidTotalPrice ?? b.plannedSum ?? 0) - (a.bidTotalPrice ?? a.plannedSum ?? 0) || b.date.localeCompare(a.date));

    const cappedLots = isUs ? lotEntries : lotEntries.slice(0, MAX_LOTS_PER_COMPETITOR);
    allCompetitorRows.push({
      bin,
      name: canonNames.get(bin) || bList[0].bidderName || bin,
      ourCompany: isUs ? cfg.ourCompanyNames[bin] || bList[0].ourCompany || canonNames.get(bin) || bin : "",
      us: isUs,
      bids: bList.length,
      admitted: adm.length,
      rejected: rej.length,
      wins: wins.length,
      secondPlaces: secs.length,
      winRateAdmittedPct: adm.length > 0 ? Math.round((wins.length / adm.length) * 1000) / 10 : 0,
      wonSum: Math.round(bWonSum),
      medianDiscountPct: median(validDiscounts),
      meanCondDiscountPct: mean(condDiscs),
      otpKtpCount,
      totalLotsInList: lotEntries.length,
      lotList: cappedLots
    });
  }

  allCompetitorRows.sort((a, b) => b.wonSum - a.wonSum || b.wins - a.wins || b.bids - a.bids);
  // Always keep all our companies plus top competitors
  const topCompetitors: CompetitorTableRow[] = [];
  const includedBins = new Set<string>();
  for (const row of allCompetitorRows) {
    if (topCompetitors.length < MAX_COMPETITORS_IN_TABLE || row.us) {
      topCompetitors.push(row);
      includedBins.add(row.bin);
    }
  }

  // 3. Head-to-head where our companies met competitors
  const h2hMap = new Map<string, HeadToHeadRivalRow>();
  for (const [key, lotBids] of bidsByLot) {
    const lot = lotMap.get(key);
    if (!lot) continue;
    const oursIn = lotBids.filter((b) => cfg.allOurBins.has(b.bidderBin));
    if (oursIn.length === 0) continue;
    const rivalsIn = lotBids.filter((b) => !cfg.allOurBins.has(b.bidderBin) && b.bidderBin);
    if (rivalsIn.length === 0) continue;

    // Pick our strongest bid in this lot (winner -> admitted with lowest condPrice -> first)
    const ourPrimary =
      oursIn.find((b) => b.isWinner) ??
      oursIn.filter((b) => b.admittedStatus === "Допущен").sort((a, b) => (a.condPriceNoVat ?? Infinity) - (b.condPriceNoVat ?? Infinity))[0] ??
      oursIn[0];
    const weWon = oursIn.some((b) => b.isWinner);
    const winBid = lotBids.find((b) => b.isWinner) ?? null;

    for (const rival of rivalsIn) {
      const rBin = rival.bidderBin;
      let row = h2hMap.get(rBin);
      if (!row) {
        row = {
          bin: rBin,
          name: canonNames.get(rBin) || rival.bidderName || rBin,
          sharedLots: 0,
          rivalWonOverUs: 0,
          weWonOverRival: 0,
          bothLost: 0,
          lostByPrice: 0,
          lostByCondDiscount: 0,
          lostByOurRejected: 0,
          wonByPrice: 0,
          wonByCondDiscount: 0,
          wonByRivalRejected: 0,
          lots: []
        };
        h2hMap.set(rBin, row);
      }

      row.sharedLots++;
      let reason: HeadToHeadReason | null = null;
      const isDecided = lot.status === "Закупка состоялась";

      if (isDecided) {
        if (rival.isWinner) {
          row.rivalWonOverUs++;
          if (ourPrimary.admittedStatus !== "Допущен") {
            reason = "our_rejected";
            row.lostByOurRejected++;
          } else if (
            ourPrimary.bidTotalPriceNoVat !== null &&
            rival.bidTotalPriceNoVat !== null &&
            ourPrimary.bidTotalPriceNoVat <= rival.bidTotalPriceNoVat + 1
          ) {
            reason = "cond_discount";
            row.lostByCondDiscount++;
          } else {
            reason = "price";
            row.lostByPrice++;
          }
        } else if (weWon) {
          row.weWonOverRival++;
          if (rival.admittedStatus !== "Допущен") {
            reason = "our_rejected"; // rival rejected
            row.wonByRivalRejected++;
          } else if (
            rival.bidTotalPriceNoVat !== null &&
            ourPrimary.bidTotalPriceNoVat !== null &&
            rival.bidTotalPriceNoVat <= ourPrimary.bidTotalPriceNoVat + 1
          ) {
            reason = "cond_discount";
            row.wonByCondDiscount++;
          } else {
            reason = "price";
            row.wonByPrice++;
          }
        } else {
          row.bothLost++;
        }
      }

      const item: HeadToHeadLotItem = {
        annoId: lot.annoId,
        lotNumber: lot.lotNumber,
        date: lot.startDate,
        customerName: lot.customerName,
        customerBin: lot.customerBin || undefined,
        kind: lot.kind,
        status: lot.status,
        ourCompany: ourPrimary.ourCompany || cfg.ourCompanyNames[ourPrimary.bidderBin] || ourPrimary.bidderName,
        ourAdmitted: ourPrimary.admittedStatus,
        ourPrice: ourPrimary.bidTotalPriceNoVat,
        ourCondDisc: ourPrimary.condDiscountPct,
        winnerBin: lot.winnerBin,
        winnerName: lot.winnerName,
        winnerPrice: winBid?.bidTotalPriceNoVat ?? lot.winnerBidTotalPriceNoVat,
        winnerDiscountPct: winBid?.discountFromPlanPct ?? lot.winnerDiscountFromPlanPct,
        winnerCondDisc: winBid?.condDiscountPct ?? lot.winnerCondDiscountPct,
        rivalAdmitted: rival.admittedStatus,
        rivalPrice: rival.bidTotalPriceNoVat,
        rivalCondDisc: rival.condDiscountPct,
        rivalWon: rival.isWinner,
        weWon,
        reason,
        url: lot.annoUrl
      };
      row.lots.push(item);
    }
  }

  const headToHead = [...h2hMap.values()]
    .map((r) => ({ ...r, lots: r.lots.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_LOTS_PER_COMPETITOR) }))
    .sort((a, b) => b.sharedLots - a.sharedLots || b.rivalWonOverUs - a.rivalWonOverUs);

  // 4. Our rejections
  const ourRejections: OurRejectionItem[] = [];
  for (const b of bids) {
    if (!cfg.allOurBins.has(b.bidderBin) || b.admittedStatus !== "Отклонен") continue;
    const key = `${b.annoId}:${b.lotNumber}`;
    const lot = lotMap.get(key);
    const winBid = bidsByLot.get(key)?.find((x) => x.isWinner);
    const ourPrice = b.bidTotalPriceNoVat;
    const winPrice = winBid?.bidTotalPriceNoVat ?? lot?.winnerBidTotalPriceNoVat ?? null;
    const cheaperThanWinner =
      lot?.status === "Закупка состоялась" &&
      ourPrice !== null &&
      winPrice !== null &&
      winPrice > 0 &&
      ourPrice < winPrice - 1;
    const cheaperByPct = cheaperThanWinner && winPrice ? Math.round(((winPrice - ourPrice!) / winPrice) * 1000) / 10 : null;

    ourRejections.push({
      annoId: b.annoId,
      lotNumber: b.lotNumber,
      date: b.startDate,
      ...(lot?.endDate ? { endDate: lot.endDate } : {}),
      ourCompany: b.ourCompany || cfg.ourCompanyNames[b.bidderBin] || b.bidderName,
      ourBin: b.bidderBin,
      customerName: lot?.customerName ?? "",
      kind: b.kind,
      status: b.lotStatus,
      rejectionShort: b.rejectionShort || "Отклонён",
      rejectionDetail: b.rejectionDetail,
      ourPrice,
      ourUnitPrice: b.bidUnitPriceNoVat,
      winnerName: lot?.winnerName ?? "",
      winnerBin: lot?.winnerBin ?? "",
      winnerPrice: winPrice,
      winnerUnitPrice: winBid?.bidUnitPriceNoVat ?? lot?.winnerBidUnitPriceNoVat ?? null,
      cheaperThanWinner,
      cheaperByPct,
      url: lot?.annoUrl ?? `https://procurement.gov.kz/ru/announce/index/${b.annoId}`
    });
  }
  ourRejections.sort((a, b) => Number(b.cheaperThanWinner) - Number(a.cheaperThanWinner) || b.date.localeCompare(a.date));

  // 4a. Потери по причинам: из полного списка очных встреч (в headToHead у соперника не больше 50 лотов)
  const losses = buildLossBreakdown({ ourRejections, headToHead: [...h2hMap.values()] }, { allOurBins: cfg.allOurBins, asOfDate });

  // 5. Price benchmarks (strictly single-item non-combined non-kit; kits separated for ИП)
  let excludedTypoCount = 0;
  const computePriceRow = (
    label: string,
    lotPred: (l: CompetitorLot) => boolean,
    bidPred: (b: CompetitorBid) => boolean
  ): PriceBenchmarkRow => {
    const lSub = lots.filter(lotPred);
    const bSub = bids.filter(bidPred);
    const planVals = lSub.map((l) => l.plannedUnitPriceNoVat).filter((v): v is number => v !== null && v > 0);
    const compAdm: number[] = [];
    const compWin: number[] = [];
    const ourAdm: number[] = [];
    const ourWin: number[] = [];

    for (const b of bSub) {
      if (b.admittedStatus !== "Допущен") continue;
      if (isTypoUnitPrice(b.bidUnitPriceNoVat, b.plannedUnitPriceNoVat, b.isKit)) {
        if (b.bidUnitPriceNoVat !== null && b.bidUnitPriceNoVat > 0) excludedTypoCount++;
        continue;
      }
      const p = b.bidUnitPriceNoVat!;
      const isOurs = cfg.allOurBins.has(b.bidderBin);
      if (isOurs) {
        ourAdm.push(p);
        if (b.isWinner) ourWin.push(p);
      } else {
        compAdm.push(p);
        if (b.isWinner) compWin.push(p);
      }
    }

    return {
      label,
      lotsCount: lSub.length,
      plan: priceStats(planVals),
      compAdmitted: priceStats(compAdm),
      compWinner: priceStats(compWin),
      ourAdmitted: priceStats(ourAdm),
      ourWinner: priceStats(ourWin)
    };
  };

  const priceRows: PriceBenchmarkRow[] = [];
  let kitsRow: PriceBenchmarkRow | null = null;

  if (group === "ИП") {
    const diags = [...new Set(lots.filter((l) => l.kind === "Интерактивная панель" && !l.isCombinedLot && !l.isKit).map((l) => l.diagonal))]
      .sort((a, b) => {
        if (!a) return 1;
        if (!b) return -1;
        return Number.parseInt(a, 10) - Number.parseInt(b, 10);
      });
    for (const d of diags) {
      const label = d || "диаг. не указана";
      const row = computePriceRow(
        `Панель ${label}`,
        (l) => l.kind === "Интерактивная панель" && !l.isCombinedLot && !l.isKit && l.diagonal === d,
        (b) => b.kind === "Интерактивная панель" && !b.isCombinedLot && !b.isKit && b.diagonal === d
      );
      if (row.lotsCount > 0) priceRows.push(row);
    }
    const boardsRow = computePriceRow(
      "Интерактивная доска",
      (l) => l.kind === "Интерактивная доска" && !l.isCombinedLot && !l.isKit,
      (b) => b.kind === "Интерактивная доска" && !b.isCombinedLot && !b.isKit
    );
    if (boardsRow.lotsCount > 0) priceRows.push(boardsRow);

    const kRow = computePriceRow(
      "Учебный комплект (отдельно)",
      (l) => l.kind === "Учебный комплект" && !l.isCombinedLot,
      (b) => b.kind === "Учебный комплект" && !b.isCombinedLot
    );
    if (kRow.lotsCount > 0) kitsRow = kRow;
  } else {
    const ktKinds = ["Компьютер", "Моноблок", "Ноутбук", "Системный блок", "Монитор", "МФУ", "Принтер"];
    for (const k of ktKinds) {
      const row = computePriceRow(
        k,
        (l) => l.kind === k && !l.isCombinedLot && !l.isKit,
        (b) => b.kind === k && !b.isCombinedLot && !b.isKit
      );
      if (row.lotsCount > 0) priceRows.push(row);
    }
  }

  // 6. Spec templates
  const lotMatchesInGroup = templateMatches.filter((m) => lotMap.has(`${m.annoId}:${m.lotNumber}`));
  const specTemplates = cfg.templates.templates.map((tpl) =>
    summarizeTemplateWinners(tpl, lots, bids, lotMatchesInGroup)
  );

  return {
    period,
    summary,
    competitorsTotal: allCompetitorRows.length,
    competitors: topCompetitors,
    headToHead,
    ourRejections,
    ourRejectionsCheaperCount: ourRejections.filter((r) => r.cheaperThanWinner).length,
    losses,
    prices: {
      rows: priceRows,
      kitsRow,
      excludedTypoCount
    },
    specTemplates
  };
}

export function buildCompetitorsGroupView(
  group: CompetitorGroup,
  allLots: readonly CompetitorLot[],
  allBids: readonly CompetitorBid[],
  templateMatches: readonly LotTemplateMatch[],
  cfg: CompetitorsConfig,
  asOfDate?: string
): CompetitorsGroupView | null {
  const latestLots = allLots.filter((l) => l.isLatestVersion && l.group === group);
  const latestBids = allBids.filter((b) => b.isLatestLotVersion && b.group === group);
  if (latestLots.length === 0) return null;

  const canonNames = canonicalNameByBin(latestBids, cfg);
  const byMonthLots = new Map<string, CompetitorLot[]>();
  for (const l of latestLots) {
    const m = l.startDate.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    const arr = byMonthLots.get(m) ?? [];
    arr.push(l);
    byMonthLots.set(m, arr);
  }

  const monthKeys = [...byMonthLots.keys()].sort();
  const months: CompetitorsMonthBarItem[] = monthKeys.map((m) => {
    const mLots = byMonthLots.get(m) ?? [];
    const won = mLots.filter((l) => l.status === "Закупка состоялась");
    const wonSum = won.reduce((s, l) => s + (l.winnerBidTotalPriceNoVat ?? 0), 0);
    const ourWonSum = won
      .filter((l) => l.winnerBin && cfg.allOurBins.has(l.winnerBin))
      .reduce((s, l) => s + (l.winnerBidTotalPriceNoVat ?? 0), 0);
    return {
      m,
      lots: mLots.length,
      wonLots: won.length,
      wonSum: Math.round(wonSum),
      ourWonSum: Math.round(ourWonSum)
    };
  });

  const allSlice = buildGroupSlice(group, "all", latestLots, latestBids, templateMatches, canonNames, cfg, asOfDate);
  const monthViews: Record<string, CompetitorsGroupSliceView> = { all: allSlice };
  for (const m of monthKeys) {
    const mLots = byMonthLots.get(m) ?? [];
    const mLotSet = new Set(mLots.map((l) => `${l.annoId}:${l.lotNumber}`));
    const mBids = latestBids.filter((b) => mLotSet.has(`${b.annoId}:${b.lotNumber}`));
    monthViews[m] = buildGroupSlice(group, m, mLots, mBids, templateMatches, canonNames, cfg, asOfDate);
  }

  return {
    group,
    ...allSlice,
    months,
    monthViews
  };
}

export interface BuildCompetitorsViewOptions {
  lots: readonly CompetitorLot[];
  bids: readonly CompetitorBid[];
  templateMatches: readonly LotTemplateMatch[];
  asOfDate: string;
  updatedAt?: string;
  error?: string;
  cfg?: CompetitorsConfig;
}

export function buildCompetitorsView(options: BuildCompetitorsViewOptions): CompetitorsView {
  const cfg = options.cfg ?? loadCompetitorsConfig();
  const latestLots = options.lots.filter((l) => l.isLatestVersion);
  const months = [
    ...new Set(latestLots.map((l) => l.startDate.slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))
  ].sort();

  const ip = buildCompetitorsGroupView("ИП", options.lots, options.bids, options.templateMatches, cfg, options.asOfDate);
  const kt = buildCompetitorsGroupView("КТ", options.lots, options.bids, options.templateMatches, cfg, options.asOfDate);
  const updatedAt = options.updatedAt?.trim() || undefined;
  const stale = Boolean(updatedAt && updatedAt.slice(0, 10) < getPreviousWorkday(options.asOfDate));

  return {
    asOf: options.asOfDate,
    updatedAt,
    stale,
    ...(options.error ? { error: options.error } : {}),
    months,
    ip,
    kt
  };
}
