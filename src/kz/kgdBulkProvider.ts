import type { BulkCheck, BulkMatch, BulkSource } from "./kgdCounterpartyTypes.js";
import { downloadAndCacheBulk, parseBulkWorkbook, readBulkCache, resolveCacheAction } from "./kgdBulk.js";

const SOURCES: Array<{ source: BulkSource; key: string; url: string; preferredPattern?: RegExp }> = [
  { source: "insolvent", key: "insolvent", url: "https://kgd.gov.kz/ru/section/spiski-nesostoyatelnyh-dolzhnikov", preferredPattern: /(spisok_bankrotov|spisok_dlya_razmeshcheniya)/i },
  { source: "forced_liquidation", key: "forced-liquidation", url: "https://www.kgd.gov.kz/ru/content/spisok-lic-likvidirovannyh-po-prinuditelnoy-likvidacii-1" }
];

export interface LoadedBulkSource { source: BulkSource; sourceUrl: string; status: "complete" | "fallback" | "stale_negative" | "unavailable"; listDate?: string; cacheAgeHours?: number; rows: BulkMatch[] }

export async function loadBulkSources(cacheDir = "data/kgd-cache", now = new Date(), fetcher: typeof fetch = fetch): Promise<LoadedBulkSource[]> {
  return Promise.all(SOURCES.map(async (definition) => {
    const cached = readBulkCache(cacheDir, definition.key); const age = cached ? (now.getTime() - new Date(cached.metadata.downloadedAt).getTime()) / 3_600_000 : Number.POSITIVE_INFINITY; const action = resolveCacheAction(age);
    if (cached && action === "use") return parsed(definition.source, definition.url, "complete", age, cached.data, cached.metadata.listDate);
    try { const listDate = await discoverListDate(definition.url, now, fetcher); const fresh = await downloadAndCacheBulk(definition.url, cacheDir, definition.key, listDate, fetcher, definition.preferredPattern); return parsed(definition.source, definition.url, "complete", 0, fresh.data, fresh.metadata.listDate); }
    catch (error) { if (cached && action === "refresh_with_fallback") { const loaded = await parsed(definition.source, definition.url, "fallback", age, cached.data, cached.metadata.listDate); return { ...loaded, status: loaded.rows.length ? "fallback" : "stale_negative" }; } return { source: definition.source, sourceUrl: definition.url, status: "unavailable", rows: [] }; }
  }));
}

export function createBulkChecker(sources: LoadedBulkSource[]): (bin: string) => Promise<BulkCheck[]> { return async (bin) => sources.map((source) => { const matches = source.rows.filter((row) => row.bin === bin); const status = source.status === "fallback" && matches.length === 0 ? "stale_negative" : source.status; return { source: source.source, sourceUrl: source.sourceUrl, status, matched: matches.length > 0, matches, listDate: source.listDate, cacheAgeHours: source.cacheAgeHours }; }); }

async function parsed(source: BulkSource, sourceUrl: string, status: LoadedBulkSource["status"], age: number, data: Buffer, listDate: string): Promise<LoadedBulkSource> { return { source, sourceUrl, status, listDate, cacheAgeHours: age, rows: await parseBulkWorkbook(data, { source, sourceUrl, listDate }) }; }
async function discoverListDate(url: string, now: Date, fetcher: typeof fetch): Promise<string> { const response = await fetcher(url); if (!response.ok) throw new Error(`HTTP ${response.status}`); const html = await response.text(); const labeled = html.match(/Дата (?:изменения|публикации):[\s\S]{0,100}?(\d{2})[.\/-](\d{2})[.\/-](20\d{2})/i); return labeled ? `${labeled[3]}-${labeled[2]}-${labeled[1]}` : now.toISOString().slice(0, 10); }
