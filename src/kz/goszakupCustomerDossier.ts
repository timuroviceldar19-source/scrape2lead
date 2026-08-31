/**
 * Досье заказчика по данным goszakup.gov.kz: кто ведёт закупки, что этот БИН уже покупал, чем
 * закончилось и по какой цене.
 *
 * Страницы забираются обычным HTTP-запросом — портал отдаёт объявления, лоты и договоры без
 * авторизации, поэтому Playwright здесь не нужен. Загрузчик передаётся снаружи: тесты подсовывают
 * фикстуры, CLI — реальный fetch с троттлингом.
 */

import {
  parseAnnounceAwards,
  parseAnnounceRepresentative,
  parseCustomerLots,
  type CustomerLot,
  type LotAward
} from "./goszakupDossierParser.js";
import { GZ_PORTAL_ORIGIN } from "./goszakupOrigin.js";

const BASE_URL = GZ_PORTAL_ORIGIN;
const DEFAULT_RECORDS_PER_PAGE = 50;
const DEFAULT_MAX_ANNOUNCEMENTS = 8;

export type DossierPageLoader = (url: string) => Promise<string>;

export interface CustomerDossierOptions {
  bin: string;
  query: string;
  loadPage: DossierPageLoader;
  /** Сколько объявлений раскрывать вглубь. Крупный заказчик имеет тысячи лотов — обход ограничен. */
  maxAnnouncements?: number;
  recordsPerPage?: number;
  onProgress?: (message: string) => void;
}

export interface CustomerOfficer {
  fullName: string;
  position: string | null;
  email: string | null;
  announceIds: string[];
}

export interface SupplierStat {
  name: string;
  bin: string | null;
  wins: number;
  contractedTotal: number;
}

export interface PriceHistoryEntry {
  lotNumber: string;
  announceId: string | null;
  quantity: number | null;
  plannedAmount: number | null;
  contractedAmount: number | null;
  plannedUnitPrice: number | null;
  contractedUnitPrice: number | null;
  discountPercent: number | null;
  supplierName: string | null;
  supplierBin: string | null;
}

export interface DossierSummary {
  lotsTotal: number;
  lotsAwarded: number;
  lotsFailed: number;
  plannedTotal: number;
  contractedTotal: number;
  averageDiscountPercent: number | null;
  suppliers: SupplierStat[];
  priceHistory: PriceHistoryEntry[];
}

export interface CustomerDossier {
  bin: string;
  query: string;
  lots: CustomerLot[];
  awards: LotAward[];
  officers: CustomerOfficer[];
  summary: DossierSummary;
}

/**
 * `toLocaleString("ru-RU")` разделяет разряды неразрывным пробелом. В комментариях Bitrix и в
 * консоли он выглядит как обычный, но ломает поиск по тексту, поэтому заменяется явно.
 */
export function formatMoney(value: number | null): string {
  if (value === null) return "-";
  return `${value.toLocaleString("ru-RU").replace(/ /g, " ")} ₸`;
}

export function buildCustomerLotsUrl(options: {
  bin: string;
  query: string;
  recordsPerPage?: number;
}): string {
  const params = new URLSearchParams();
  // На реестрах портала фильтр называется `customer` и принимает как БИН, так и наименование.
  // `customer_bin` молча игнорируется и возвращает весь реестр.
  params.set("filter[customer]", options.bin);
  params.set("filter[name]", options.query);
  params.set("count_record", String(options.recordsPerPage ?? DEFAULT_RECORDS_PER_PAGE));
  return `${BASE_URL}/ru/search/lots?${params.toString()}`;
}

export function buildAnnounceUrl(announceId: string): string {
  return `${BASE_URL}/ru/announce/index/${announceId}`;
}

export function buildAnnounceContractsUrl(announceId: string): string {
  return `${BASE_URL}/ru/announce/index/${announceId}?tab=contracts`;
}

export async function buildCustomerDossier(options: CustomerDossierOptions): Promise<CustomerDossier> {
  const { bin, query, loadPage } = options;
  const maxAnnouncements = options.maxAnnouncements ?? DEFAULT_MAX_ANNOUNCEMENTS;
  const report = options.onProgress ?? (() => {});

  const lotsHtml = await loadPage(
    buildCustomerLotsUrl({ bin, query, recordsPerPage: options.recordsPerPage })
  );
  const lots = parseCustomerLots(lotsHtml);
  report(`лотов найдено: ${lots.length}`);

  const announceIds = uniqueAnnounceIds(lots).slice(0, maxAnnouncements);
  const awards: LotAward[] = [];
  const officers: CustomerOfficer[] = [];

  for (const announceId of announceIds) {
    const contractsHtml = await loadPage(buildAnnounceContractsUrl(announceId));
    awards.push(...parseAnnounceAwards(contractsHtml));

    const announceHtml = await loadPage(buildAnnounceUrl(announceId));
    const representative = parseAnnounceRepresentative(announceHtml);
    if (representative) mergeOfficer(officers, representative, announceId);
    report(`объявление ${announceId}: договоров ${awards.length}, закупщиков ${officers.length}`);
  }

  return { bin, query, lots, awards, officers, summary: summarize(lots, awards) };
}

function uniqueAnnounceIds(lots: CustomerLot[]): string[] {
  const ids: string[] = [];
  for (const lot of lots) {
    if (lot.announceId && !ids.includes(lot.announceId)) ids.push(lot.announceId);
  }
  return ids;
}

function mergeOfficer(
  officers: CustomerOfficer[],
  representative: { fullName: string; position: string | null; email: string | null },
  announceId: string
): void {
  const existing = officers.find((officer) => officer.fullName === representative.fullName);
  if (existing) {
    if (!existing.announceIds.includes(announceId)) existing.announceIds.push(announceId);
    return;
  }
  officers.push({ ...representative, announceIds: [announceId] });
}

/**
 * У одного лота обычно несколько строк: основной договор и доп.соглашения. Считать их как отдельные
 * победы нельзя, поэтому строки схлопываются по паре «лот + поставщик», и остаётся последняя —
 * она отражает действующую сумму.
 */
function effectiveAwards(awards: LotAward[]): LotAward[] {
  const byLotAndSupplier = new Map<string, LotAward>();
  for (const award of awards) {
    byLotAndSupplier.set(`${award.lotId ?? award.lotNumber ?? ""}|${award.supplierBin ?? ""}`, award);
  }
  return [...byLotAndSupplier.values()];
}

function summarize(lots: CustomerLot[], awards: LotAward[]): DossierSummary {
  const effective = effectiveAwards(awards);
  const lotsByNumber = new Map(lots.map((lot) => [lot.lotNumber, lot]));

  const plannedByLot = new Map<string, number>();
  for (const award of effective) {
    const key = award.lotId ?? award.lotNumber ?? "";
    if (award.plannedAmount !== null) plannedByLot.set(key, award.plannedAmount);
  }

  const plannedTotal = sum([...plannedByLot.values()]);
  const contractedTotal = sum(effective.map((award) => award.contractAmount));

  return {
    lotsTotal: lots.length,
    lotsAwarded: plannedByLot.size,
    lotsFailed: lots.filter((lot) => /не состоял/i.test(lot.status ?? "")).length,
    plannedTotal,
    contractedTotal,
    averageDiscountPercent: discountPercent(plannedTotal, contractedTotal),
    suppliers: rankSuppliers(effective),
    priceHistory: effective.map((award) => priceHistoryEntry(award, lotsByNumber))
  };
}

function priceHistoryEntry(award: LotAward, lotsByNumber: Map<string, CustomerLot>): PriceHistoryEntry {
  const lot = award.lotNumber ? lotsByNumber.get(award.lotNumber) ?? null : null;
  const quantity = lot?.quantity ?? null;
  return {
    lotNumber: award.lotNumber ?? lot?.lotNumber ?? "",
    announceId: lot?.announceId ?? null,
    quantity,
    plannedAmount: award.plannedAmount,
    contractedAmount: award.contractAmount,
    plannedUnitPrice: unitPrice(award.plannedAmount, quantity),
    contractedUnitPrice: unitPrice(award.contractAmount, quantity),
    discountPercent: discountPercent(award.plannedAmount ?? 0, award.contractAmount ?? 0),
    supplierName: award.supplierName,
    supplierBin: award.supplierBin
  };
}

function rankSuppliers(awards: LotAward[]): SupplierStat[] {
  const stats = new Map<string, SupplierStat>();
  for (const award of awards) {
    if (!award.supplierName) continue;
    const key = award.supplierBin ?? award.supplierName;
    const current = stats.get(key) ?? { name: award.supplierName, bin: award.supplierBin, wins: 0, contractedTotal: 0 };
    stats.set(key, {
      ...current,
      wins: current.wins + 1,
      contractedTotal: current.contractedTotal + (award.contractAmount ?? 0)
    });
  }
  return [...stats.values()].sort((a, b) => b.wins - a.wins || b.contractedTotal - a.contractedTotal);
}

function unitPrice(amount: number | null, quantity: number | null): number | null {
  if (amount === null || !quantity) return null;
  return Math.round((amount / quantity) * 100) / 100;
}

function discountPercent(planned: number, contracted: number): number | null {
  if (!planned || !contracted) return null;
  return Math.round(((planned - contracted) / planned) * 10_000) / 100;
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
