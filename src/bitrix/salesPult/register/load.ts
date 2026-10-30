import fs from "node:fs";
import path from "node:path";
import type { ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";
import type { StageTransition } from "../metrics.js";
import { toAlmatyDate } from "../metrics.js";
import type { UserProfileInfo } from "../collect.js";
import type { RegisterView, RegisterHistoryPayload } from "./types.js";
import {
  fetchLatestRegisterFromDisk,
  fetchRegisterFilesFromDisk,
  parseDateKeyFromFileName
} from "./diskClient.js";
import { parseRegisterExcel } from "./parseExcel.js";
import { groupRegisterContracts, matchRegisterWithCrm } from "./matchCrm.js";
import { fetchCrmWonDealsForRegister, fetchCrmWonDealsForMonths } from "./fetchCrmWon.js";
import { buildRegisterView } from "./buildView.js";
import {
  buildFullRegisterHistory,
  DEFAULT_REGISTER_HISTORY_PATH
} from "./history.js";
import {
  loadEncryptedRegisterHistory,
  saveEncryptedRegisterHistory,
  shouldRefreshRegisterHistory,
  recordRegisterHistoryAttempt,
  loadRegisterHistoryAttempt
} from "./crypto.js";

export function getAlmatyToday(now: Date = new Date()): string {
  return toAlmatyDate(now);
}

export interface LoadRegisterOptions {
  reader: ReadOnlyBitrixClient;
  diskFolderId?: number;
  managerAliases?: Record<string, string>;
  registerFilePath?: string;
  todayAlmaty?: string;
  contractTransitions?: StageTransition[];
  userProfiles?: Map<string, UserProfileInfo>;
  contractStages?: string[];
  refreshHistory?: boolean;
  historyCachePath?: string;
  cachePath?: string;
  attemptPath?: string;
  secretKey?: string;
  holidays?: string[];
  outcomesConfigPath?: string;
  orgsCachePath?: string;
  fetchPortal?: boolean;
}

export async function loadRegisterView(options: LoadRegisterOptions): Promise<RegisterView> {
  const {
    reader,
    diskFolderId,
    managerAliases,
    registerFilePath,
    todayAlmaty = getAlmatyToday(),
    contractTransitions,
    userProfiles,
    contractStages,
    refreshHistory,
    historyCachePath,
    holidays,
    outcomesConfigPath,
    orgsCachePath,
    fetchPortal
  } = options;

  let excelBuffer: Buffer | null = null;
  let registerFileName = "";
  let asOf = todayAlmaty;

  if (registerFilePath) {
    if (fs.existsSync(registerFilePath)) {
      excelBuffer = fs.readFileSync(registerFilePath);
      registerFileName = path.basename(registerFilePath);
    } else {
      return { error: `Файл не найден: ${registerFilePath}` };
    }
  } else if (diskFolderId) {
    try {
      const diskFile = await fetchLatestRegisterFromDisk(reader, diskFolderId);
      if (diskFile) {
        excelBuffer = diskFile.buffer;
        registerFileName = diskFile.fileName;
      } else {
        return { error: "Реестр не подключён: файл в папке не найден" };
      }
    } catch (diskErr) {
      return {
        error: `Реестр не подключён: ${diskErr instanceof Error ? diskErr.message : String(diskErr)}`
      };
    }
  } else {
    return { error: "Реестр не подключён: папка на Диске не настроена" };
  }

  if (!excelBuffer) {
    return { error: "Реестр не подключён: нет файла Excel" };
  }

  try {
    const parsed = await parseRegisterExcel(excelBuffer, registerFileName, managerAliases);
    asOf = parsed.asOf || todayAlmaty;
    const contracts = groupRegisterContracts(parsed.rows);

    const wonDeals = await fetchCrmWonDealsForRegister(
      reader,
      contractTransitions,
      userProfiles
    );

    const matchResult = matchRegisterWithCrm(contracts, wonDeals, {
      managerAliases
    });

    // History handling
    const cachePath = historyCachePath || options.cachePath || DEFAULT_REGISTER_HISTORY_PATH;
    const attemptPath = options.attemptPath || path.join(path.dirname(cachePath), "last_attempt.json");
    const secretKey = (options.secretKey || process.env.REGISTER_HISTORY_KEY)?.trim();
    let historyPayload: RegisterHistoryPayload | undefined;
    let historyError: string | undefined;

    const shouldRefresh = shouldRefreshRegisterHistory({
      cacheFilePath: cachePath,
      attemptFilePath: attemptPath,
      forceRefresh: refreshHistory
    });

    if (shouldRefresh) {
      if (!secretKey) {
        historyError = "История недоступна: не задан ключ кэша";
        console.warn("[Реестр] REGISTER_HISTORY_KEY не задан, пропуск построения истории");
      } else if (diskFolderId) {
        try {
          console.log("[Реестр] Построение истории реестра с Диска...");
          const filesResult = await fetchRegisterFilesFromDisk(reader, diskFolderId);
          const filesToProcess = filesResult;
          const failedFiles = filesResult.failedFiles || [];

          if (filesToProcess.length > 0) {
            // Collect all unique months from files for CRM won deals fetch
            const monthsSet = new Set<string>();
            for (const f of filesToProcess) {
              const d = parseDateKeyFromFileName(f.fileName);
              if (d && d >= "2026-07") monthsSet.add(d.slice(0, 7));
            }
            if (todayAlmaty && todayAlmaty >= "2026-07") {
              monthsSet.add(todayAlmaty.slice(0, 7));
            }
            const allMonths = Array.from(monthsSet).sort();

            const crmWonByMonth = await fetchCrmWonDealsForMonths(reader, userProfiles || new Map(), allMonths, {
              contractStages
            });

            historyPayload = await buildFullRegisterHistory({
              files: filesToProcess,
              managerAliases,
              todayAlmaty,
              crmWonDealsByMonth: crmWonByMonth,
              crmWonDeals: wonDeals,
              holidays: new Set(holidays || []),
              outcomesConfigPath,
              orgsCachePath,
              fetchPortal,
              failedFiles
            });

            if (historyPayload.portalMissing?.error) {
              throw new Error(historyPayload.portalMissing.error);
            }

            // Tag with cachedAt time
            const nowIso = new Date().toISOString();
            historyPayload.cachedAt = nowIso;

            saveEncryptedRegisterHistory(cachePath, historyPayload, secretKey);
            recordRegisterHistoryAttempt(attemptPath, { success: true });
            console.log(`[Реестр] Зашифрованная история сохранена: ${historyPayload.months.length} месяцев в ${cachePath}`);
          } else {
            const loaded = loadEncryptedRegisterHistory(cachePath, secretKey);
            historyPayload = loaded.payload;
            historyError = loaded.error;
          }
        } catch (histErr) {
          console.warn("[Реестр] Ошибка построения истории:", histErr);
          const errMsg = histErr instanceof Error ? histErr.message : String(histErr);
          recordRegisterHistoryAttempt(attemptPath, { success: false, error: errMsg });
          const loaded = loadEncryptedRegisterHistory(cachePath, secretKey);
          historyPayload = loaded.payload;
          historyError = `Ошибка построения истории: ${errMsg}${loaded.payload ? " (отображается кэш)" : ""}`;
          if (historyPayload) {
            historyPayload.error = historyError;
          }
        }
      } else {
        const loaded = loadEncryptedRegisterHistory(cachePath, secretKey);
        historyPayload = loaded.payload;
        historyError = loaded.error;

        const lastAttempt = loadRegisterHistoryAttempt(attemptPath);
        if (lastAttempt && !lastAttempt.success && lastAttempt.error) {
          const timeDiff = Date.now() - Date.parse(lastAttempt.timestamp);
          if (timeDiff < 3600000) {
            historyError = `Ошибка построения истории: ${lastAttempt.error}${historyPayload ? " (отображается кэш)" : ""}`;
            if (historyPayload) historyPayload.error = historyError;
          }
        }
      }
    } else {
      const loaded = loadEncryptedRegisterHistory(cachePath, secretKey);
      historyPayload = loaded.payload;
      historyError = loaded.error;

      const lastAttempt = loadRegisterHistoryAttempt(attemptPath);
      if (lastAttempt && !lastAttempt.success && lastAttempt.error) {
        const timeDiff = Date.now() - Date.parse(lastAttempt.timestamp);
        if (timeDiff < 3600000) {
          historyError = `Ошибка построения истории: ${lastAttempt.error}${historyPayload ? " (отображается кэш)" : ""}`;
          if (historyPayload) historyPayload.error = historyError;
        }
      }
    }

    // Attach cachedAt from file if not already set on payload
    if (historyPayload && !historyPayload.cachedAt && fs.existsSync(cachePath)) {
      try {
        historyPayload.cachedAt = fs.statSync(cachePath).mtime.toISOString();
      } catch {
        // ignore
      }
    }

    const view = buildRegisterView({
      rows: parsed.rows,
      plans: parsed.plans,
      missing: matchResult.missing,
      extraDealsCount: matchResult.extra.length,
      fileName: registerFileName,
      asOf,
      month: parsed.month || todayAlmaty.slice(0, 7),
      history: historyPayload,
      historyError
    });

    console.log(
      `[Реестр] строк: ${parsed.rows.length}, договоров: ${contracts.length}, найдено в CRM: ${matchResult.matched.length}, нет в CRM: ${matchResult.missing.length}`
    );

    return view;
  } catch (err) {
    console.error("[Реестр] Ошибка обработки реестра:", err);
    return {
      error: `Реестр не подключён: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
