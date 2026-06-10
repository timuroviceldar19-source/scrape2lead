import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { readBinsFromCsv } from "../src/kz/csv.js";
import { formatKzEnrichResult, runKzEnrich } from "../src/kz/enrichPipeline.js";
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

const DB_PATH = process.env.KZ_DATABASE_PATH ?? "data/scrape2lead.db";

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
  return {
    batchCsv: readArg("--batch-csv") ?? "bins-batch.csv",
    topACsv: readArg("--top-a-csv") ?? "bins-top-a.csv",
    outDir: readArg("--out-dir") ?? "exports",
    dryRun: argv.includes("--dry-run"),
    since: readArg("--since"),
    skipEnrich: argv.includes("--skip-enrich"),
    progress: argv.includes("--progress"),
    maxPages,
    baseline: argv.includes("--baseline")
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
  const args = parseArgs(process.argv);
  const bins = collectBins(args);
  if (bins.length === 0) {
    throw new Error(`Нет БИНов: проверь ${args.batchCsv} / ${args.topACsv}`);
  }
  console.log(
    `autopilot: ${bins.length} БИНов, dry-run=${args.dryRun}, since=${args.since ?? "-"}, `
    + `max-pages=${args.maxPages ?? process.env.GOSZAKUP_HTML_MAX_PAGES ?? 50}`
  );

  const warnings: string[] = [];

  if (!args.skipEnrich) {
    console.warn(
      "warning: enrich uses visible browser (stat.gov); "
      + "scheduler should run only when user is logged on, or use --skip-enrich"
    );
    const enrichStartedAt = Date.now();
    try {
      const enrich = await runKzEnrich({
        bins,
        databasePath: DB_PATH,
        skipZakup: true,
        goszakupMaxPages: args.maxPages ?? undefined,
        onProgress: args.progress
          ? (stage, index, total, bin) => {
              console.log(`enrich [${stage}] ${index}/${total} BIN=${bin} elapsed=${formatElapsed(Date.now() - enrichStartedAt)}`);
            }
          : undefined
      });
      if (args.progress) {
        console.log(formatKzEnrichResult(enrich));
      } else {
        console.log(
          `enrich: stat=${enrich.stat ? `${enrich.stat.success}+${enrich.stat.cached}cached` : "skipped"} `
          + `registry=${enrich.registry ? `${enrich.registry.success}+${enrich.registry.cached}cached` : "skipped"} `
          + `tenders=${enrich.tenders?.totalTenders ?? "-"}`
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

    const diff = computeOutreachDiff(db, { bins, since: args.since ?? undefined });
    const items = diffToOutreachItems(diff);
    console.log(`diff: winners=${diff.winners.length} prospects=${diff.prospects.length}`);

    if (baseline) {
      // Фиксируем текущее состояние как точку отсчёта: регистрируем без экспорта.
      // Срабатывает на первом запуске без --since или принудительно через --baseline.
      if (!args.dryRun) {
        const runId = startOutreachRun(db);
        const registered = registerOutreachItems(db, runId, items);
        finishOutreachRun(db, runId, { baseline: true, registered });
        console.log(`baseline: зафиксировано ${registered} записей, экспорт не делаю.`);
        console.log("Следующий запуск выдаст только новое.");
      } else {
        console.log("baseline + dry-run: ничего не записано.");
      }
      return;
    }

    const winnersPath = datedPath(args.outDir, "digest-winners");
    const queuePath = datedPath(args.outDir, "outreach-queue");
    const exportedFiles: string[] = [];

    let winnersResult = null;
    if (diff.winners.length > 0) {
      winnersResult = await exportWinnersDigest(diff.winners, winnersPath);
      exportedFiles.push(winnersResult.xlsxPath);
      console.log(`winners: ${winnersResult.winners} (${winnersResult.withPhone} с телефоном) → ${winnersResult.xlsxPath}`);
    } else {
      console.log("winners: новых нет");
    }

    let queueResult = null;
    if (diff.prospects.length > 0) {
      queueResult = await exportOutreachQueue(diff.prospects, queuePath);
      exportedFiles.push(queueResult.xlsxPath);
      console.log(`queue: ${queueResult.companies} (${queueResult.withPhone} с телефоном) → ${queueResult.xlsxPath}`);
    } else {
      console.log("queue: новых проспектов нет");
    }

    if (!args.dryRun) {
      const runId = startOutreachRun(db);
      const registered = registerOutreachItems(db, runId, items);
      finishOutreachRun(db, runId, {
        winners: diff.winners.length,
        prospects: diff.prospects.length,
        registered,
        warnings
      });
      console.log(`run #${runId}: зарегистрировано ${registered} записей`);
    } else {
      console.log("dry-run: outreach_items не записаны, файлы сгенерированы для просмотра.");
    }

    if (!args.dryRun) {
      await notifyTelegram(diff.winners.length, diff.prospects.length, exportedFiles, warnings);
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
  warnings: string[]
): Promise<void> {
  const config = getTelegramConfigFromEnv();
  if (!config) {
    console.warn("telegram: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы, уведомление пропущено");
    return;
  }
  try {
    const lines = [
      `Autopilot: ${winners} новых победителей, ${prospects} проспектов в очереди.`,
      ...(winners > 0 ? ["", "Черновик для факторинга:", buildFactoringMessage({ winnerCount: winners })] : []),
      ...(warnings.length > 0 ? ["", `Warning: ${warnings.join("; ")}`] : [])
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
  process.exit(1);
});
