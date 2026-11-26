// Финансовый отчёт из чата Битрикс24: финансист каждый день кладёт туда Excel.
// Файлы чата лежат в его папке на Диске (как реестр ОП — в папке чата задачи), поэтому
// читаем её так же: disk.folder.getchildren, самый свежий .xlsx по времени загрузки.
//
// В тот же чат финансисты присылают и книгу «ФО» с листами «ОПиУ» и «Расш. ОПиУ» (26.11.2026).
// Тип файла решают листы, а не имя: книга ФО идёт в раздел ОПиУ и не считается «свежим отчётом»,
// поэтому ежедневный отчёт под ней не ломается и пояснения «не разобран» не появляется.
//
// Старые файлы остаются в папке, из них собирается история по дням. Кэш (data/register,
// зашифрован ключом истории реестра) только экономит скачивания: потеряется — история
// соберётся из папки заново. В лог не пишем ни сумм, ни названий из файла: лог Actions публичный.

import fs from "node:fs";
import path from "node:path";
import type { ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";
import { decryptPayload, encryptPayload } from "../register/crypto.js";
import { isIncomeStatementWorkbook, parseIncomeStatement } from "./incomeStatement.js";
import { FinanceParseError, financeSnapshot, parseFinanceWorkbook, readFinanceWorkbook } from "./parseReport.js";
import type { FinanceFileInfo, FinanceIncomeStatement, FinanceReport, FinanceSnapshot, FinanceView } from "./types.js";

export const DEFAULT_FINANCE_CACHE_PATH = "data/register/finance.json";

/** Повышать, когда меняется разбор: файлы из кэша тогда разбираются заново. */
// 2 — скрытые пустые колонки между банками и листы материальных ведомостей.
// 3 — новые колонки дебиторов (дата оплаты, иск) и сдвинутые «Прочие платежи» / «Топ» (20.11.2026).
// 4 — книга ФО (ОПиУ с расшифровкой) в том же чате: тип файла по листам (26.11.2026).
export const FINANCE_PARSE_VERSION = 4;

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

/** daily — ежедневный отчёт (лист «Ежед.»), statement — книга ФО (лист «ОПиУ»). */
type FileKind = "daily" | "statement";

interface CachedFile {
  name: string;
  createTime: string;
  updateTime: string;
  ok: boolean;
  /** Нет — файл не открылся как .xlsx: считаем его неудачным ежедневным отчётом. */
  kind?: FileKind;
  error?: string;
  /** Файл не скачался (сеть, HTTP): на следующем запуске пробуем снова. */
  transient?: boolean;
  snapshot?: FinanceSnapshot;
}

interface FinanceCache {
  v: number;
  files: Record<string, CachedFile>;
  latest?: { fileId: string; report: FinanceReport };
  latestStatement?: { fileId: string; statement: FinanceIncomeStatement };
}

export interface LoadFinanceOptions {
  reader?: Pick<ReadOnlyBitrixClient, "listAllBatched">;
  folderId?: number | string;
  /** Локальный файл вместо папки чата (`--finance-file`). */
  localFile?: string;
  /** Несколько локальных файлов (`--finance-file` повторяется): ежедневный отчёт и книга ФО. */
  localFiles?: string[];
  cachePath?: string;
  /** Ключ шифрования кэша; по умолчанию REGISTER_HISTORY_KEY. */
  secretKey?: string;
  maxDownloads?: number;
  fetchFn?: typeof fetch;
}

type Parsed = { kind: "daily"; report: FinanceReport } | { kind: "statement"; statement: FinanceIncomeStatement };

/** Разбирает файл по его листам. У ошибки — тип файла, если книга открылась. */
async function parseFinanceBuffer(buffer: Buffer): Promise<Parsed> {
  const workbook = await readFinanceWorkbook(buffer);
  if (!isIncomeStatementWorkbook(workbook)) return { kind: "daily", report: parseFinanceWorkbook(workbook) };
  try {
    return { kind: "statement", statement: parseIncomeStatement(workbook) };
  } catch (err) {
    throw new StatementFileError(err);
  }
}

class StatementFileError extends Error {
  constructor(readonly original: unknown) {
    super("книга ФО не разобрана");
    this.name = "StatementFileError";
  }
}

const kindOfError = (err: unknown): FileKind | undefined => (err instanceof StatementFileError ? "statement" : undefined);

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
  if (err instanceof StatementFileError) return reasonOf(err.original);
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
  const view: FinanceView = { snapshots: snapshotsFrom(cache) };
  if (cache.latest) {
    view.report = cache.latest.report;
    view.file = fileInfo(cache, cache.latest.fileId);
  }
  if (cache.latestStatement) {
    view.statement = cache.latestStatement.statement;
    view.statementFile = fileInfo(cache, cache.latestStatement.fileId);
  }
  return view;
}

const statementLog = (st?: FinanceIncomeStatement) =>
  st ? `, ОПиУ из книги ФО: статей ${st.lines.length}, с расшифровкой ${st.lines.filter((x) => x.breakdown).length}, предупреждений сверки ${st.warnings.length}` : "";

async function loadLocalFiles(files: string[]): Promise<FinanceView> {
  const view: FinanceView = { snapshots: [] };
  const dailyErrors: string[] = [];
  const statementNames: string[] = [];
  for (const file of files) {
    const name = path.basename(file);
    const uploadedAt = () => fs.statSync(file).mtime.toISOString();
    try {
      const parsed = await parseFinanceBuffer(fs.readFileSync(file));
      if (parsed.kind === "statement") {
        statementNames.push(name);
        if (!view.statement) {
          view.statement = parsed.statement;
          view.statementFile = { id: "local-fo", name, uploadedAt: uploadedAt() };
        }
      } else if (!view.report) {
        view.report = parsed.report;
        view.file = { id: "local", name, uploadedAt: uploadedAt() };
        view.snapshots = [financeSnapshot(parsed.report)];
      }
    } catch (err) {
      if (kindOfError(err) === "statement") {
        statementNames.push(name);
        if (!view.statementNotice) view.statementNotice = `Книга ФО «${name}» не разобрана: ${reasonOf(err)}.`;
      } else {
        dailyErrors.push(`Файл «${name}» не разобран: ${reasonOf(err)}`);
      }
    }
  }
  if (view.statement) delete view.statementNotice;
  if (view.report) {
    console.log(`[Финансы] Локальный файл: отчёт на ${view.report.dataDate}, предупреждений сверки ${view.report.warnings.length}${statementLog(view.statement)}`);
  } else {
    view.error = dailyErrors[0] ?? `Среди локальных файлов нет ежедневного отчёта: только книга ФО «${statementNames[0]}».`;
  }
  return view;
}

export async function loadFinanceView(options: LoadFinanceOptions): Promise<FinanceView> {
  const locals = [...(options.localFiles ?? []), ...(options.localFile ? [options.localFile] : [])];
  if (locals.length) return loadLocalFiles(locals);
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
  if (cache.latestStatement && !present.has(cache.latestStatement.fileId)) delete cache.latestStatement;

  // Без ключа кэша нет: разбираем свежие файлы, пока не прочитается ежедневный отчёт.
  const budget = key ? options.maxDownloads ?? DEFAULT_MAX_DOWNLOADS : 3;
  const reports = new Map<string, FinanceReport>();
  const statements = new Map<string, FinanceIncomeStatement>();
  let downloads = 0;
  let failed = 0;
  const entryOf = (f: DiskItem) => cache.files[String(f.ID)];
  const isStatement = (f: DiskItem) => entryOf(f)?.kind === "statement";
  const dailyFound = () => files.some((f) => entryOf(f)?.ok && !isStatement(f));

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
      const parsed = await parseFinanceBuffer(buffer);
      entry.ok = true;
      entry.kind = parsed.kind;
      if (parsed.kind === "statement") {
        statements.set(id, parsed.statement);
      } else {
        entry.snapshot = financeSnapshot(parsed.report);
        reports.set(id, parsed.report);
      }
    } catch (err) {
      entry.error = reasonOf(err);
      const kind = kindOfError(err);
      if (kind) entry.kind = kind;
      if (!downloaded) entry.transient = true;
      failed++;
    }
    cache.files[id] = entry;
  };

  for (const f of files) {
    const cached = entryOf(f);
    if (cached && !cached.transient && cached.updateTime === (f.UPDATE_TIME ?? "")) {
      if (!key && dailyFound()) break;
      continue;
    }
    if (downloads >= budget) break;
    await parseFile(f);
    if (!key && dailyFound()) break;
  }

  // Свежий разобранный файл своего типа; если в кэше другой — скачиваем и разбираем его заново.
  const newestOkDaily = files.find((f) => entryOf(f)?.ok && !isStatement(f));
  if (!newestOkDaily) {
    delete cache.latest;
  } else {
    const id = String(newestOkDaily.ID);
    if (cache.latest?.fileId !== id) {
      if (!reports.has(id)) await parseFile(newestOkDaily);
      const report = reports.get(id);
      if (report) cache.latest = { fileId: id, report };
    } else if (reports.has(id)) {
      cache.latest = { fileId: id, report: reports.get(id)! };
    }
  }
  const newestOkStatement = files.find((f) => entryOf(f)?.ok && isStatement(f));
  if (!newestOkStatement) {
    delete cache.latestStatement;
  } else {
    const id = String(newestOkStatement.ID);
    if (cache.latestStatement?.fileId !== id || statements.has(id)) {
      if (!statements.has(id)) await parseFile(newestOkStatement);
      const statement = statements.get(id);
      if (statement) cache.latestStatement = { fileId: id, statement };
    }
  }
  if (key) writeCache(cachePath, key, cache);

  const view = viewFromCache(cache);
  // Пояснение — только про самый свежий файл своего типа: книга ФО не прячет ежедневный отчёт.
  const newestDaily = files.find((f) => !isStatement(f));
  const newestEntry = newestDaily ? entryOf(newestDaily) : undefined;
  if (newestEntry && !newestEntry.ok) {
    const shown = view.file ? ` Показан отчёт из файла «${view.file.name}» (${formatAlmaty(view.file.uploadedAt)}).` : "";
    view.notice = `Последний файл «${newestEntry.name}» (${formatAlmaty(newestEntry.createTime)}) не разобран: ${newestEntry.error}.${shown}`;
  }
  const newestStatement = files.find(isStatement);
  const statementEntry = newestStatement ? entryOf(newestStatement) : undefined;
  if (statementEntry && !statementEntry.ok) {
    const shown = view.statementFile ? ` Показан ОПиУ из «${view.statementFile.name}» (${formatAlmaty(view.statementFile.uploadedAt)}).` : "";
    view.statementNotice = `Последняя книга ФО «${statementEntry.name}» (${formatAlmaty(statementEntry.createTime)}) не разобрана: ${statementEntry.error}.${shown}`;
  }
  if (!view.report) {
    view.error = newestDaily
      ? "В чате «Финансовый отчет» нет файла, который удалось разобрать."
      : files.length
        ? "В чате «Финансовый отчет» нет ежедневного отчёта — только книга ФО."
        : "В чате «Финансовый отчет» пока нет ни одного .xlsx.";
  }

  const pending = key ? files.filter((f) => {
    const entry = entryOf(f);
    return !entry || entry.transient || entry.updateTime !== (f.UPDATE_TIME ?? "");
  }).length : 0;
  console.log(
    `[Финансы] Файлов в чате: ${files.length}, разобрано сейчас: ${downloads}` +
      (failed ? `, не разобрано: ${failed}` : "") +
      (pending ? `, ждут разбора: ${pending}` : "") +
      (view.report ? `, отчёт на ${view.report.dataDate}, предупреждений сверки ${view.report.warnings.length}` : ", отчёта нет") +
      statementLog(view.statement) +
      `, дней в истории: ${view.snapshots.length}` +
      (key ? "" : " (без ключа кэша истории нет)")
  );
  return view;
}
