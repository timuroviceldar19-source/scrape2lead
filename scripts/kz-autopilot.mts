import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { readBinsFromCsv } from "../src/kz/csv.js";
import { formatKzEnrichResult } from "../src/kz/enrichPipeline.js";
import { runKzEnrichWithFallbackRetry } from "../src/kz/autopilotEnrichRetry.js";
import { KzStorage } from "../src/kz/kzStorage.js";
import {
  computeOutreachDiff,
  diffToOutreachItems,
  finishOutreachRun,
  getLastCompletedRun,
  registerOutreachItems,
  startOutreachRun
} from "../src/kz/outreachDigest.js";
import { exportOutreachQueue, exportWinnersDigest } from "../src/kz/outreachExporter.js";
import { buildFactoringMessage } from "../src/kz/outreachMessages.js";
import {
  getTelegramConfigFromEnv,
  sendTelegramDocument,
  sendTelegramMessage
} from "../src/kz/telegramNotify.js";
import { acquireAutopilotLock, LockBusyError, type LockHandle } from "../src/kz/autopilotLock.js";

const DB_PATH = process.env.KZ_DATABASE_PATH ?? "data/scrape2lead.db";
const LOCK_PATH = process.env.KZ_AUTOPILOT_LOCK_PATH ?? "data/autopilot.lock";

const EXIT_OK = 0;
const EXIT_LOCK_BUSY = 2;
const EXIT_DB_ERROR = 3;
const EXIT_EXPORT_ERROR = 4;
const EXIT_INVALID_INPUT = 5;

interface AutopilotArgs {
  batchCsv: string;
  topACsv: string;
  outDir: string;
  dryRun: boolean;
  since: string | null;
  skipEnrich: boolean;
  progress: boolean;
  maxPages: number | null;
  baseline: boolean;
  enrichRetries: number;
  enrichRetryBaseMs: number;
  enrichDeadlineMs: number | null;
  includeClosed: boolean;
}

interface RunSummary {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  dryRun: boolean;
  baseline: boolean;
  enrichSkipped: boolean;
  bins: number;
  winners: number;
  prospects: number;
  registered: number;
  exportedFiles: string[];
  warnings: string[];
  zeroOutput: boolean;
  exitCode: number;
  exitReason: string;
  lockHeldBy: { pid: number; host: string; startedAt: string; command: string } | null;
  enrichMode: "batch" | "per-bin" | null;
  enrichBatchError: string | null;
  enrichRetryAttempts: number;
  enrichFailedBins: string[];
  includeClosed: boolean;
}

function exitReasonForCode(code: number): string {
  switch (code) {
    case EXIT_OK: return "ok";
    case EXIT_LOCK_BUSY: return "lock busy";
    case EXIT_DB_ERROR: return "db error";
    case EXIT_EXPORT_ERROR: return "export error";
    case EXIT_INVALID_INPUT: return "invalid input";
    default: return "unhandled error";
  }
}

function makeInitialSummary(startedAt: string, args: AutopilotArgs): RunSummary {
  return {
    startedAt,
    finishedAt: startedAt,
    elapsedMs: 0,
    dryRun: args.dryRun,
    baseline: false,
    enrichSkipped: args.skipEnrich,
    bins: 0,
    winners: 0,
    prospects: 0,
    registered: 0,
    exportedFiles: [],
    warnings: [],
    zeroOutput: false,
    exitCode: EXIT_OK,
    exitReason: "ok",
    lockHeldBy: null,
    enrichMode: null,
    enrichBatchError: null,
    enrichRetryAttempts: 0,
    enrichFailedBins: [],
    includeClosed: args.includeClosed
  };
}

function finalizeSummary(summary: RunSummary, startedAtMs: number): void {
  summary.finishedAt = new Date().toISOString();
  summary.elapsedMs = Date.now() - startedAtMs;
  if (process.exitCode !== undefined && process.exitCode !== summary.exitCode) {
    summary.exitCode = process.exitCode;
  }
  if (summary.exitReason === "ok" && summary.exitCode !== EXIT_OK) {
    summary.exitReason = exitReasonForCode(summary.exitCode);
  }
  summary.zeroOutput = summary.winners === 0 && summary.prospects === 0 && summary.warnings.length === 0;
}

function writeSummary(summary: RunSummary, outDir: string): void {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const date = summary.startedAt.slice(0, 10);
    const target = path.join(outDir, `autopilot-${date}.json`);
    fs.writeFileSync(target, JSON.stringify(summary, null, 2), "utf8");
    console.log(`summary: ${target}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`autopilot: не удалось записать summary JSON: ${message}`);
  }
}

function parseArgs(argv: string[]): AutopilotArgs {
  const readArg = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index === -1 || index + 1 >= argv.length) return null;
    return argv[index + 1] ?? null;
  };
  const maxPagesRaw = readArg("--max-pages");
  const maxPages = maxPagesRaw === null ? null : Number(maxPagesRaw);
  if (maxPages !== null && (!Number.isInteger(maxPages) || maxPages < 1)) {
    throw new Error(`--max-pages должен быть целым числом >= 1, получено: ${maxPagesRaw}`);
  }

  const enrichRetriesRaw = readArg("--enrich-retries");
  const enrichRetries = enrichRetriesRaw === null ? 1 : Number(enrichRetriesRaw);
  if (!Number.isInteger(enrichRetries) || enrichRetries < 0) {
    throw new Error(`--enrich-retries должен быть целым числом >= 0, получено: ${enrichRetriesRaw}`);
  }

  const enrichRetryBaseMsRaw = readArg("--enrich-retry-base-ms");
  const enrichRetryBaseMs = enrichRetryBaseMsRaw === null ? 2000 : Number(enrichRetryBaseMsRaw);
  if (!Number.isInteger(enrichRetryBaseMs) || enrichRetryBaseMs < 1) {
    throw new Error(`--enrich-retry-base-ms должен быть целым числом >= 1, получено: ${enrichRetryBaseMsRaw}`);
  }

  const enrichDeadlineMsRaw = readArg("--enrich-deadline-ms");
  const enrichDeadlineMs = enrichDeadlineMsRaw === null ? null : Number(enrichDeadlineMsRaw);
  if (enrichDeadlineMs !== null && (!Number.isInteger(enrichDeadlineMs) || enrichDeadlineMs < 1)) {
    throw new Error(`--enrich-deadline-ms должен быть целым числом >= 1, получено: ${enrichDeadlineMsRaw}`);
  }

  return {
    batchCsv: readArg("--batch-csv") ?? "bins-batch.csv",
    topACsv: readArg("--top-a-csv") ?? "bins-top-a.csv",
    outDir: readArg("--out-dir") ?? "exports",
    dryRun: argv.includes("--dry-run"),
    since: readArg("--since"),
    skipEnrich: argv.includes("--skip-enrich"),
    progress: argv.includes("--progress"),
    maxPages,
    baseline: argv.includes("--baseline"),
    enrichRetries,
    enrichRetryBaseMs,
    enrichDeadlineMs,
    includeClosed: argv.includes("--include-closed")
  };
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function collectBins(args: AutopilotArgs): string[] {
  const bins = new Set<string>();
  for (const csvPath of [args.batchCsv, args.topACsv]) {
    if (!fs.existsSync(csvPath)) {
      console.warn(`autopilot: CSV не найден, пропускаю: ${csvPath}`);
      continue;
    }
    for (const bin of readBinsFromCsv(csvPath)) bins.add(bin);
  }
  return [...bins];
}

function datedPath(outDir: string, prefix: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(outDir, `${prefix}-${date}.xlsx`);
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const args = parseArgs(process.argv);
  const summary = makeInitialSummary(startedAt, args);

  let lock: LockHandle | null = null;
  try {
    lock = await acquireAutopilotLock({ lockPath: LOCK_PATH, command: "kz-autopilot" });
  } catch (err) {
    if (err instanceof LockBusyError) {
      process.exitCode = EXIT_LOCK_BUSY;
      summary.exitCode = EXIT_LOCK_BUSY;
      summary.exitReason = "lock busy";
      summary.lockHeldBy = err.contents;
      console.error(err.message);
      finalizeSummary(summary, startedAtMs);
      writeSummary(summary, args.outDir);
      return;
    }
    throw err;
  }

  try {
    await runPipeline(args, summary, startedAtMs);
  } catch (err) {
    if (process.exitCode === 0) {
      process.exitCode = 1;
      summary.exitCode = 1;
      summary.exitReason = "unhandled error";
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`autopilot: ${message}`);
  } finally {
    finalizeSummary(summary, startedAtMs);
    writeSummary(summary, args.outDir);
    if (lock) await lock.release();
  }
}

async function runPipeline(args: AutopilotArgs, summary: RunSummary, startedAtMs: number): Promise<void> {
  const bins = collectBins(args);
  summary.bins = bins.length;
  if (bins.length === 0) {
    process.exitCode = EXIT_INVALID_INPUT;
    throw new Error(`Нет БИНов: проверь ${args.batchCsv} / ${args.topACsv}`);
  }
  console.log(
    `autopilot: ${bins.length} БИНов, dry-run=${args.dryRun}, since=${args.since ?? "-"}, `
    + `include-closed=${args.includeClosed}, `
    + `max-pages=${args.maxPages ?? process.env.GOSZAKUP_HTML_MAX_PAGES ?? 50}`
  );

  const warnings = summary.warnings;

  if (!args.skipEnrich) {
    console.warn(
      "warning: enrich uses visible browser (stat.gov); "
      + "scheduler should run only when user is logged on, or use --skip-enrich"
    );
    const enrichStartedAt = Date.now();
    try {
      const enrich = await runKzEnrichWithFallbackRetry({
        bins,
        databasePath: DB_PATH,
        goszakupMaxPages: args.maxPages ?? undefined,
        retries: args.enrichRetries,
        baseDelayMs: args.enrichRetryBaseMs,
        deadlineMs: args.enrichDeadlineMs ?? undefined,
        onProgress: args.progress
          ? (stage, index, total, bin) => {
              console.log(`enrich [${stage}] ${index}/${total} BIN=${bin} elapsed=${formatElapsed(Date.now() - enrichStartedAt)}`);
            }
          : undefined
      });
      summary.enrichMode = enrich.enrichMode;
      summary.enrichBatchError = enrich.enrichBatchError ?? null;
      summary.enrichRetryAttempts = enrich.enrichRetryAttempts;
      summary.enrichFailedBins = enrich.enrichFailedBins;
      if (enrich.enrichMode === "per-bin") {
        warnings.push(`enrich: batch failed (${enrich.enrichBatchError}), switched to per-bin fallback`);
        if (enrich.enrichFailedBins.length > 0) {
          warnings.push(`enrich: ${enrich.enrichFailedBins.length} BIN(s) failed in per-bin fallback: ${enrich.enrichFailedBins.join(", ")}`);
        }
      }
      if (args.progress) {
        console.log(formatKzEnrichResult(enrich));
      } else {
        console.log(
          `enrich: mode=${enrich.enrichMode} stat=${enrich.stat ? `${enrich.stat.success}+${enrich.stat.cached}cached` : "skipped"} `
          + `registry=${enrich.registry ? `${enrich.registry.success}+${enrich.registry.cached}cached` : "skipped"} `
          + `tenders=${enrich.tenders?.totalTenders ?? "-"} `
          + `failedBins=${enrich.enrichFailedBins.length} retryAttempts=${enrich.enrichRetryAttempts}`
        );
      }
      if (enrich.stat && enrich.stat.failed > 0) {
        warnings.push(`stat.gov: ${enrich.stat.failed} БИНов не обновились (проверь QR-сессию: npm run kz:login)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`enrich упал, дифф по данным в базе: ${message}`);
      console.warn(`autopilot: enrich failed, continuing with stale data: ${message}`);
    }
  } else {
    console.log("autopilot: enrich пропущен (--skip-enrich)");
  }

  const db = new Database(DB_PATH);
  const storage = new KzStorage({ db });
  try {
    const lastRun = getLastCompletedRun(db);
    const baseline = args.baseline || (!lastRun && !args.since);
    summary.baseline = baseline;

    let diff;
    try {
      diff = computeOutreachDiff(db, {
        bins,
        since: args.since ?? undefined,
        includeClosed: args.includeClosed
      });
    } catch (err) {
      process.exitCode = EXIT_DB_ERROR;
      throw err;
    }
    const items = diffToOutreachItems(diff);
    summary.winners = diff.winners.length;
    summary.prospects = diff.prospects.length;
    console.log(`diff: winners=${diff.winners.length} prospects=${diff.prospects.length}`);

    if (baseline) {
      if (!args.dryRun) {
        try {
          const runId = startOutreachRun(db);
          const registered = registerOutreachItems(db, runId, items);
          finishOutreachRun(db, runId, { baseline: true, registered });
          summary.registered = registered;
          console.log(`baseline: зафиксировано ${registered} записей, экспорт не делаю.`);
          console.log("Следующий запуск выдаст только новое.");
        } catch (err) {
          process.exitCode = EXIT_DB_ERROR;
          throw err;
        }
      } else {
        console.log("baseline + dry-run: ничего не записано.");
      }
      return;
    }

    const winnersPath = datedPath(args.outDir, "digest-winners");
    const queuePath = datedPath(args.outDir, "outreach-queue");
    const exportedFiles = summary.exportedFiles;

    if (diff.winners.length > 0) {
      try {
        const winnersResult = await exportWinnersDigest(diff.winners, winnersPath);
        exportedFiles.push(winnersResult.xlsxPath);
        console.log(`winners: ${winnersResult.winners} (${winnersResult.withPhone} с телефоном) → ${winnersResult.xlsxPath}`);
      } catch (err) {
        process.exitCode = EXIT_EXPORT_ERROR;
        throw err;
      }
    } else {
      console.log("winners: новых нет");
    }

    if (diff.prospects.length > 0) {
      try {
        const queueResult = await exportOutreachQueue(diff.prospects, queuePath);
        exportedFiles.push(queueResult.xlsxPath);
        console.log(`queue: ${queueResult.companies} (${queueResult.withPhone} с телефоном) → ${queueResult.xlsxPath}`);
      } catch (err) {
        process.exitCode = EXIT_EXPORT_ERROR;
        throw err;
      }
    } else {
      console.log("queue: новых проспектов нет");
    }

    if (!args.dryRun) {
      try {
        const runId = startOutreachRun(db);
        const registered = registerOutreachItems(db, runId, items);
        finishOutreachRun(db, runId, {
          winners: diff.winners.length,
          prospects: diff.prospects.length,
          registered,
          warnings
        });
        summary.registered = registered;
        console.log(`run #${runId}: зарегистрировано ${registered} записей`);
      } catch (err) {
        process.exitCode = EXIT_DB_ERROR;
        throw err;
      }
    } else {
      console.log("dry-run: outreach_items не записаны, файлы сгенерированы для просмотра.");
    }

    if (!args.dryRun) {
      const isZeroOutput = diff.winners.length === 0 && diff.prospects.length === 0 && warnings.length === 0;
      await notifyTelegram(diff.winners.length, diff.prospects.length, exportedFiles, warnings, isZeroOutput);
    }
  } finally {
    storage.close();
    db.close();
  }
}

async function notifyTelegram(
  winners: number,
  prospects: number,
  files: string[],
  warnings: string[],
  isZeroOutput: boolean
): Promise<void> {
  const config = getTelegramConfigFromEnv();
  if (!config) {
    console.warn("telegram: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы, уведомление пропущено");
    return;
  }
  try {
    const header = isZeroOutput
      ? "⚠️ Autopilot: 0 новых победителей и 0 проспектов — проверь enrich / --since / БИНы в CSV."
      : `Autopilot: ${winners} новых победителей, ${prospects} проспектов в очереди.`;
    const lines = [
      header,
      ...(warnings.length > 0 ? ["", `Warning: ${warnings.join("; ")}`] : []),
      ...(winners > 0 ? ["", "Черновик для факторинга:", buildFactoringMessage({ winnerCount: winners })] : [])
    ];
    await sendTelegramMessage(config, lines.join("\n"));
    for (const file of files) {
      await sendTelegramDocument(config, file, path.basename(file));
    }
    console.log(`telegram: отправлено (${files.length} файлов)`);
  } catch (error) {
    console.warn(`telegram: не удалось отправить: ${error instanceof Error ? error.message : error}`);
  }
}

main().catch((error) => {
  console.error(error);
  if (process.exitCode === 0 || process.exitCode === undefined) {
    process.exitCode = 1;
  }
});
