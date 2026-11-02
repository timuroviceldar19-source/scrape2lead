import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyCode, loadMarketConfig, marketConfigKey } from "../src/kz/market/config.js";
import { dedupeSubjects } from "../src/kz/market/fetchZakupMarket.js";
import type { MarketUnit } from "../src/kz/market/types.js";
import { mapWithConcurrency, zakupGet, zakupListAll } from "../src/kz/zakupPublicApi.js";

const LCD_PREFIX = "279020.100.";
const DEFAULT_IN_PATH = "tmp/market-lcd/in/units-2026.json";
const DEFAULT_OUT_DIR = "tmp/market-lcd";
const CACHE_FILE_NAME = ".cache-zakup-subjects.json";

interface ZakupContractRow {
  id: number;
  external_id?: number | string | null;
  sign_date?: string | null;
  enstru_code?: string[] | null;
}

interface ZakupSubjectItem {
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

interface MonthSummary {
  month: string;
  ipSumBefore: number;
  ipCountBefore: number;
  ipSumAfter: number;
  ipCountAfter: number;
  lcdTotalSum: number;
  lcdTotalCount: number;
  lcdKeptSum: number;
  lcdKeptCount: number;
  lcdRemovedSum: number;
  lcdRemovedCount: number;
  contractsTotal: number;
  contractsFound: number;
  contractsNotFound: number;
}

interface ScriptSummary {
  updatedAt: string;
  configKey: string;
  months: MonthSummary[];
  total: MonthSummary;
}

export function parseArgs(rawArgs: string[] = process.argv.slice(2)): { inPath: string; outDir: string; write: boolean; noCache: boolean } {
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

function loadSubjectCache(cachePath: string): Record<string, ZakupSubjectItem[]> {
  try {
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    }
  } catch {
    // Ignore cache load errors
  }
  return {};
}

function saveSubjectCache(cachePath: string, cache: Record<string, ZakupSubjectItem[]>): void {
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
  const cache = noCache ? {} : loadSubjectCache(cachePath);
  const subjectsByOwsId = new Map<number, ZakupSubjectItem[]>();

  // Populate from cache first
  for (const [key, subs] of Object.entries(cache)) {
    const id = Number(key);
    if (Number.isFinite(id)) subjectsByOwsId.set(id, subs);
  }

  console.log(`[Фильтр ЖК] В кэше уже есть субъекты для ${subjectsByOwsId.size} договоров ows`);

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

  saveSubjectCache(cachePath, cache);
  return subjectsByOwsId;
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

async function main(): Promise<void> {
  const { inPath, outDir, write, noCache } = parseArgs();
  const cfg = loadMarketConfig();
  const newConfigKey = marketConfigKey(cfg);

  console.log(`[Фильтр ЖК] Чтение ${inPath}...`);
  if (!fs.existsSync(inPath)) {
    throw new Error(`Файл не найден: ${inPath}. Скачайте его через: gh release download market-seed --pattern units-2026.json --dir tmp/market-lcd/in`);
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

  const cachePath = path.join(outDir, CACHE_FILE_NAME);
  const subjectsByOwsId = await fetchAllLcdSubjectsFromZakup(uniqueMonths, cachePath, noCache);

  // Stats tracking by month
  const monthMap = new Map<
    string,
    {
      ipBefore: { sum: number; count: number };
      ipAfter: { sum: number; count: number };
      lcdTotal: { sum: number; count: number };
      lcdKept: { sum: number; count: number };
      lcdRemoved: { sum: number; count: number };
      contractsInFile: Set<number>;
      contractsFound: Set<number>;
    }
  >();

  for (const m of uniqueMonths) {
    monthMap.set(m, {
      ipBefore: { sum: 0, count: 0 },
      ipAfter: { sum: 0, count: 0 },
      lcdTotal: { sum: 0, count: 0 },
      lcdKept: { sum: 0, count: 0 },
      lcdRemoved: { sum: 0, count: 0 },
      contractsInFile: new Set<number>(),
      contractsFound: new Set<number>()
    });
  }

  // Pre-calculate IP before
  for (const u of existingUnits) {
    if (u.group === "ИП" && monthMap.has(u.month)) {
      const stats = monthMap.get(u.month)!;
      stats.ipBefore.sum += u.sum;
      stats.ipBefore.count++;
    }
  }

  // Track October details
  const octoberKept: Array<{ date: string; supplier: string; sum: number; text: string; code: string; id: number }> = [];
  const octoberRemoved: Array<{ date: string; supplier: string; sum: number; text: string; code: string; id: number; reason: string }> = [];

  const finalUnits: MarketUnit[] = [];

  for (const u of existingUnits) {
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

    const subs = subjectsByOwsId.get(u.id);
    let kept = false;
    let subjectText = "";

    if (subs && subs.length > 0) {
      if (stats) stats.contractsFound.add(u.id);
      const best = findBestSubject(subs, u);
      if (best) {
        const pi = best.plan_item;
        subjectText = [pi?.name_ru, pi?.extra_description_ru, pi?.extra_description_kk]
          .filter((v): v is string => Boolean(v && typeof v === "string" && v.trim()))
          .join(" ");

        const classified = classifyCode(u.code, cfg, subjectText);
        if (classified) {
          kept = true;
          const updatedUnit: MarketUnit = {
            ...u,
            kind: classified.kind
          };
          finalUnits.push(updatedUnit);
          if (stats) {
            stats.lcdKept.sum += u.sum;
            stats.lcdKept.count++;
            stats.ipAfter.sum += u.sum;
            stats.ipAfter.count++;
          }
          if (u.month === "2026-10") {
            octoberKept.push({
              date: u.date,
              supplier: u.supplierName || u.supplier,
              sum: u.sum,
              text: subjectText,
              code: u.code,
              id: u.id
            });
          }
        }
      }
    }

    if (!kept) {
      if (stats) {
        stats.lcdRemoved.sum += u.sum;
        stats.lcdRemoved.count++;
      }
      if (u.month === "2026-10") {
        octoberRemoved.push({
          date: u.date,
          supplier: u.supplierName || u.supplier,
          sum: u.sum,
          text: subjectText || "(нет данных на zakup)",
          code: u.code,
          id: u.id,
          reason: subs ? "нет слова 'интерактив'" : "договор не найден на zakup"
        });
      }
    }
  }

  // Build summary
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
    lcdRemovedSum: 0,
    lcdRemovedCount: 0,
    contractsTotal: 0,
    contractsFound: 0,
    contractsNotFound: 0
  };

  const allContractsInFile = new Set<number>();
  const allContractsFound = new Set<number>();

  for (const m of uniqueMonths) {
    const stats = monthMap.get(m)!;
    const notFoundCount = stats.contractsInFile.size - stats.contractsFound.size;
    for (const id of stats.contractsInFile) allContractsInFile.add(id);
    for (const id of stats.contractsFound) allContractsFound.add(id);

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
      lcdRemovedSum: Math.round(stats.lcdRemoved.sum),
      lcdRemovedCount: stats.lcdRemoved.count,
      contractsTotal: stats.contractsInFile.size,
      contractsFound: stats.contractsFound.size,
      contractsNotFound: notFoundCount
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
    totalSummary.lcdRemovedSum += ms.lcdRemovedSum;
    totalSummary.lcdRemovedCount += ms.lcdRemovedCount;
  }

  totalSummary.contractsTotal = allContractsInFile.size;
  totalSummary.contractsFound = allContractsFound.size;
  totalSummary.contractsNotFound = allContractsInFile.size - allContractsFound.size;

  const scriptSummary: ScriptSummary = {
    updatedAt: origUpdatedAt,
    configKey: newConfigKey,
    months: monthSummaries,
    total: totalSummary
  };

  // Print results
  console.log("\n=================== СВОДКА ПО МЕСЯЦАМ ===================");
  console.table(
    monthSummaries.map((s) => ({
      Месяц: s.month,
      "ИП до (млн ₸)": (s.ipSumBefore / 1_000_000).toFixed(1),
      "ИП после (млн ₸)": (s.ipSumAfter / 1_000_000).toFixed(1),
      "ЖК всего (млн ₸)": (s.lcdTotalSum / 1_000_000).toFixed(1),
      "ЖК оставлено": `${s.lcdKeptCount} шт (${(s.lcdKeptSum / 1_000_000).toFixed(1)} млн)`,
      "ЖК удалено": `${s.lcdRemovedCount} шт (${(s.lcdRemovedSum / 1_000_000).toFixed(1)} млн)`,
      "Договоров не найдено": `${s.contractsNotFound} из ${s.contractsTotal}`
    }))
  );

  console.log("\n=================== ИТОГО ЗА 2026 ГОД ===================");
  console.log(`ИП до: ${(totalSummary.ipSumBefore / 1_000_000).toFixed(1)} млн ₸ (${totalSummary.ipCountBefore} поз.)`);
  console.log(`ИП после: ${(totalSummary.ipSumAfter / 1_000_000).toFixed(1)} млн ₸ (${totalSummary.ipCountAfter} поз.)`);
  console.log(`ЖК всего: ${(totalSummary.lcdTotalSum / 1_000_000).toFixed(1)} млн ₸ (${totalSummary.lcdTotalCount} поз.)`);
  console.log(`ЖК оставлено: ${(totalSummary.lcdKeptSum / 1_000_000).toFixed(1)} млн ₸ (${totalSummary.lcdKeptCount} поз.)`);
  console.log(`ЖК удалено: ${(totalSummary.lcdRemovedSum / 1_000_000).toFixed(1)} млн ₸ (${totalSummary.lcdRemovedCount} поз.)`);
  console.log(`Договоров ЖК всего: ${totalSummary.contractsTotal}, найдено на zakup: ${totalSummary.contractsFound}, не найдено: ${totalSummary.contractsNotFound}`);
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
