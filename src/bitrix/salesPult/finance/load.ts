// Финансовый отчёт из чата Битрикс24: финансист каждый день кладёт туда Excel.
// Файлы чата лежат в его папке на Диске (как реестр ОП — в папке чата задачи), поэтому
// читаем её так же: disk.folder.getchildren, самый свежий .xlsx по времени загрузки.
//
// Старые файлы остаются в папке, из них собирается история по дням. Кэш (data/register,
// зашифрован ключом истории реестра) только экономит скачивания: потеряется — история
// соберётся из папки заново. В лог не пишем ни сумм, ни названий из файла: лог Actions публичный.

import fs from "node:fs";
import path from "node:path";
import type { ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";
import { decryptPayload, encryptPayload } from "../register/crypto.js";
import { FinanceParseError, financeSnapshot, parseFinanceExcel } from "./parseReport.js";
import type { FinanceFileInfo, FinanceReport, FinanceSnapshot, FinanceView } from "./types.js";

export const DEFAULT_FINANCE_CACHE_PATH = "data/register/finance.json";

/** Повышать, когда меняется разбор: файлы из кэша тогда разбираются заново. */
export const FINANCE_PARSE_VERSION = 1;

const DEFAULT_MAX_DOWNLOADS = 20;
const MAX_SNAPSHOTS = 400;

interface DiskItem {
  ID: string | number;
  NAME: string;
  TYPE: string;
  CREATE_TIME?: string;
  UPDATE_TIME?: string;
  DOWNLOAD_URL?: string;
  [key: string]: unknown;
}

interface CachedFile {
  name: string;
  createTime: string;
  updateTime: string;
  ok: boolean;
  error?: string;
  /** Файл не скачался (сеть, HTTP): на следующем запуске пробуем снова. */
  transient?: boolean;
  snapshot?: FinanceSnapshot;
}

interface FinanceCache {
  v: number;
  files: Record<string, CachedFile>;
  latest?: { fileId: string; report: FinanceReport };
}

export interface LoadFinanceOptions {
  reader?: Pick<ReadOnlyBitrixClient, "listAllBatched">;
  folderId?: number | string;
  /** Локальный файл вместо папки чата (`--finance-file`). */
  localFile?: string;
  cachePath?: string;
  /** Ключ шифрования кэша; по умолчанию REGISTER_HISTORY_KEY. */
  secretKey?: string;
  maxDownloads?: number;
  fetchFn?: typeof fetch;
}

const emptyCache = (): FinanceCache => ({ v: FINANCE_PARSE_VERSION, files: {} });

function readCache(cachePath: string, key: string): FinanceCache {
  const resolved = path.resolve(cachePath);
  if (!fs.existsSync(resolved)) return emptyCache();
  try {
    const parsed = JSON.parse(decryptPayload(fs.readFileSync(resolved, "utf8"), key)) as FinanceCache;
    if (parsed?.v !== FINANCE_PARSE_VERSION || typeof parsed.files !== "object") return emptyCache();
    return parsed;
  } catch {
    console.warn("[Финансы] Кэш не расшифровался (другой ключ или файл повреждён), соберу заново из папки чата");
    return emptyCache();
  }
}

function writeCache(cachePath: string, key: string, cache: FinanceCache): void {
  try {
    const resolved = path.resolve(cachePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, encryptPayload(JSON.stringify(cache), key), "utf8");
  } catch (err) {
    console.warn(`[Финансы] Не удалось сохранить кэш: ${(err as Error).name}`);
  }
}

const timeOf = (iso?: string) => {
  const ms = Date.parse(iso ?? "");
  return Number.isNaN(ms) ? 0 : ms;
};

function newestFirst(a: DiskItem, b: DiskItem): number {
  return timeOf(b.CREATE_TIME) - timeOf(a.CREATE_TIME) || Number(b.ID) - Number(a.ID);
}

/** Причина без данных из файла: её видно и на странице, и в публичном логе. */
function reasonOf(err: unknown): string {
  if (err instanceof FinanceParseError) return err.message;
  const name = (err as Error)?.name || "Error";
  return `не удалось прочитать файл (${name})`;
}

export function formatAlmaty(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms + 5 * 3_600_000).toISOString();
  return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)}`;
}

function snapshotsFrom(cache: FinanceCache): FinanceSnapshot[] {
  const byDate = new Map<string, { at: number; snap: FinanceSnapshot }>();
  for (const file of Object.values(cache.files)) {
    if (!file.ok || !file.snapshot) continue;
    const at = timeOf(file.createTime);
    const prev = byDate.get(file.snapshot.dataDate);
    if (!prev || at >= prev.at) byDate.set(file.snapshot.dataDate, { at, snap: file.snapshot });
  }
  return [...byDate.values()].map((x) => x.snap).sort((a, b) => a.dataDate.localeCompare(b.dataDate)).slice(-MAX_SNAPSHOTS);
}

function fileInfo(cache: FinanceCache, id: string): FinanceFileInfo | undefined {
  const file = cache.files[id];
  return file ? { id, name: file.name, uploadedAt: file.createTime } : undefined;
}

function viewFromCache(cache: FinanceCache): FinanceView {
  if (!cache.latest) return { snapshots: snapshotsFrom(cache) };
  return { report: cache.latest.report, file: fileInfo(cache, cache.latest.fileId), snapshots: snapshotsFrom(cache) };
}

export async function loadFinanceView(options: LoadFinanceOptions): Promise<FinanceView> {
  if (options.localFile) {
    const name = path.basename(options.localFile);
    try {
      const report = await parseFinanceExcel(fs.readFileSync(options.localFile));
      const uploadedAt = fs.statSync(options.localFile).mtime.toISOString();
      console.log(`[Финансы] Локальный файл: отчёт на ${report.dataDate}, предупреждений сверки ${report.warnings.length}`);
      return { report, file: { id: "local", name, uploadedAt }, snapshots: [financeSnapshot(report)] };
    } catch (err) {
      return { snapshots: [], error: `Файл «${name}» не разобран: ${reasonOf(err)}` };
    }
  }
  if (!options.folderId || !options.reader) {
    return { snapshots: [], error: "Финансовый отчёт не подключён: не задана папка чата (finance.diskFolderId в config/sales-pult.json)" };
  }

  const key = (options.secretKey ?? process.env.REGISTER_HISTORY_KEY)?.trim() || "";
  const cachePath = options.cachePath ?? DEFAULT_FINANCE_CACHE_PATH;
  const fetchFn = options.fetchFn ?? fetch;
  const cache = key ? readCache(cachePath, key) : emptyCache();

  let listing: DiskItem[];
  try {
    listing = await options.reader.listAllBatched<DiskItem>("disk.folder.getchildren", { id: options.folderId });
  } catch (err) {
    console.warn(`[Финансы] Не удалось прочитать папку чата (${(err as Error)?.name || "Error"})`);
    const view = viewFromCache(cache);
    return view.report
      ? { ...view, notice: "Не удалось прочитать папку чата в Битрикс24, показан последний сохранённый отчёт." }
      : { ...view, error: "Не удалось прочитать папку чата «Финансовый отчет» в Битрикс24." };
  }

  const files = listing.filter((f) => f.TYPE === "file" && /\.xlsx$/i.test(String(f.NAME))).sort(newestFirst);
  const present = new Set(files.map((f) => String(f.ID)));
  for (const id of Object.keys(cache.files)) if (!present.has(id)) delete cache.files[id];
  if (cache.latest && !present.has(cache.latest.fileId)) delete cache.latest;

  // Без ключа кэша нет: разбираем только свежие файлы, пока один не прочитается.
  const budget = key ? options.maxDownloads ?? DEFAULT_MAX_DOWNLOADS : 3;
  const reports = new Map<string, FinanceReport>();
  let downloads = 0;
  let failed = 0;

  const parseFile = async (f: DiskItem): Promise<void> => {
    const id = String(f.ID);
    downloads++;
    const entry: CachedFile = { name: String(f.NAME), createTime: f.CREATE_TIME ?? "", updateTime: f.UPDATE_TIME ?? "", ok: false };
    let downloaded = false;
    try {
      if (!f.DOWNLOAD_URL) throw new FinanceParseError("у файла нет ссылки на скачивание");
      const res = await fetchFn(f.DOWNLOAD_URL);
      if (!res.ok) throw new FinanceParseError(`файл не скачался: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      downloaded = true;
      const report = await parseFinanceExcel(buffer);
      entry.ok = true;
      entry.snapshot = financeSnapshot(report);
      reports.set(id, report);
    } catch (err) {
      entry.error = reasonOf(err);
      if (!downloaded) entry.transient = true;
      failed++;
    }
    cache.files[id] = entry;
  };

  for (const f of files) {
    const cached = cache.files[String(f.ID)];
    if (cached && !cached.transient && cached.updateTime === (f.UPDATE_TIME ?? "")) {
      if (!key && cached.ok) break;
      continue;
    }
    if (downloads >= budget) break;
    await parseFile(f);
    if (!key && cache.files[String(f.ID)].ok) break;
  }

  const newestOk = files.find((f) => cache.files[String(f.ID)]?.ok);
  if (!newestOk) {
    delete cache.latest;
  } else {
    const id = String(newestOk.ID);
    if (cache.latest?.fileId !== id) {
      if (!reports.has(id)) await parseFile(newestOk);
      const report = reports.get(id);
      if (report) cache.latest = { fileId: id, report };
    } else if (reports.has(id)) {
      cache.latest = { fileId: id, report: reports.get(id)! };
    }
  }
  if (key) writeCache(cachePath, key, cache);

  const view = viewFromCache(cache);
  const newest = files[0];
  const newestEntry = newest ? cache.files[String(newest.ID)] : undefined;
  if (newest && newestEntry && !newestEntry.ok) {
    const shown = view.file ? ` Показан отчёт из файла «${view.file.name}» (${formatAlmaty(view.file.uploadedAt)}).` : "";
    view.notice = `Последний файл «${newestEntry.name}» (${formatAlmaty(newestEntry.createTime)}) не разобран: ${newestEntry.error}.${shown}`;
  }
  if (!view.report) {
    view.error = files.length
      ? "В чате «Финансовый отчет» нет файла, который удалось разобрать."
      : "В чате «Финансовый отчет» пока нет ни одного .xlsx.";
  }

  const pending = key ? files.filter((f) => {
    const entry = cache.files[String(f.ID)];
    return !entry || entry.transient || entry.updateTime !== (f.UPDATE_TIME ?? "");
  }).length : 0;
  console.log(
    `[Финансы] Файлов в чате: ${files.length}, разобрано сейчас: ${downloads}` +
      (failed ? `, не разобрано: ${failed}` : "") +
      (pending ? `, ждут разбора: ${pending}` : "") +
      (view.report ? `, отчёт на ${view.report.dataDate}, предупреждений сверки ${view.report.warnings.length}` : ", отчёта нет") +
      `, дней в истории: ${view.snapshots.length}` +
      (key ? "" : " (без ключа кэша истории нет)")
  );
  return view;
}
