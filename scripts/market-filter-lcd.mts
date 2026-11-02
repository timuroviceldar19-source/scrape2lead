import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { goszakupGraphqlPage } from "../src/kz/goszakupGraphql.js";
import { classifyCode, loadMarketConfig, marketConfigKey } from "../src/kz/market/config.js";
import { dedupeSubjects } from "../src/kz/market/fetchZakupMarket.js";
import type { MarketConfig, MarketUnit } from "../src/kz/market/types.js";
import { mapWithConcurrency, zakupGet, zakupListAll } from "../src/kz/zakupPublicApi.js";

const LCD_PREFIX = "279020.100.";
const DEFAULT_IN_PATH = "tmp/market-lcd/in/units-2026.json";
const DEFAULT_OUT_DIR = "tmp/market-lcd";
const ZAKUP_CACHE_FILE_NAME = ".cache-zakup-subjects.json";
const OWS_CACHE_FILE_NAME = ".cache-ows-contracts.json";

interface ZakupContractRow {
  id: number;
  external_id?: number | string | null;
  sign_date?: string | null;
  enstru_code?: string[] | null;
}

export interface ZakupSubjectItem {
  id?: number;
  external_id?: number | string | null;
  timestamp?: number | null;
  item_price_without_vat?: number | null;
  quantity?: number | null;
  contract_price_without_vat?: number | null;
  purchase_total_price_without_vat?: number | null;
  plan_item?: {
    enstru?: { code?: string | null } | null;
    name_ru?: string | null;
    extra_description_ru?: string | null;
    extra_description_kk?: string | null;
  } | null;
  contract?: {
    id?: number;
    external_id?: number | string | null;
    contract_number_sys?: string | null;
  } | null;
}

export interface OwsContractUnit {
  refEnstruCode?: string | string[] | null;
  Plans?: {
    nameRu?: string | null;
    extraDescRu?: string | null;
    extraDescKz?: string | null;
  } | null;
}

export interface OwsContractRow {
  id: number;
  ContractUnits?: OwsContractUnit[] | null;
}

export interface MonthSummary {
  month: string;
  ipSumBefore: number;
  ipCountBefore: number;
  ipSumAfter: number;
  ipCountAfter: number;
  lcdTotalSum: number;
  lcdTotalCount: number;
  lcdKeptSum: number;
  lcdKeptCount: number;
  lcdKeptZakupCount: number;
  lcdKeptOwsCount: number;
  lcdRemovedSum: number;
  lcdRemovedCount: number;
  lcdNoTextBothCount: number;
  contractsTotal: number;
  contractsFound: number;
  contractsNotFound: number;
  contractsNotFoundBoth: number;
}

export interface ScriptSummary {
  updatedAt: string;
  configKey: string;
  months: MonthSummary[];
  total: MonthSummary;
}

export interface FilterLcdUnitsInput {
  units: MarketUnit[];
  cfg: MarketConfig;
  zakupSubjectsByOwsId: Map<number, ZakupSubjectItem[]>;
  owsContractsById: Map<number, OwsContractRow>;
  updatedAt?: string;
}

export interface OctoberRow {
  date: string;
  supplier: string;
  sum: number;
  text: string;
  code: string;
  id: number;
}

export interface OctoberRemovedRow extends OctoberRow {
  reason: string;
}

export interface FilterLcdUnitsResult {
  finalUnits: MarketUnit[];
  scriptSummary: ScriptSummary;
  octoberKept: OctoberRow[];
  octoberRemoved: OctoberRemovedRow[];
}

export function parseArgs(rawArgs: string[] = process.argv.slice(2)): {
  inPath: string;
  outDir: string;
  write: boolean;
  noCache: boolean;
} {
  const args = rawArgs;
  let inPath = DEFAULT_IN_PATH;
  let outDir = DEFAULT_OUT_DIR;
  let write = false;
  let noCache = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--write") write = true;
    else if (a === "--no-cache") noCache = true;
    else if (a === "--in" && args[i + 1]) {
      inPath = args[++i];
    } else if (a === "--out-dir" && args[i + 1]) {
      outDir = args[++i];
    }
  }

  return { inPath, outDir, write, noCache };
}

export function getMonthDates(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${month}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function loadJsonCache<T>(cachePath: string): Record<string, T> {
  try {
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    }
  } catch {
    // Ignore cache load errors
  }
  return {};
}

function saveJsonCache<T>(cachePath: string, cache: Record<string, T>): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache), "utf8");
  } catch {
    // Ignore cache save errors
  }
}

async function fetchAllLcdSubjectsFromZakup(
  months: string[],
  cachePath: string,
  noCache: boolean
): Promise<Map<number, ZakupSubjectItem[]>> {
  const cache = noCache ? {} : loadJsonCache<ZakupSubjectItem[]>(cachePath);
  const subjectsByOwsId = new Map<number, ZakupSubjectItem[]>();

  // Populate from cache first
  for (const [key, subs] of Object.entries(cache)) {
    const id = Number(key);
    if (Number.isFinite(id)) subjectsByOwsId.set(id, subs);
  }

  console.log(`[Фильтр ЖК] В кэше уже есть субъекты для ${subjectsByOwsId.size} договоров ows`);

  if (!noCache && subjectsByOwsId.size > 0) {
    return subjectsByOwsId;
  }

  // Fetch missing months/contracts
  const contractsToFetchSubjects: ZakupContractRow[] = [];
  for (const m of months) {
    const { from, to } = getMonthDates(m);
    console.log(`[Фильтр ЖК] Запрос списка договоров за ${m} (${from}..${to})...`);
    const rows = await zakupListAll<ZakupContractRow>(
      "/public/contracts/",
      {
        enstru_code__startswith: LCD_PREFIX,
        sign_date__gte: from,
        sign_date__lte: to,
        system_id: 1
      },
      { pauseMs: 100 }
    );
    console.log(`[Фильтр ЖК] ${m}: получено договоров в списке: ${rows.length}`);
    for (const row of rows) {
      contractsToFetchSubjects.push(row);
    }
  }

  // Deduplicate contracts by zakup id
  const uniqueContracts = new Map<number, ZakupContractRow>();
  for (const c of contractsToFetchSubjects) {
    if (!uniqueContracts.has(c.id)) uniqueContracts.set(c.id, c);
  }

  console.log(`[Фильтр ЖК] Всего уникальных договоров на zakup по префиксу: ${uniqueContracts.size}`);

  // Fetch subjects for contracts not yet in cache
  const toFetch = [...uniqueContracts.values()].filter((c) => {
    if (c.external_id && subjectsByOwsId.has(Number(c.external_id))) return false;
    return true;
  });

  console.log(`[Фильтр ЖК] Запрос позиций (subjects) для ${toFetch.length} договоров...`);

  let fetchedCount = 0;
  await mapWithConcurrency(toFetch, 4, async (c) => {
    try {
      const res = await zakupGet<ZakupSubjectItem[] | { results?: ZakupSubjectItem[] }>(
        `/public/contracts/${c.id}/subjects/`,
        {},
        { pauseMs: 100 }
      );
      const list = Array.isArray(res) ? res : res.results ?? [];
      const deduped = dedupeSubjects(list);
      fetchedCount++;
      if (fetchedCount % 50 === 0 || fetchedCount === toFetch.length) {
        console.log(`[Фильтр ЖК] Загружено позиций договоров: ${fetchedCount}/${toFetch.length}`);
      }

      const extId = c.external_id ?? deduped[0]?.contract?.external_id;
      if (extId) {
        const idNum = Number(extId);
        subjectsByOwsId.set(idNum, deduped);
        cache[String(idNum)] = deduped;
      }
    } catch (err) {
      console.warn(`[Фильтр ЖК] Ошибка загрузки subjects для договора ${c.id}: ${err instanceof Error ? err.message : err}`);
    }
  });

  saveJsonCache(cachePath, cache);
  return subjectsByOwsId;
}

export async function fetchMissingContractsFromOws(
  contractIds: number[],
  cachePath: string,
  noCache: boolean,
  token?: string
): Promise<Map<number, OwsContractRow>> {
  const cache = noCache ? {} : loadJsonCache<OwsContractRow>(cachePath);
  const owsContractsById = new Map<number, OwsContractRow>();

  for (const [key, c] of Object.entries(cache)) {
    const id = Number(key);
    if (Number.isFinite(id)) owsContractsById.set(id, c);
  }

  const missingIds = contractIds.filter((id) => !owsContractsById.has(id));
  if (missingIds.length === 0) {
    console.log(`[Фильтр ЖК] Все ${contractIds.length} договоров для ows уже в кэше`);
    return owsContractsById;
  }

  if (!token) {
    throw new Error("GOSZAKUP_TOKEN is required in .env to fetch contracts from ows.goszakup.gov.kz");
  }

  console.log(`[Фильтр ЖК] Запрос ${missingIds.length} договоров из ows (пачками по 50)...`);
  const query = `query($ids: [Int]) {
    Contract(filter: { id: $ids }, limit: 50) {
      id
      ContractUnits {
        refEnstruCode
        Plans {
          nameRu
          extraDescRu
          extraDescKz
        }
      }
    }
  }`;

  for (let i = 0; i < missingIds.length; i += 50) {
    const chunk = missingIds.slice(i, i + 50);
    const res = await goszakupGraphqlPage<OwsContractRow>(
      query,
      { ids: chunk },
      "Contract",
      { token }
    );
    for (const c of res.items) {
      owsContractsById.set(c.id, c);
      cache[String(c.id)] = c;
    }
    const done = Math.min(i + 50, missingIds.length);
    console.log(`[Фильтр ЖК] Загружено из ows: ${done}/${missingIds.length}`);
  }

  saveJsonCache(cachePath, cache);
  return owsContractsById;
}

export function findBestSubject(subs: ZakupSubjectItem[], u: MarketUnit): ZakupSubjectItem | null {
  if (!subs || subs.length === 0) return null;

  // 1. Exact code match
  const withCode = subs.filter((s) => s.plan_item?.enstru?.code === u.code);
  const candidates = withCode.length > 0 ? withCode : subs;

  // 2. Exact price and qty match
  const exact = candidates.find(
    (s) => Number(s.item_price_without_vat ?? 0) === u.price && Number(s.quantity ?? 0) === u.qty
  );
  if (exact) return exact;

  // 3. Exact sum match
  const sumMatch = candidates.find((s) => {
    const sum = Number(s.contract_price_without_vat ?? s.purchase_total_price_without_vat ?? 0);
    return sum === u.sum;
  });
  if (sumMatch) return sumMatch;

  // 4. Fallback to first candidate
  return candidates[0];
}

export function extractZakupText(
  subs: ZakupSubjectItem[] | undefined,
  u: MarketUnit
): { text: string; bestSubject: ZakupSubjectItem | null } {
  if (!subs || subs.length === 0) return { text: "", bestSubject: null };
  const best = findBestSubject(subs, u);
  if (!best) return { text: "", bestSubject: null };
  const pi = best.plan_item;
  const text = [pi?.name_ru, pi?.extra_description_ru, pi?.extra_description_kk]
    .filter((v): v is string => Boolean(v && typeof v === "string" && v.trim()))
    .join(" ");
  return { text, bestSubject: best };
}

export function extractOwsText(
  owsContract: OwsContractRow | undefined,
  u: MarketUnit
): { text: string; codeMatched: boolean; matchedUnit: OwsContractUnit | null } {
  if (!owsContract || !owsContract.ContractUnits || owsContract.ContractUnits.length === 0) {
    return { text: "", codeMatched: false, matchedUnit: null };
  }

  let unit = u.unitIndex != null ? owsContract.ContractUnits[u.unitIndex] : undefined;
  let codeMatched = false;

  if (unit) {
    const codes = Array.isArray(unit.refEnstruCode)
      ? unit.refEnstruCode
      : unit.refEnstruCode
      ? [unit.refEnstruCode]
      : [];
    codeMatched = codes.includes(u.code);
  }

  if (!codeMatched) {
    const fallbackUnit = owsContract.ContractUnits.find((cu) => {
      const codes = Array.isArray(cu.refEnstruCode)
        ? cu.refEnstruCode
        : cu.refEnstruCode
        ? [cu.refEnstruCode]
        : [];
      return codes.includes(u.code);
    });
    if (fallbackUnit) {
      unit = fallbackUnit;
      codeMatched = true;
    }
  }

  if (!codeMatched || !unit) {
    return { text: "", codeMatched: false, matchedUnit: null };
  }

  const p = unit.Plans;
  const text = [p?.nameRu, p?.extraDescRu, p?.extraDescKz]
    .filter((v): v is string => Boolean(v && typeof v === "string" && v.trim()))
    .join(" ");

  return { text, codeMatched: true, matchedUnit: unit };
}

export function filterLcdUnits(input: FilterLcdUnitsInput): FilterLcdUnitsResult {
  const { units, cfg, zakupSubjectsByOwsId, owsContractsById } = input;
  const configKey = marketConfigKey(cfg);

  const lcdUnits = units.filter((u) => u.code && u.code.startsWith(LCD_PREFIX));
  const uniqueMonths = [...new Set(lcdUnits.map((u) => u.month))].sort();

  const monthMap = new Map<
    string,
    {
      ipBefore: { sum: number; count: number };
      ipAfter: { sum: number; count: number };
      lcdTotal: { sum: number; count: number };
      lcdKept: { sum: number; count: number };
      lcdKeptZakupCount: number;
      lcdKeptOwsCount: number;
      lcdRemoved: { sum: number; count: number };
      lcdNoTextBothCount: number;
      contractsInFile: Set<number>;
      contractsFoundZakup: Set<number>;
      contractsFoundAnywhere: Set<number>;
    }
  >();

  for (const m of uniqueMonths) {
    monthMap.set(m, {
      ipBefore: { sum: 0, count: 0 },
      ipAfter: { sum: 0, count: 0 },
      lcdTotal: { sum: 0, count: 0 },
      lcdKept: { sum: 0, count: 0 },
      lcdKeptZakupCount: 0,
      lcdKeptOwsCount: 0,
      lcdRemoved: { sum: 0, count: 0 },
      lcdNoTextBothCount: 0,
      contractsInFile: new Set<number>(),
      contractsFoundZakup: new Set<number>(),
      contractsFoundAnywhere: new Set<number>()
    });
  }

  for (const u of units) {
    if (u.group === "ИП" && monthMap.has(u.month)) {
      const stats = monthMap.get(u.month)!;
      stats.ipBefore.sum += u.sum;
      stats.ipBefore.count++;
    }
  }

  const octoberKept: OctoberRow[] = [];
  const octoberRemoved: OctoberRemovedRow[] = [];
  const finalUnits: MarketUnit[] = [];

  for (const u of units) {
    const isLcd = u.code && u.code.startsWith(LCD_PREFIX);
    if (!isLcd) {
      finalUnits.push(u);
      if (u.group === "ИП" && monthMap.has(u.month)) {
        const stats = monthMap.get(u.month)!;
        stats.ipAfter.sum += u.sum;
        stats.ipAfter.count++;
      }
      continue;
    }

    const stats = monthMap.get(u.month);
    if (stats) {
      stats.lcdTotal.sum += u.sum;
      stats.lcdTotal.count++;
      stats.contractsInFile.add(u.id);
    }

    // Source 1: Zakup
    const subs = zakupSubjectsByOwsId.get(u.id);
    const foundOnZakup = Boolean(subs && subs.length > 0);
    if (foundOnZakup && stats) {
      stats.contractsFoundZakup.add(u.id);
      stats.contractsFoundAnywhere.add(u.id);
    }
    const { text: zakupText } = extractZakupText(subs, u);

    // Source 2: Ows
    const owsContract = owsContractsById.get(u.id);
    const foundOnOws = Boolean(owsContract);
    if (foundOnOws && stats) {
      stats.contractsFoundAnywhere.add(u.id);
    }
    const { text: owsText } = extractOwsText(owsContract, u);

    let kept = false;
    let keptSource: "zakup" | "ows" | null = null;
    let usedText = "";

    // 1. Try zakup first
    if (zakupText.trim()) {
      const classified = classifyCode(u.code, cfg, zakupText);
      if (classified) {
        kept = true;
        keptSource = "zakup";
        usedText = zakupText;
      }
    }

    // 2. If not kept, try ows
    if (!kept && owsText.trim()) {
      const classified = classifyCode(u.code, cfg, owsText);
      if (classified) {
        kept = true;
        keptSource = "ows";
        usedText = owsText;
      }
    }

    if (kept) {
      const updatedUnit: MarketUnit = {
        ...u,
        kind: "Интерактивные панели"
      };
      finalUnits.push(updatedUnit);
      if (stats) {
        stats.lcdKept.sum += u.sum;
        stats.lcdKept.count++;
        if (keptSource === "zakup") stats.lcdKeptZakupCount++;
        else if (keptSource === "ows") stats.lcdKeptOwsCount++;
        stats.ipAfter.sum += u.sum;
        stats.ipAfter.count++;
      }
      if (u.month === "2026-10") {
        octoberKept.push({
          date: u.date,
          supplier: u.supplierName || u.supplier,
          sum: u.sum,
          text: usedText,
          code: u.code,
          id: u.id
        });
      }
    } else {
      const hasNoTextInBoth = !zakupText.trim() && !owsText.trim();
      if (stats) {
        stats.lcdRemoved.sum += u.sum;
        stats.lcdRemoved.count++;
        if (hasNoTextInBoth) {
          stats.lcdNoTextBothCount++;
        }
      }
      if (u.month === "2026-10") {
        let reason = "нет слова 'интерактив'";
        if (!foundOnZakup && !foundOnOws) {
          reason = "договор не найден ни на zakup, ни в ows";
        } else if (hasNoTextInBoth) {
          reason = "нет описания ни в одном источнике";
        }
        octoberRemoved.push({
          date: u.date,
          supplier: u.supplierName || u.supplier,
          sum: u.sum,
          text: usedText || zakupText || owsText || "(нет данных)",
          code: u.code,
          id: u.id,
          reason
        });
      }
    }
  }

  const monthSummaries: MonthSummary[] = [];
  const totalSummary: MonthSummary = {
    month: "Итого 2026 (10 мес)",
    ipSumBefore: 0,
    ipCountBefore: 0,
    ipSumAfter: 0,
    ipCountAfter: 0,
    lcdTotalSum: 0,
    lcdTotalCount: 0,
    lcdKeptSum: 0,
    lcdKeptCount: 0,
    lcdKeptZakupCount: 0,
    lcdKeptOwsCount: 0,
    lcdRemovedSum: 0,
    lcdRemovedCount: 0,
    lcdNoTextBothCount: 0,
    contractsTotal: 0,
    contractsFound: 0,
    contractsNotFound: 0,
    contractsNotFoundBoth: 0
  };

  const allContractsInFile = new Set<number>();
  const allContractsFoundZakup = new Set<number>();
  const allContractsFoundAnywhere = new Set<number>();

  for (const m of uniqueMonths) {
    const stats = monthMap.get(m)!;
    for (const id of stats.contractsInFile) allContractsInFile.add(id);
    for (const id of stats.contractsFoundZakup) allContractsFoundZakup.add(id);
    for (const id of stats.contractsFoundAnywhere) allContractsFoundAnywhere.add(id);

    const ms: MonthSummary = {
      month: m,
      ipSumBefore: Math.round(stats.ipBefore.sum),
      ipCountBefore: stats.ipBefore.count,
      ipSumAfter: Math.round(stats.ipAfter.sum),
      ipCountAfter: stats.ipAfter.count,
      lcdTotalSum: Math.round(stats.lcdTotal.sum),
      lcdTotalCount: stats.lcdTotal.count,
      lcdKeptSum: Math.round(stats.lcdKept.sum),
      lcdKeptCount: stats.lcdKept.count,
      lcdKeptZakupCount: stats.lcdKeptZakupCount,
      lcdKeptOwsCount: stats.lcdKeptOwsCount,
      lcdRemovedSum: Math.round(stats.lcdRemoved.sum),
      lcdRemovedCount: stats.lcdRemoved.count,
      lcdNoTextBothCount: stats.lcdNoTextBothCount,
      contractsTotal: stats.contractsInFile.size,
      contractsFound: stats.contractsFoundZakup.size,
      contractsNotFound: stats.contractsInFile.size - stats.contractsFoundZakup.size,
      contractsNotFoundBoth: stats.contractsInFile.size - stats.contractsFoundAnywhere.size
    };
    monthSummaries.push(ms);

    totalSummary.ipSumBefore += ms.ipSumBefore;
    totalSummary.ipCountBefore += ms.ipCountBefore;
    totalSummary.ipSumAfter += ms.ipSumAfter;
    totalSummary.ipCountAfter += ms.ipCountAfter;
    totalSummary.lcdTotalSum += ms.lcdTotalSum;
    totalSummary.lcdTotalCount += ms.lcdTotalCount;
    totalSummary.lcdKeptSum += ms.lcdKeptSum;
    totalSummary.lcdKeptCount += ms.lcdKeptCount;
    totalSummary.lcdKeptZakupCount += ms.lcdKeptZakupCount;
    totalSummary.lcdKeptOwsCount += ms.lcdKeptOwsCount;
    totalSummary.lcdRemovedSum += ms.lcdRemovedSum;
    totalSummary.lcdRemovedCount += ms.lcdRemovedCount;
    totalSummary.lcdNoTextBothCount += ms.lcdNoTextBothCount;
  }

  totalSummary.contractsTotal = allContractsInFile.size;
  totalSummary.contractsFound = allContractsFoundZakup.size;
  totalSummary.contractsNotFound = allContractsInFile.size - allContractsFoundZakup.size;
  totalSummary.contractsNotFoundBoth = allContractsInFile.size - allContractsFoundAnywhere.size;

  const scriptSummary: ScriptSummary = {
    updatedAt: input.updatedAt || new Date().toISOString().slice(0, 10),
    configKey,
    months: monthSummaries,
    total: totalSummary
  };

  return {
    finalUnits,
    scriptSummary,
    octoberKept,
    octoberRemoved
  };
}

async function main(): Promise<void> {
  const { inPath, outDir, write, noCache } = parseArgs();
  const cfg = loadMarketConfig();
  const newConfigKey = marketConfigKey(cfg);

  console.log(`[Фильтр ЖК] Чтение ${inPath}...`);
  if (!fs.existsSync(inPath)) {
    throw new Error(
      `Файл не найден: ${inPath}. Скачайте его через: gh release download market-seed --pattern units-2026.json --dir tmp/market-lcd/in`
    );
  }

  const rawJson = JSON.parse(fs.readFileSync(inPath, "utf8"));
  const existingUnits: MarketUnit[] = Array.isArray(rawJson) ? rawJson : rawJson.units ?? [];
  const completeMonths: string[] = Array.isArray(rawJson.completeMonths) ? rawJson.completeMonths : [];
  const origUpdatedAt: string = rawJson.updatedAt || new Date().toISOString().slice(0, 10);

  console.log(`[Фильтр ЖК] Загружено позиций: ${existingUnits.length}, месяцев: ${completeMonths.length}`);

  const lcdUnits = existingUnits.filter((u) => u.code && u.code.startsWith(LCD_PREFIX));
  console.log(`[Фильтр ЖК] ЖК-позиций (код ${LCD_PREFIX}*): ${lcdUnits.length}`);

  const uniqueMonths = [...new Set(lcdUnits.map((u) => u.month))].sort();
  console.log(`[Фильтр ЖК] Месяцы ЖК: ${uniqueMonths.join(", ")}`);

  // 1. Fetch Zakup subjects
  const zakupCachePath = path.join(outDir, ZAKUP_CACHE_FILE_NAME);
  const subjectsByOwsId = await fetchAllLcdSubjectsFromZakup(uniqueMonths, zakupCachePath, noCache);

  // 2. Determine which contracts need OWS fallback:
  // - Contracts not found on zakup, OR
  // - Contracts where LCD position has empty text in zakup subject
  const contractsNeedingOws = new Set<number>();
  for (const u of lcdUnits) {
    const subs = subjectsByOwsId.get(u.id);
    if (!subs || subs.length === 0) {
      contractsNeedingOws.add(u.id);
    } else {
      const { text } = extractZakupText(subs, u);
      if (!text.trim()) {
        contractsNeedingOws.add(u.id);
      }
    }
  }

  console.log(`[Фильтр ЖК] Договоров, требующих проверки в ows: ${contractsNeedingOws.size}`);

  // 3. Fetch from OWS
  const owsCachePath = path.join(outDir, OWS_CACHE_FILE_NAME);
  const owsContractsById = await fetchMissingContractsFromOws(
    [...contractsNeedingOws],
    owsCachePath,
    noCache,
    process.env.GOSZAKUP_TOKEN
  );

  // 4. Run pure filter
  const { finalUnits, scriptSummary, octoberKept, octoberRemoved } = filterLcdUnits({
    units: existingUnits,
    cfg,
    zakupSubjectsByOwsId: subjectsByOwsId,
    owsContractsById,
    updatedAt: origUpdatedAt
  });

  const { months: monthSummaries, total: totalSummary } = scriptSummary;

  // Print results
  console.log("\n=================== СВОДКА ПО МЕСЯЦАМ ===================");
  console.table(
    monthSummaries.map((s) => ({
      Месяц: s.month,
      "ИП до (млн ₸)": (s.ipSumBefore / 1_000_000).toFixed(1),
      "ИП после (млн ₸)": (s.ipSumAfter / 1_000_000).toFixed(1),
      "ЖК всего (млн ₸)": (s.lcdTotalSum / 1_000_000).toFixed(1),
      "ЖК оставлено": `${s.lcdKeptCount} шт (${(s.lcdKeptSum / 1_000_000).toFixed(1)} млн: zakup=${s.lcdKeptZakupCount}, ows=${s.lcdKeptOwsCount})`,
      "ЖК удалено": `${s.lcdRemovedCount} шт (${(s.lcdRemovedSum / 1_000_000).toFixed(1)} млн: без текста=${s.lcdNoTextBothCount})`,
      "Не найдено нигде": `${s.contractsNotFoundBoth}`
    }))
  );

  console.log("\n=================== ИТОГО ЗА 2026 ГОД ===================");
  console.log(`ИП до: ${(totalSummary.ipSumBefore / 1_000_000).toFixed(1)} млн ₸ (${totalSummary.ipCountBefore} поз.)`);
  console.log(`ИП после: ${(totalSummary.ipSumAfter / 1_000_000).toFixed(1)} млн ₸ (${totalSummary.ipCountAfter} поз.)`);
  console.log(`ЖК всего: ${(totalSummary.lcdTotalSum / 1_000_000).toFixed(1)} млн ₸ (${totalSummary.lcdTotalCount} поз.)`);
  console.log(
    `ЖК оставлено: ${(totalSummary.lcdKeptSum / 1_000_000).toFixed(1)} млн ₸ (${totalSummary.lcdKeptCount} поз., из них zakup=${totalSummary.lcdKeptZakupCount}, ows=${totalSummary.lcdKeptOwsCount})`
  );
  console.log(
    `ЖК удалено: ${(totalSummary.lcdRemovedSum / 1_000_000).toFixed(1)} млн ₸ (${totalSummary.lcdRemovedCount} поз., без текста в обоих=${totalSummary.lcdNoTextBothCount})`
  );
  console.log(
    `Договоров ЖК всего: ${totalSummary.contractsTotal}, найдено на zakup: ${totalSummary.contractsFound}, не найдено на zakup: ${totalSummary.contractsNotFound}, не найдено нигде: ${totalSummary.contractsNotFoundBoth}`
  );
  console.log(`Позиций в файле всего: до ${existingUnits.length}, после ${finalUnits.length} (-${existingUnits.length - finalUnits.length})`);

  // Build october-check.md
  octoberRemoved.sort((a, b) => b.sum - a.sum);
  const top15Removed = octoberRemoved.slice(0, 15);

  let octoberMd = `# Сверка позиций ЖК за октябрь 2026\n\n`;
  octoberMd += `## Оставленные ЖК-позиции октября (всего: ${octoberKept.length}, ${(octoberKept.reduce((a, b) => a + b.sum, 0) / 1_000_000).toFixed(2)} млн ₸)\n\n`;
  octoberMd += `| # | Дата | Поставщик | Сумма (₸) | Первые 100 символов описания |\n`;
  octoberMd += `|---|---|---|---|---|\n`;
  for (let i = 0; i < octoberKept.length; i++) {
    const item = octoberKept[i];
    const textSnippet = item.text.replace(/\r?\n/g, " ").slice(0, 100);
    octoberMd += `| ${i + 1} | ${item.date} | ${item.supplier} | ${item.sum.toLocaleString("ru-RU")} | ${textSnippet} |\n`;
  }

  octoberMd += `\n## 15 самых крупных удалённых ЖК-позиций октября (всего удалено: ${octoberRemoved.length}, ${(octoberRemoved.reduce((a, b) => a + b.sum, 0) / 1_000_000).toFixed(2)} млн ₸)\n\n`;
  octoberMd += `| # | Дата | Поставщик | Сумма (₸) | Причина | Первые 100 символов описания |\n`;
  octoberMd += `|---|---|---|---|---|---|\n`;
  for (let i = 0; i < top15Removed.length; i++) {
    const item = top15Removed[i];
    const textSnippet = item.text.replace(/\r?\n/g, " ").slice(0, 100);
    octoberMd += `| ${i + 1} | ${item.date} | ${item.supplier} | ${item.sum.toLocaleString("ru-RU")} | ${item.reason} | ${textSnippet} |\n`;
  }

  if (write) {
    fs.mkdirSync(outDir, { recursive: true });

    const outSummaryPath = path.join(outDir, "summary.json");
    fs.writeFileSync(outSummaryPath, JSON.stringify(scriptSummary, null, 2), "utf8");
    console.log(`\n[Фильтр ЖК] Записан ${outSummaryPath}`);

    const outOctoberMdPath = path.join(outDir, "october-check.md");
    fs.writeFileSync(outOctoberMdPath, octoberMd, "utf8");
    console.log(`[Фильтр ЖК] Записан ${outOctoberMdPath}`);

    const outUnitsPath = path.join(outDir, "units-2026.json");
    const outPayload = {
      updatedAt: origUpdatedAt,
      completeMonths,
      configKey: newConfigKey,
      units: finalUnits
    };
    fs.writeFileSync(outUnitsPath, JSON.stringify(outPayload, null, 2), "utf8");
    console.log(`[Фильтр ЖК] Записан ${outUnitsPath} (${finalUnits.length} позиций, configKey: ${newConfigKey})`);
  } else {
    console.log(`\n[Фильтр ЖК] Просмотр (dry-run). Для записи файлов передайте флаг --write`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[Фильтр ЖК] Фатальная ошибка:", err);
    process.exit(1);
  });
}
