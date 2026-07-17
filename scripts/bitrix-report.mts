import "dotenv/config";
import { generateBitrixReport } from "../src/bitrix/reporting/generator.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const asOfDate = arg("--as-of") ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error("--as-of must use YYYY-MM-DD");
const outputDir = arg("--output") ?? `exports/bitrix-b2g-${asOfDate}`;
const webhookUrl = process.env.BITRIX24_WEBHOOK_URL?.trim();
if (!webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");

const manifest = await generateBitrixReport({ webhookUrl, asOfDate, outputDir });
console.log(JSON.stringify({ outputDir, sourceCounts: manifest.sourceCounts, normalizedCounts: manifest.normalizedCounts }, null, 2));
