import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { BitrixClient } from "../src/bitrix/client.js";
import {
  hasDossierComment,
  renderDossierComment,
  type TimelineComment
} from "../src/bitrix/customerDossierComment.js";
import { sleep } from "../src/kz/csv.js";
import { buildCustomerDossier } from "../src/kz/goszakupCustomerDossier.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: npm run bitrix:post-customer-dossier -- --deal <id> [options]

Собирает досье заказчика с goszakup.gov.kz и публикует его комментарием в таймлайн сделки.
БИН и наименование позиции берутся из полей сделки, если не заданы явно.

  --deal <id>        ID сделки, обязателен
  --bin <БИН>        Переопределить БИН заказчика
  --query <текст>    Переопределить наименование позиции
  --max <n>          Сколько объявлений раскрывать (по умолчанию 8)
  --delay <ms>       Пауза между запросами к порталу (по умолчанию 1200)
  --execute          Действительно записать комментарий. Без флага — только показать текст
  --force            Записать, даже если досье в этой сделке уже публиковалось`);
  process.exit(0);
}

/** БИН заказчика и наименование позиции в карточках B2G (см. scripts/bitrix-push-gz-deals.mts). */
const CUSTOMER_BIN_FIELD = "UF_CRM_6627AEBD7C2D2";
const ITEM_NAME_FIELDS = ["UF_CRM_6627AEBD54B8D", "UF_CRM_ENSTRU_NAME"] as const;

const args = parseArgs(process.argv.slice(2));
const dealId = args.deal ?? "";
if (!/^\d+$/.test(dealId)) throw new Error("--deal is required and must be numeric");

const webhookUrl = process.env.BITRIX24_WEBHOOK_URL?.trim();
if (!webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");

const client = new BitrixClient(webhookUrl);
const deal = await client.call("crm.deal.get", { id: dealId }) as Record<string, unknown>;
if (!deal?.ID) throw new Error(`deal ${dealId} not found`);

const bin = (args.bin ?? text(deal[CUSTOMER_BIN_FIELD])).replace(/\D/g, "");
const query = args.query ?? firstText(deal, ITEM_NAME_FIELDS);
if (!/^\d{12}$/.test(bin)) {
  throw new Error(`deal ${dealId}: customer BIN is missing or invalid (${CUSTOMER_BIN_FIELD}); pass --bin`);
}
if (!query.trim()) {
  throw new Error(`deal ${dealId}: item name is empty; pass --query`);
}

console.log(`deal ${dealId}: «${text(deal.TITLE)}»`);
console.log(`customer BIN ${bin}, позиция «${query}»`);

const existing = await client.call("crm.timeline.comment.list", {
  filter: { ENTITY_ID: Number(dealId), ENTITY_TYPE: "deal" },
  select: ["ID", "COMMENT"]
}) as TimelineComment[];

if (hasDossierComment(existing ?? []) && !args.force) {
  console.log("В сделке уже есть досье от предыдущего прогона. Повтор — с --force.");
  process.exit(0);
}

const cacheDir = path.join("data", "gz-customer-dossier", bin);
fs.mkdirSync(cacheDir, { recursive: true });

const dossier = await buildCustomerDossier({
  bin,
  query,
  maxAnnouncements: Number(args.max ?? 8),
  loadPage: createHttpLoader(cacheDir, Number(args.delay ?? 1200)),
  onProgress: (message) => console.log(`dossier: ${message}`)
});

// `toISOString` дал бы дату в UTC — под утро это вчерашнее число. Нужен локальный день.
const collectedAt = new Date().toLocaleDateString("sv-SE");
const comment = renderDossierComment(dossier, { collectedAt });

console.log("\n--- комментарий ---\n");
console.log(comment);
console.log("\n-------------------\n");

if (!args.execute) {
  console.log("Dry run. Ничего не записано — добавьте --execute, чтобы опубликовать.");
  process.exit(0);
}

const commentId = await client.call("crm.timeline.comment.add", {
  fields: { ENTITY_ID: Number(dealId), ENTITY_TYPE: "deal", COMMENT: comment }
});
console.log(`Опубликовано: комментарий ${String(commentId)} в сделке ${dealId}`);

function createHttpLoader(directory: string, pauseMs: number) {
  let firstRequest = true;
  return async (url: string): Promise<string> => {
    const cachePath = path.join(directory, `${cacheKey(url)}.html`);
    if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, "utf8");

    if (!firstRequest) await sleep(pauseMs);
    firstRequest = false;

    const response = await fetch(url, {
      headers: {
        Accept: "text/html",
        "Accept-Language": "ru-RU,ru;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });
    if (!response.ok) throw new Error(`goszakup.gov.kz: HTTP ${response.status} for ${url}`);

    const html = await response.text();
    fs.writeFileSync(cachePath, html, "utf8");
    return html;
  };
}

function cacheKey(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 120);
}

function firstText(source: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = text(source[field]);
    if (value) return value;
  }
  return "";
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index++;
    } else {
      result[key] = "true";
    }
  }
  return result;
}
