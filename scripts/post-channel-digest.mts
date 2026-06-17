/**
 * Публикует публичный дайджест в Telegram-канал из текущего diff (без enrich).
 * Использование: npm run kz:channel-digest [-- --channel-niche "ПСД / освещение"]
 * --preview — только текст в консоль
 * --diff-only — не подставлять recent, если diff пуст
 */
import "dotenv/config";
import Database from "better-sqlite3";
import { readBinsFromCsv } from "../src/kz/csv.js";
import { formatChannelDigest, CHANNEL_DIGEST_PARSE_MODE } from "../src/kz/channelDigest.js";
import { computeOutreachDiff, loadRecentGoszakupWinners, pickUniqueWinnersByBin } from "../src/kz/outreachDigest.js";
import {
  getTelegramChannelConfigFromEnv,
  sendTelegramMessage
} from "../src/kz/telegramNotify.js";

const DB_PATH = process.env.KZ_DATABASE_PATH ?? "data/scrape2lead.db";

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1] ?? null;
}

function collectBins(): string[] {
  const bins = new Set<string>();
  for (const csvPath of ["bins-batch.csv", "bins-top-a.csv"]) {
    try {
      for (const bin of readBinsFromCsv(csvPath)) bins.add(bin);
    } catch {
      console.warn(`channel-digest: пропускаю ${csvPath}`);
    }
  }
  return [...bins];
}

function channelUrlFromEnv(): string | undefined {
  return process.env.TELEGRAM_CHANNEL_CTA_URL?.trim() || undefined;
}

async function main(): Promise<void> {
  const preview = process.argv.includes("--preview");
  const channelConfig = getTelegramChannelConfigFromEnv();
  if (!preview && !channelConfig) {
    throw new Error("Задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHANNEL_ID в .env");
  }

  const bins = collectBins();
  if (bins.length === 0) throw new Error("Нет БИНов в bins-batch.csv / bins-top-a.csv");

  const maxRows = Number(process.env.TELEGRAM_CHANNEL_DIGEST_ROWS ?? 10);
  const niche = readArg("--channel-niche") ?? process.env.TELEGRAM_CHANNEL_NICHE_LABEL ?? undefined;

  const db = new Database(DB_PATH);
  try {
    const diff = computeOutreachDiff(db, { bins });
    let winners = pickUniqueWinnersByBin(diff.winners, maxRows);
    let countLabel = "новых победителей";
    const diffOnly = process.argv.includes("--diff-only");

    if (winners.length === 0 && !diffOnly) {
      winners = loadRecentGoszakupWinners(db, bins, maxRows);
      countLabel = "компаний в выборке";
      if (winners.length > 0) {
        console.warn("channel-digest: diff пуст — топ компаний по сумме контракта из БД");
      }
    }

    const digest = formatChannelDigest(winners, {
      maxRows,
      nicheLabel: niche,
      channelUrl: channelUrlFromEnv(),
      countLabel
    });

    if (!digest) {
      console.log("channel-digest: нет данных для поста");
      return;
    }

    if (preview) {
      console.log(digest);
      return;
    }

    await sendTelegramMessage(channelConfig!, digest, { parseMode: CHANNEL_DIGEST_PARSE_MODE });
    console.log(`channel-digest: опубликовано (${winners.length} победителей в источнике)`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
