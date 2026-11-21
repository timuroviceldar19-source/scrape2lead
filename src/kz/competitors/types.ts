import type { MarketConfig } from "../market/types.js";

export type CompetitorGroup = "ИП" | "КТ";

export interface SpecTemplatePhrase {
  label: string;
  phrase: string;
}

export interface SpecTemplateDefinition {
  id: string;
  name: string;
  note?: string;
  text?: string;
  textPath?: string;
  strongShare?: number;
  partialShare?: number;
  corePhrases?: SpecTemplatePhrase[];
  extraPhrases?: SpecTemplatePhrase[];
}

export interface SpecTemplatesFileConfig {
  shingleSize?: number;
  templates: SpecTemplateDefinition[];
}

export interface CompiledSpecTemplate {
  id: string;
  name: string;
  note: string;
  strongShare: number;
  partialShare: number;
  shingleSize: number;
  shingles: Set<string>;
  corePhrases: Array<{ label: string; normalizedPhrase: string }>;
  extraPhrases: Array<{ label: string; normalizedPhrase: string }>;
}

export interface CompiledSpecTemplatesConfig {
  shingleSize: number;
  templates: CompiledSpecTemplate[];
}

export interface SpecTemplateMatch {
  templateId: string;
  templateName: string;
  note: string;
  share: number;
  strength: "strong" | "partial";
  matchedPhrases: string[];
  coreMatchesCount: number;
}

export interface LotTemplateMatch extends SpecTemplateMatch {
  annoId: string;
  lotNumber: string;
}

export interface CompetitorsConfig {
  market: MarketConfig;
  ourBins: Set<string>;
  partnerBins: Set<string>;
  allOurBins: Set<string>;
  ourCompanyNames: Record<string, string>;
  templates: CompiledSpecTemplatesConfig;
}

export interface DiscoveredLotRecord {
  lotNumber: string;
  lotNameSearch: string;
  annoId: string;
  annoNumber: string;
  annoName: string;
  annoUrl: string;
  lotUrl: string;
  customerNameSearch: string;
  qtySearch: number | null;
  plannedSumSearch: number | null;
  methodSearch: string;
  statusSearch: string;
  enstruCode?: string;
  enstruCodesMatched?: string[];
  methodId?: number;
}

export interface SubpriceSubItem {
  planPoint: string;
  customer: string;
  name: string;
  extraDesc: string;
  unitPrice: number | null;
  qty: number | null;
  unit: string;
  plannedSum: number | null;
  status: string;
}

export interface LotDetailParsed {
  lotNumberPage: string;
  statusLot: string;
  startDate: string;
  endDate: string;
  customerBin: string;
  customerName: string;
  enstruCodePage: string;
  truName: string;
  shortDesc: string;
  extraDesc: string;
  unitPrice: number | null;
  unit: string;
  qty: number | null;
  plannedSum: number | null;
  deliveryKato: string;
  subItems: SubpriceSubItem[];
}

export interface AnnounceGeneralParsed {
  annoNumberPage: string;
  annoNamePage: string;
  annoStatus: string;
  publishDate: string;
  startDate: string;
  endDate: string;
  tradeMethod: string;
  organizerBin: string;
  organizerName: string;
  vatFlag: string;
  annoTotalSum: number | null;
}

export interface ProtocolLinkItem {
  url: string;
  linkText: string;
  kind: "itogi" | "discussion" | "vskrytie" | "dopusk" | "protocol_other" | "other";
  status: string;
  heading: string;
  rowText: string;
}

export interface CalcBidRow {
  rank: number | null;
  name: string;
  bin: string;
  allocSum: number | null;
  supplierPriceRaw: number | null;
  art13Sum: number | null;
  condDiscPct: number;
  condPrice: number | null;
  submitDt: string;
}

export interface CondDiscountBreakdown {
  taxPct: number | null;
  funcPct: number | null;
  techPct: number | null;
  qualPct: number | null;
  operPct: number | null;
  localPct: number | null;
  auditPct: number | null;
  negContractsPct: number | null;
  negRnuPct: number | null;
  otpKtpPct: number | null;
  totalDiscPct: number | null;
}

export interface ParsedItogiLot {
  lotMeta: {
    lotName?: string;
    qty?: number | null;
    unitPrice?: number | null;
    plannedSum?: number | null;
  };
  submitted: Record<string, { name: string; bin: string; submitDt: string }>;
  votingRej: Record<string, { short: string[]; detail: string }>;
  rejTable: Record<string, string>;
  admittedBins: string[];
  condDisc: Record<string, CondDiscountBreakdown>;
  calcRows: CalcBidRow[];
  winner: { name: string; bin: string; beneficiary?: string } | null;
  second: { name: string; bin: string } | null;
  conclusions: string;
}

export interface CompetitorLot {
  annoId: string;
  annoNumber: string;
  annoName: string;
  lotNumber: string;
  lotName: string;
  enstruCode: string;
  group: CompetitorGroup;
  kind: string;
  diagonal: string;
  cpu: string;
  isCombinedLot: boolean;
  isKit: boolean;
  isLatestVersion: boolean;
  status: string;
  startDate: string;
  endDate: string;
  customerBin: string;
  customerName: string;
  qty: number;
  plannedUnitPriceNoVat: number | null;
  plannedSumNoVat: number | null;
  numSubmitted: number;
  numAdmitted: number;
  winnerBin: string;
  winnerName: string;
  winnerIsOurs: string;
  winnerBidUnitPriceNoVat: number | null;
  winnerBidTotalPriceNoVat: number | null;
  winnerDiscountFromPlanPct: number | null;
  winnerCondDiscountPct: number | null;
  secondBin: string;
  secondName: string;
  failureReason: string;
  lotUrl: string;
  annoUrl: string;
  protocolUrl: string;
  techspecUrl: string;
  hasTechspec: boolean;
  hasItogi: boolean;
}

export interface CompetitorBid {
  annoId: string;
  lotNumber: string;
  isLatestLotVersion: boolean;
  group: CompetitorGroup;
  kind: string;
  diagonal: string;
  cpu: string;
  isCombinedLot: boolean;
  isKit: boolean;
  startDate: string;
  lotStatus: string;
  plannedQty: number;
  plannedUnitPriceNoVat: number | null;
  plannedSumNoVat: number | null;
  bidderBin: string;
  bidderName: string;
  ourCompany: string;
  admittedStatus: "Допущен" | "Отклонен" | "Не допущен/не рассмотрен";
  rejectionShort: string;
  rejectionDetail: string;
  bidUnitPriceNoVat: number | null;
  bidTotalPriceNoVat: number | null;
  discountFromPlanPct: number | null;
  condDiscountPct: number | null;
  otpKtpPct: number;
  condPriceNoVat: number | null;
  isWinner: boolean;
  isSecondPlace: boolean;
}

export interface StoredSpecText {
  specKey: string;
  annoId: string;
  lotNumber: string;
  fileName: string;
  downloadUrl: string;
  fileKind: string;
  text: string;
  normalizedText: string;
  extractedAt: string;
}

export interface SoftwareMention {
  source: "требовал заказчик" | "предложил участник" | "не предоставил (причина отклонения)";
  category: string;
  software: string;
  matchedToken: string;
  evidence: string;
}

/* ==================== Pult UI View Types ==================== */

export interface CompetitorsSummaryBlock {
  lotsTotal: number;
  wonLots: number;
  failedLots: number;
  cancelledLots: number;
  activeLots: number;
  bidsTotal: number;
  bidsAdmitted: number;
  bidsRejected: number;
  rejectedSharePct: number;
  wonSum: number;
  wonPlanSum: number;
  avgDiscountPct: number | null;
  medianDiscountPct: number | null;
  ourWinsCount: number;
  ourWinsSum: number;
}

export interface CompetitorsMonthBarItem {
  m: string;
  lots: number;
  wonLots: number;
  wonSum: number;
  ourWonSum: number;
}

export interface CompetitorLotEntry {
  annoId: string;
  lotNumber: string;
  date: string;
  customerBin?: string;
  customerName: string;
  kind: string;
  status: string;
  admittedStatus: string;
  rejectionShort: string;
  bidUnitPrice: number | null;
  bidTotalPrice: number | null;
  plannedSum: number | null;
  discountPct: number | null;
  condDiscountPct: number | null;
  otpKtpPct: number;
  isWinner: boolean;
  isSecond: boolean;
  url: string;
}

export interface CompetitorTableRow {
  bin: string;
  name: string;
  ourCompany: string;
  us: boolean;
  bids: number;
  admitted: number;
  rejected: number;
  wins: number;
  secondPlaces: number;
  winRateAdmittedPct: number;
  wonSum: number;
  medianDiscountPct: number | null;
  meanCondDiscountPct: number | null;
  otpKtpCount: number;
  totalLotsInList: number;
  lotList: CompetitorLotEntry[];
}

export type HeadToHeadReason = "price" | "cond_discount" | "our_rejected" | "tie_or_other";

export interface HeadToHeadLotItem {
  annoId: string;
  lotNumber: string;
  date: string;
  customerBin?: string;
  customerName: string;
  kind: string;
  status: string;
  ourCompany: string;
  ourAdmitted: string;
  ourPrice: number | null;
  ourCondDisc: number | null;
  winnerBin: string;
  winnerName: string;
  winnerPrice: number | null;
  winnerDiscountPct?: number | null;
  winnerCondDisc: number | null;
  rivalAdmitted: string;
  rivalPrice: number | null;
  rivalCondDisc: number | null;
  rivalWon: boolean;
  weWon: boolean;
  reason: HeadToHeadReason | null;
  url: string;
}

export interface HeadToHeadRivalRow {
  bin: string;
  name: string;
  sharedLots: number;
  rivalWonOverUs: number;
  weWonOverRival: number;
  bothLost: number;
  lostByPrice: number;
  lostByCondDiscount: number;
  lostByOurRejected: number;
  wonByPrice: number;
  wonByCondDiscount: number;
  wonByRivalRejected: number;
  lots: HeadToHeadLotItem[];
}

export interface OurRejectionItem {
  annoId: string;
  lotNumber: string;
  date: string;
  ourCompany: string;
  ourBin: string;
  customerName: string;
  kind: string;
  status: string;
  rejectionShort: string;
  rejectionDetail: string;
  ourPrice: number | null;
  ourUnitPrice: number | null;
  winnerName: string;
  winnerBin: string;
  winnerPrice: number | null;
  winnerUnitPrice: number | null;
  cheaperThanWinner: boolean;
  cheaperByPct: number | null;
  url: string;
}

export interface PriceStatsTuple {
  min: number | null;
  med: number | null;
  max: number | null;
  n: number;
}

export interface PriceBenchmarkRow {
  label: string;
  lotsCount: number;
  plan: PriceStatsTuple;
  compAdmitted: PriceStatsTuple;
  compWinner: PriceStatsTuple;
  ourAdmitted: PriceStatsTuple;
  ourWinner: PriceStatsTuple;
}

export interface TemplateWinnerRow {
  bin: string;
  name: string;
  ourCompany: string;
  wins: number;
  wonSum: number;
  sharePct: number;
}

export interface TemplateLotItem {
  annoId: string;
  lotNumber: string;
  date: string;
  customerBin?: string;
  customerName: string;
  kind: string;
  status: string;
  strength: "strong" | "partial";
  sharePct: number;
  matchedPhrases: string[];
  winnerName: string;
  winnerBin: string;
  winnerIsOurs: string;
  plannedSum: number | null;
  annoUrl: string;
  techspecUrl: string;
}

export interface SpecTemplateSummary {
  templateId: string;
  templateName: string;
  note: string;
  totalLots: number;
  strongLots: number;
  partialLots: number;
  uniqueCustomers: number;
  decidedLots: number;
  bidsTotal: number;
  bidsAdmitted: number;
  admittedRatePct: number | null;
  winners: TemplateWinnerRow[];
  lots: TemplateLotItem[];
}

export interface CompetitorsGroupSliceView {
  period: string;
  summary: CompetitorsSummaryBlock;
  competitorsTotal: number;
  competitors: CompetitorTableRow[];
  headToHead: HeadToHeadRivalRow[];
  ourRejections: OurRejectionItem[];
  ourRejectionsCheaperCount: number;
  prices: {
    rows: PriceBenchmarkRow[];
    kitsRow: PriceBenchmarkRow | null;
    excludedTypoCount: number;
  };
  specTemplates: SpecTemplateSummary[];
}

export interface CompetitorsGroupView extends CompetitorsGroupSliceView {
  group: CompetitorGroup;
  months: CompetitorsMonthBarItem[];
  monthViews: Record<string, CompetitorsGroupSliceView>;
}

export interface CompetitorsView {
  asOf: string;
  updatedAt?: string;
  stale?: boolean;
  error?: string;
  months: string[];
  ip: CompetitorsGroupView | null;
  kt: CompetitorsGroupView | null;
}
