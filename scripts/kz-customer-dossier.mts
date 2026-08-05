import fs from "node:fs";
import path from "node:path";
import { sleep } from "../src/kz/csv.js";
import { buildCustomerDossier, formatMoney as money, type CustomerDossier } from "../src/kz/goszakupCustomerDossier.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: npm run kz:customer-dossier -- --bin <БИН> --query <позиция> [options]

Собирает досье заказчика с goszakup.gov.kz: закупщики с почтой, история лотов,
победители и фактические цены. Только чтение, ничего никуда не пишет.

  --bin <БИН>          БИН заказчика (12 цифр), обязателен
  --query <текст>      Наименование позиции, напр. "Компьютер", обязателен
  --max <n>            Сколько объявлений раскрывать вглубь (по умолчанию 8)
  --delay <ms>         Пауза между запросами (по умолчанию 1200)
  --json <путь>        Дополнительно сохранить досье в JSON
  --cache-dir <путь>   Кэш страниц, чтобы не долбить портал при повторах`);
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const bin = args.bin ?? "";
const query = args.query ?? "";
if (!/^\d{12}$/.test(bin)) throw new Error("--bin is required and must be 12 digits");
if (!query.trim()) throw new Error("--query is required, e.g. --query Компьютер");

const delayMs = Number(args.delay ?? 1200);
const cacheDir = args["cache-dir"] ?? path.join("data", "gz-customer-dossier", bin);
fs.mkdirSync(cacheDir, { recursive: true });

const dossier = await buildCustomerDossier({
  bin,
  query,
  maxAnnouncements: Number(args.max ?? 8),
  loadPage: createHttpLoader(cacheDir, delayMs),
  onProgress: (message) => console.log(`dossier: ${message}`)
});

console.log(renderDossier(dossier));

if (args.json) {
  fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
  fs.writeFileSync(args.json, JSON.stringify(dossier, null, 2), "utf8");
  console.log(`\nJSON: ${args.json}`);
}

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

function renderDossier(input: CustomerDossier): string {
  const { summary } = input;
  const lines = [
    "",
    `ДОСЬЕ ЗАКАЗЧИКА ${input.bin} — «${input.query}»`,
    "=".repeat(72),
    "",
    "ЗАКУПЩИКИ (из объявлений этого БИНа)"
  ];

  if (input.officers.length === 0) {
    lines.push("  не найдены");
  } else {
    for (const officer of input.officers) {
      lines.push(`  ${officer.fullName}`);
      lines.push(`    ${officer.position ?? "должность не указана"} | ${officer.email ?? "почты нет"}`);
      lines.push(`    объявлений: ${officer.announceIds.length}`);
    }
  }

  lines.push(
    "",
    "ИСТОРИЯ ЗАКУПОК",
    `  лотов всего: ${summary.lotsTotal} | с договором: ${summary.lotsAwarded} | не состоялось: ${summary.lotsFailed}`,
    `  план: ${money(summary.plannedTotal)} | по договорам: ${money(summary.contractedTotal)}`,
    `  средний сброс цены: ${summary.averageDiscountPercent === null ? "нет данных" : `${summary.averageDiscountPercent}%`}`,
    "",
    "ЦЕНЫ ПО ЛОТАМ"
  );

  if (summary.priceHistory.length === 0) {
    lines.push("  нет закрытых лотов");
  } else {
    for (const entry of summary.priceHistory) {
      lines.push(`  ${entry.lotNumber} — ${entry.quantity ?? "?"} шт`);
      lines.push(
        `    план ${money(entry.plannedAmount)} (${money(entry.plannedUnitPrice)}/шт)` +
          ` → договор ${money(entry.contractedAmount)} (${money(entry.contractedUnitPrice)}/шт)` +
          `${entry.discountPercent === null ? "" : `, −${entry.discountPercent}%`}`
      );
      lines.push(`    победитель: ${entry.supplierName ?? "-"} ${entry.supplierBin ?? ""}`.trimEnd());
    }
  }

  lines.push("", "КТО ВЫИГРЫВАЕТ");
  if (summary.suppliers.length === 0) {
    lines.push("  нет данных");
  } else {
    for (const supplier of summary.suppliers) {
      lines.push(`  ${supplier.wins}× ${supplier.name} ${supplier.bin ?? ""} — ${money(supplier.contractedTotal)}`.trimEnd());
    }
  }

  lines.push("", "ЛОТЫ");
  for (const lot of input.lots) {
    lines.push(`  ${lot.lotNumber} | ${lot.quantity ?? "?"} шт | ${money(lot.amount)} | ${lot.method ?? "-"} | ${lot.status ?? "-"}`);
  }

  return lines.join("\n");
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
