// Финансовые отчёты из чата Битрикс24 («Финансовый отчет»):
// финансист кладёт в тот же чат разные .xlsx-файлы — ежедневный отчёт («Ежед.»),
// отчёт о прибылях и убытках («ОПиУ» + «Расш. ОПиУ») и отчёт о реализации («Клиент-ТМЦ» / «ТМЦ-Клиент»).
// Пульт сам определяет тип каждого файла, хранит историю ежедневных отчётов и берёт
// самый свежий файл каждого типа. Кэш (data/register/finance.json) зашифрован REGISTER_HISTORY_KEY.
// В лог не пишем ни сумм, ни названий из файла: лог Actions публичный.

import fs from "node:fs";
import path from "node:path";
import type { ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";
import { decryptPayload, encryptPayload } from "../register/crypto.js";
import { classifyFinanceWorkbook, type FinanceWorkbookKind } from "./classifyWorkbook.js";
import { OpiuParseError, parseOpiuExcelAll } from "./parseOpiu.js";
import { deriveOppositeRealization, parseRealizationExcel, RealizationParseError } from "./parseRealization.js";
import { FinanceParseError, financeSnapshot, parseFinanceExcel } from "./parseReport.js";
import type { OpiuReport, OpiuView } from "./opiuTypes.js";
import type { RealizationKind, RealizationReport, RealizationView } from "./realizationTypes.js";
import type { FinanceFileInfo, FinanceReport, FinanceSnapshot, FinanceView } from "./types.js";

export const DEFAULT_FINANCE_CACHE_PATH = "data/register/finance.json";

/** Повышать, когда меняется разбор: файлы из кэша тогда разбираются заново. */
// 2 — скрытые пустые колонки между банками и листы материальных ведомостей.
// 3 — новые колонки дебиторов (дата оплаты, иск) и сдвинутые «Прочие платежи» / «Топ» (20.11.2026).
// 4 — книга ФО (ОПиУ) в том же чате (26.11.2026).
// 5 — 2-уровневый ОПиУ на отдельной вкладке «Фин. отчёты» и Отчёт о реализации (Клиент-ТМЦ / ТМЦ-Клиент) в «Финансах».
// 6 — две итоговые строки перед списком дебиторов («Вся сумма» + «1210», 27.11.2026).
// 7 — несколько компаний в одной книге ОПиУ («ОПиУ» + «ОПиУ_*» с парными расшифровками, 27.11.2026).
export const FINANCE_PARSE_VERSION = 7;

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
  kind?: FinanceWorkbookKind;
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
  latestOpiu?: { fileId: string; reports: OpiuReport[] };
  latestRealizationClientTmc?: { fileId: string; report: RealizationReport };
  latestRealizationTmcClient?: { fileId: string; report: RealizationReport };
}

export interface LoadFinanceOptions {
  reader?: Pick<ReadOnlyBitrixClient, "listAllBatched">;
  folderId?: number | string;
  /** Локальный ежедневный отчёт вместо папки чата (`--finance-file`). */
  localFile?: string;
  /** Несколько локальных файлов (`--finance-file` можно повторить: Ежед., ОПиУ, ОР — тип решает содержимое). */
  localFiles?: string[];
  /** Локальный файл ОПиУ (`--opiu-file`). */
  localOpiuFile?: string;
  /** Локальные файлы отчёта о реализации (`--realization-file`, можно несколько). */
  localRealizationFiles?: string[];
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
  if (err instanceof FinanceParseError || err instanceof OpiuParseError || err instanceof RealizationParseError) {
    return err.message;
  }
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

function buildRealizationView(
  clientTmc: { report: RealizationReport; file?: FinanceFileInfo } | undefined,
  tmcClient: { report: RealizationReport; file?: FinanceFileInfo } | undefined,
  notice?: string
): RealizationView | undefined {
  if (!clientTmc && !tmcClient && !notice) return undefined;
  const files: Partial<Record<RealizationKind, FinanceFileInfo>> = {};
  if (clientTmc?.file) files["client-tmc"] = clientTmc.file;
  if (tmcClient?.file) files["tmc-client"] = tmcClient.file;
  const finalClientTmc = clientTmc?.report ?? (tmcClient ? deriveOppositeRealization(tmcClient.report) : undefined);
  const finalTmcClient = tmcClient?.report ?? (clientTmc ? deriveOppositeRealization(clientTmc.report) : undefined);
  return {
    ...(finalClientTmc ? { clientTmc: finalClientTmc } : {}),
    ...(finalTmcClient ? { tmcClient: finalTmcClient } : {}),
    files,
    ...(notice ? { notice } : {})
  };
}

function viewFromCache(cache: FinanceCache): FinanceView {
  const realization = buildRealizationView(
    cache.latestRealizationClientTmc
      ? { report: cache.latestRealizationClientTmc.report, file: fileInfo(cache, cache.latestRealizationClientTmc.fileId) }
      : undefined,
    cache.latestRealizationTmcClient
      ? { report: cache.latestRealizationTmcClient.report, file: fileInfo(cache, cache.latestRealizationTmcClient.fileId) }
      : undefined
  );
  const opiuReportsList = cache.latestOpiu?.reports ?? [];
  const opiu: OpiuView | undefined = cache.latestOpiu && opiuReportsList.length
    ? { report: opiuReportsList[0], reports: opiuReportsList, file: fileInfo(cache, cache.latestOpiu.fileId) }
    : undefined;

  return {
    ...(cache.latest ? { report: cache.latest.report, file: fileInfo(cache, cache.latest.fileId) } : {}),
    snapshots: snapshotsFrom(cache),
    ...(realization ? { realization } : {}),
    ...(opiu ? { opiu } : {})
  };
}

async function loadLocalOpiu(filePath: string): Promise<OpiuView> {
  const name = path.basename(filePath);
  try {
    const reports = await parseOpiuExcelAll(fs.readFileSync(filePath));
    const uploadedAt = fs.statSync(filePath).mtime.toISOString();
    const totalWarnings = reports.reduce((s, r) => s + r.warnings.length, 0);
    const totalBreakdowns = reports.reduce((s, r) => s + Object.keys(r.breakdowns).length, 0);
    console.log(`[Фин. отчёты] Локальный ОПиУ: компаний ${reports.length}, период ${reports[0].periodLabel}, расшифровок ${totalBreakdowns}, предупреждений ${totalWarnings}`);
    return { report: reports[0], reports, file: { id: "local-opiu", name, uploadedAt } };
  } catch (err) {
    return { error: `Файл «${name}» не разобран: ${reasonOf(err)}` };
  }
}

function loadLocalRealizations(filePaths: string[]): RealizationView | undefined {
  if (!filePaths.length) return undefined;
  let clientTmc: { report: RealizationReport; file: FinanceFileInfo } | undefined;
  let tmcClient: { report: RealizationReport; file: FinanceFileInfo } | undefined;
  const notices: string[] = [];

  for (const [idx, fp] of filePaths.entries()) {
    const name = path.basename(fp);
    try {
      const report = parseRealizationExcel(fs.readFileSync(fp));
      const uploadedAt = fs.statSync(fp).mtime.toISOString();
      const info: FinanceFileInfo = { id: `local-real-${idx + 1}`, name, uploadedAt };
      if (report.kind === "client-tmc") clientTmc = { report, file: info };
      else tmcClient = { report, file: info };
      console.log(`[Финансы] Локальный отчёт о реализации (${report.kind}): позиций верхнего уровня ${report.nodes.length}, предупреждений ${report.warnings.length}`);
    } catch (err) {
      notices.push(`Файл «${name}» не разобран: ${reasonOf(err)}`);
    }
  }
  return buildRealizationView(clientTmc, tmcClient, notices.length ? notices.join(" ") : undefined);
}

const isDailyEntry = (e: CachedFile | undefined) => !e?.kind || e.kind === "daily";

export async function loadFinanceView(options: LoadFinanceOptions): Promise<FinanceView> {
  // Поддержка повторяемого --finance-file (localFiles): автоматически раскладываем по видам.
  let dailyPath = options.localFile;
  let opiuPath = options.localOpiuFile;
  const realPaths = [...(options.localRealizationFiles ?? [])];
  for (const fp of options.localFiles ?? []) {
    try {
      const kind = classifyFinanceWorkbook(fs.readFileSync(fp));
      if (kind === "opiu") {
        if (!opiuPath) opiuPath = fp;
      } else if (kind === "realization-client-tmc" || kind === "realization-tmc-client") {
        realPaths.push(fp);
      } else {
        if (!dailyPath) dailyPath = fp;
      }
    } catch {
      if (!dailyPath) dailyPath = fp;
    }
  }

  const localOpiu = opiuPath ? await loadLocalOpiu(opiuPath) : undefined;
  const localRealization = realPaths.length ? loadLocalRealizations(realPaths) : undefined;

  if (dailyPath) {
    const name = path.basename(dailyPath);
    try {
      const report = await parseFinanceExcel(fs.readFileSync(dailyPath));
      const uploadedAt = fs.statSync(dailyPath).mtime.toISOString();
      console.log(`[Финансы] Локальный файл: отчёт на ${report.dataDate}, предупреждений сверки ${report.warnings.length}`);
      return {
        report,
        file: { id: "local", name, uploadedAt },
        snapshots: [financeSnapshot(report)],
        ...(localRealization ? { realization: localRealization } : {}),
        ...(localOpiu ? { opiu: localOpiu } : {})
      };
    } catch (err) {
      return {
        snapshots: [],
        error: `Файл «${name}» не разобран: ${reasonOf(err)}`,
        ...(localRealization ? { realization: localRealization } : {}),
        ...(localOpiu ? { opiu: localOpiu } : {})
      };
    }
  }

  if (!options.folderId || !options.reader) {
    const base: FinanceView = {
      snapshots: [],
      error: "Финансовый отчёт не подключён: не задана папка чата (finance.diskFolderId в config/sales-pult.json)",
      ...(localRealization ? { realization: localRealization } : {}),
      ...(localOpiu ? { opiu: localOpiu } : {})
    };
    return base;
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
    if (localOpiu) view.opiu = localOpiu;
    if (localRealization) view.realization = localRealization;
    return view.report
      ? { ...view, notice: "Не удалось прочитать папку чата в Битрикс24, показан последний сохранённый отчёт." }
      : { ...view, error: "Не удалось прочитать папку чата «Финансовый отчет» в Битрикс24." };
  }

  const files = listing.filter((f) => f.TYPE === "file" && /\.xlsx$/i.test(String(f.NAME))).sort(newestFirst);
  const present = new Set(files.map((f) => String(f.ID)));
  for (const id of Object.keys(cache.files)) if (!present.has(id)) delete cache.files[id];
  if (cache.latest && !present.has(cache.latest.fileId)) delete cache.latest;
  if (cache.latestOpiu && !present.has(cache.latestOpiu.fileId)) delete cache.latestOpiu;
  if (cache.latestRealizationClientTmc && !present.has(cache.latestRealizationClientTmc.fileId)) {
    delete cache.latestRealizationClientTmc;
  }
  if (cache.latestRealizationTmcClient && !present.has(cache.latestRealizationTmcClient.fileId)) {
    delete cache.latestRealizationTmcClient;
  }

  // Без ключа кэша нет: разбираем только свежие файлы, пока не найдём ежедневный отчёт.
  const budget = key ? options.maxDownloads ?? DEFAULT_MAX_DOWNLOADS : 3;
  const dailyReports = new Map<string, FinanceReport>();
  const opiuReports = new Map<string, OpiuReport[]>();
  const realClientTmcReports = new Map<string, RealizationReport>();
  const realTmcClientReports = new Map<string, RealizationReport>();
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

      const kind = classifyFinanceWorkbook(buffer);
      entry.kind = kind;

      if (kind === "opiu") {
        const reports = await parseOpiuExcelAll(buffer);
        entry.ok = true;
        opiuReports.set(id, reports);
      } else if (kind === "realization-client-tmc") {
        const report = parseRealizationExcel(buffer);
        entry.ok = true;
        realClientTmcReports.set(id, report);
      } else if (kind === "realization-tmc-client") {
        const report = parseRealizationExcel(buffer);
        entry.ok = true;
        realTmcClientReports.set(id, report);
      } else {
        const report = await parseFinanceExcel(buffer);
        entry.kind = "daily";
        entry.ok = true;
        entry.snapshot = financeSnapshot(report);
        dailyReports.set(id, report);
      }
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
      if (!key && cached.ok && isDailyEntry(cached)) break;
      continue;
    }
    if (downloads >= budget) break;
    await parseFile(f);
    const parsed = cache.files[String(f.ID)];
    if (!key && parsed.ok && isDailyEntry(parsed)) break;
  }

  // 1. Самый свежий ежедневный отчёт
  const newestDailyOk = files.find((f) => {
    const e = cache.files[String(f.ID)];
    return e?.ok && isDailyEntry(e);
  });
  if (!newestDailyOk) {
    delete cache.latest;
  } else {
    const id = String(newestDailyOk.ID);
    if (cache.latest?.fileId !== id) {
      if (!dailyReports.has(id)) await parseFile(newestDailyOk);
      const report = dailyReports.get(id);
      if (report) cache.latest = { fileId: id, report };
    } else if (dailyReports.has(id)) {
      cache.latest = { fileId: id, report: dailyReports.get(id)! };
    }
  }

  // 2. Самый свежий ОПиУ
  const newestOpiuOk = files.find((f) => {
    const e = cache.files[String(f.ID)];
    return e?.ok && e.kind === "opiu";
  });
  if (!newestOpiuOk) {
    delete cache.latestOpiu;
  } else {
    const id = String(newestOpiuOk.ID);
    if (cache.latestOpiu?.fileId !== id) {
      if (!opiuReports.has(id)) await parseFile(newestOpiuOk);
      const reports = opiuReports.get(id);
      if (reports?.length) cache.latestOpiu = { fileId: id, reports };
    } else if (opiuReports.has(id)) {
      cache.latestOpiu = { fileId: id, reports: opiuReports.get(id)! };
    }
  }

  // 3. Самые свежие отчёты о реализации (оба разреза)
  const syncRealization = async (
    targetKind: "realization-client-tmc" | "realization-tmc-client",
    map: Map<string, RealizationReport>,
    slot: "latestRealizationClientTmc" | "latestRealizationTmcClient"
  ) => {
    const found = files.find((f) => {
      const e = cache.files[String(f.ID)];
      return e?.ok && e.kind === targetKind;
    });
    if (!found) {
      delete cache[slot];
      return;
    }
    const id = String(found.ID);
    if (cache[slot]?.fileId !== id) {
      if (!map.has(id)) await parseFile(found);
      const report = map.get(id);
      if (report) cache[slot] = { fileId: id, report };
    } else if (map.has(id)) {
      cache[slot] = { fileId: id, report: map.get(id)! };
    }
  };
  await syncRealization("realization-client-tmc", realClientTmcReports, "latestRealizationClientTmc");
  await syncRealization("realization-tmc-client", realTmcClientReports, "latestRealizationTmcClient");

  if (key) writeCache(cachePath, key, cache);

  const view = viewFromCache(cache);

  // Предупреждение о битом последнем файле (касается только ежедневных / нераспознанных файлов, не ОПиУ/ОР)
  const newestDailyAttempt = files.find((f) => {
    const e = cache.files[String(f.ID)];
    return e && (!e.kind || e.kind === "daily" || e.kind === "unknown");
  });
  const newestEntry = newestDailyAttempt ? cache.files[String(newestDailyAttempt.ID)] : undefined;
  if (newestDailyAttempt && newestEntry && !newestEntry.ok) {
    const shown = view.file ? ` Показан отчёт из файла «${view.file.name}» (${formatAlmaty(view.file.uploadedAt)}).` : "";
    view.notice = `Последний файл «${newestEntry.name}» (${formatAlmaty(newestEntry.createTime)}) не разобран: ${newestEntry.error}.${shown}`;
  }

  // Предупреждение о битом последнем ОПиУ
  const newestOpiuAttempt = files.find((f) => cache.files[String(f.ID)]?.kind === "opiu");
  const newestOpiuEntry = newestOpiuAttempt ? cache.files[String(newestOpiuAttempt.ID)] : undefined;
  if (newestOpiuAttempt && newestOpiuEntry && !newestOpiuEntry.ok) {
    const shown = view.opiu?.file ? ` Показан прошлый ОПиУ из «${view.opiu.file.name}» (${formatAlmaty(view.opiu.file.uploadedAt)}).` : "";
    view.opiu = {
      ...(view.opiu ?? {}),
      notice: `Последний файл ОПиУ «${newestOpiuEntry.name}» (${formatAlmaty(newestOpiuEntry.createTime)}) не разобран: ${newestOpiuEntry.error}.${shown}`
    };
  }

  if (!view.report) {
    view.error = files.length
      ? "В чате «Финансовый отчет» нет файла, который удалось разобрать."
      : "В чате «Финансовый отчет» пока нет ни одного .xlsx.";
  }

  // Локальные файлы поверх данных из папки (для ручной проверки)
  if (localOpiu) view.opiu = localOpiu;
  if (localRealization) view.realization = localRealization;

  const pending = key
    ? files.filter((f) => {
        const entry = cache.files[String(f.ID)];
        return !entry || entry.transient || entry.updateTime !== (f.UPDATE_TIME ?? "");
      }).length
    : 0;
  console.log(
    `[Финансы] Файлов в чате: ${files.length}, разобрано сейчас: ${downloads}` +
      (failed ? `, не разобрано: ${failed}` : "") +
      (pending ? `, ждут разбора: ${pending}` : "") +
      (view.report ? `, отчёт на ${view.report.dataDate}, предупреждений сверки ${view.report.warnings.length}` : ", отчёта нет") +
      (view.opiu?.reports?.length
        ? `, ОПиУ: ${view.opiu.reports.length} комп., ${view.opiu.reports[0].periodLabel}`
        : view.opiu?.report
          ? `, ОПиУ: ${view.opiu.report.periodLabel}`
          : "") +
      (view.realization ? `, ОР: ${[view.realization.clientTmc && !view.realization.clientTmc.derived ? "Клиент-ТМЦ" : null, view.realization.tmcClient && !view.realization.tmcClient.derived ? "ТМЦ-Клиент" : null].filter(Boolean).join("+") || "авто"}` : "") +
      `, дней в истории: ${view.snapshots.length}` +
      (key ? "" : " (без ключа кэша истории нет)")
  );
  return view;
}
