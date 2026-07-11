import dotenv from "dotenv";
import ExcelJS from "exceljs";
import {
  analyzeSpecPdf,
  buildSpecSummaryText,
  resolveClientConfig,
  type SpecAiProvider,
  type SpecAnalysis
} from "../src/analysis/specAnalyzer.js";
import {
  downloadPdf,
  extractAnnounceId,
  fetchTechSpecs,
  selectSpecFileForLot,
  type TechSpecResult
} from "../src/kz/goszakupTechSpec.js";

dotenv.config();

const DEFAULT_INPUT = "exports/gz-lots-computers-live-2026-jul-dec.xlsx";
const ORIGINATOR_ID = "scrape2lead-gz-lots";
const SPEC_PDF_FIELD = "UF_CRM_S2L_SPEC_PDF";
const SPEC_VERDICT_FIELD = "UF_CRM_S2L_SPEC_VERDICT";
const SPEC_SUMMARY_FIELD = "UF_CRM_S2L_SPEC_SUMMARY";
const SPEC_ANALYZED_AT_FIELD = "UF_CRM_S2L_SPEC_ANALYZED_AT";
const NO_SPEC_VERDICT = "нет спеки";
const DEFAULT_DELAY_MS = 1200;

interface CliArgs {
  inputPath: string;
  execute: boolean;
  limit: number | null;
  force: boolean;
  delayMs: number;
  provider: SpecAiProvider | null;
  baseUrl: string | null;
  model: string | null;
  fallbackBaseUrl: string | null;
  fallbackModel: string | null | undefined;
  webhookUrl: string | null;
}

interface GzLotRow {
  rowNumber: number;
  lotNumber: string;
  lotName: string;
  customer: string;
  status: string;
  announceUrl: string;
}

interface DealRef {
  id: string;
  analyzedAt: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inputPath: DEFAULT_INPUT,
    execute: false,
    limit: null,
    force: false,
    delayMs: DEFAULT_DELAY_MS,
    provider: null,
    baseUrl: null,
    model: null,
    fallbackBaseUrl: null,
    fallbackModel: undefined,
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") args.inputPath = argv[++i] ?? args.inputPath;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--limit") args.limit = parseOptionalInt(argv[++i]);
    else if (arg === "--force") args.force = true;
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i] ?? args.delayMs);
    else if (arg === "--provider") args.provider = parseProvider(argv[++i]);
    else if (arg === "--base-url") args.baseUrl = argv[++i]?.trim() || null;
    else if (arg === "--model") args.model = argv[++i]?.trim() || null;
    else if (arg === "--fallback-base-url") args.fallbackBaseUrl = argv[++i]?.trim() || null;
    else if (arg === "--fallback-model") {
      const value = argv[++i]?.trim();
      args.fallbackModel = !value || value.toLowerCase() === "none" ? null : value;
    }
    else if (arg === "--webhook-url") args.webhookUrl = argv[++i]?.trim() || null;
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");
  // Fail fast if credentials are missing — both dry-run and execute call the model.
  const aiOptions = {
    provider: args.provider ?? undefined,
    baseUrl: args.baseUrl ?? undefined,
    model: args.model ?? undefined,
    fallbackBaseUrl: args.fallbackBaseUrl ?? undefined,
    fallbackModel: args.fallbackModel
  };
  const aiConfig = resolveClientConfig(aiOptions);

  const client = new BitrixClient(args.webhookUrl);
  if (args.execute) await client.ensureSpecFields();

  const allRows = await readGzLotRows(args.inputPath);
  const rows = args.limit ? allRows.slice(0, args.limit) : allRows;

  console.log(`analyze gz specs: mode=${args.execute ? "execute" : "dry-run"} force=${args.force}`);
  console.log(
    `ai_provider=${aiConfig.provider} model=${aiConfig.model} ` +
      `fallback=${aiConfig.fallback?.model ?? "none"}`
  );
  console.log(`input=${args.inputPath} rows_total=${allRows.length} rows_checked=${rows.length}`);

  const specCache = new Map<string, TechSpecResult>();
  const stats = { analyzed: 0, noSpec: 0, noDeal: 0, alreadyDone: 0, skippedInvalid: 0, failed: 0 };

  for (const row of rows) {
    const annoId = extractAnnounceId(row.announceUrl);
    if (!annoId || !row.lotNumber) {
      stats.skippedInvalid += 1;
      console.warn(`[skip] row ${row.rowNumber}: missing annoId/lotNumber (${row.announceUrl || "-"})`);
      continue;
    }

    const dealOriginId = `gz-lot:${row.lotNumber}`;
    try {
      const deal = await client.findDeal(dealOriginId);
      if (!deal) {
        stats.noDeal += 1;
        console.warn(`[no-deal] ${dealOriginId}`);
        continue;
      }
      if (deal.analyzedAt && !args.force) {
        stats.alreadyDone += 1;
        console.log(`[already] ${dealOriginId} -> deal ${deal.id} (analyzed ${deal.analyzedAt})`);
        continue;
      }

      const spec = specCache.get(annoId) ?? (await fetchTechSpecs(annoId));
      specCache.set(annoId, spec);
      const file = selectSpecFileForLot(spec.files, row.lotNumber);

      if (!file) {
        stats.noSpec += 1;
        console.log(`[no-spec] ${dealOriginId} -> deal ${deal.id} (group=${spec.groupId ?? "-"})`);
        if (args.execute) await client.markNoSpec(deal.id);
        continue;
      }

      const pdf = await downloadPdf(file.downloadUrl);
      const analysis = await analyzeSpecPdf(pdf, {
        ...aiOptions,
        context: `${row.lotName} — заказчик ${row.customer}`.trim()
      });

      if (!args.execute) {
        stats.analyzed += 1;
        console.log(`\n[dry-run] ${dealOriginId} -> deal ${deal.id} | ${file.fileName}`);
        console.log(`  verdict=${analysis.fitVerdict} | ${analysis.product}`);
        console.log(indent(buildSpecSummaryText(analysis)));
        continue;
      }

      await client.writeAnalysis(deal.id, analysis, file.fileName, pdf);
      await client.addTimelineComment(deal.id, buildTimelineComment(analysis, file.fileName));
      stats.analyzed += 1;
      console.log(`[analyzed] ${dealOriginId} -> deal ${deal.id} | ${file.fileName} | ${analysis.fitVerdict}`);
      if (args.delayMs > 0) await sleep(args.delayMs);
    } catch (error) {
      stats.failed += 1;
      console.error(`[failed] ${dealOriginId}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }

  console.log(
    `\ndone: analyzed=${stats.analyzed} no_spec=${stats.noSpec} no_deal=${stats.noDeal} ` +
      `already=${stats.alreadyDone} skipped=${stats.skippedInvalid} failed=${stats.failed}`
  );
}

class BitrixClient {
  private readonly baseUrl: string;

  constructor(webhookUrl: string) {
    this.baseUrl = webhookUrl.replace(/\/+$/, "");
  }

  async findDeal(dealOriginId: string): Promise<DealRef | null> {
    const result = await this.call("crm.deal.list", {
      filter: { ORIGINATOR_ID, ORIGIN_ID: dealOriginId },
      select: ["ID", SPEC_ANALYZED_AT_FIELD]
    });
    const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
    const first = rows[0];
    if (!first?.ID) return null;
    return { id: String(first.ID), analyzedAt: stringOrNull(first[SPEC_ANALYZED_AT_FIELD]) };
  }

  async writeAnalysis(id: string, analysis: SpecAnalysis, fileName: string, pdf: Buffer): Promise<void> {
    await this.call("crm.deal.update", {
      id,
      fields: {
        [SPEC_VERDICT_FIELD]: analysis.fitVerdict,
        [SPEC_SUMMARY_FIELD]: buildSpecSummaryText(analysis),
        [SPEC_ANALYZED_AT_FIELD]: new Date().toISOString(),
        [SPEC_PDF_FIELD]: { fileData: [fileName, pdf.toString("base64")] }
      }
    });
  }

  async markNoSpec(id: string): Promise<void> {
    await this.call("crm.deal.update", {
      id,
      fields: {
        [SPEC_VERDICT_FIELD]: NO_SPEC_VERDICT,
        [SPEC_SUMMARY_FIELD]: "Техническая спецификация не найдена в документации объявления.",
        [SPEC_ANALYZED_AT_FIELD]: new Date().toISOString()
      }
    });
  }

  async addTimelineComment(dealId: string, comment: string): Promise<void> {
    await this.call("crm.timeline.comment.add", {
      fields: { ENTITY_ID: Number(dealId), ENTITY_TYPE: "deal", COMMENT: comment }
    });
  }

  async ensureSpecFields(): Promise<void> {
    const result = await this.call("crm.deal.userfield.list", { order: { SORT: "ASC" } });
    const existing = new Set(
      (Array.isArray(result) ? (result as Array<{ FIELD_NAME?: string }>) : []).map((field) => field.FIELD_NAME)
    );

    const definitions: Array<Record<string, unknown>> = [
      {
        FIELD_NAME: SPEC_VERDICT_FIELD,
        USER_TYPE_ID: "string",
        EDIT_FORM_LABEL: "Спека: вывод",
        LIST_COLUMN_LABEL: "Спека: вывод",
        XML_ID: "s2l_spec_verdict",
        SORT: 540
      },
      {
        FIELD_NAME: SPEC_SUMMARY_FIELD,
        USER_TYPE_ID: "string",
        EDIT_FORM_LABEL: "Спека: разбор",
        LIST_COLUMN_LABEL: "Спека: разбор",
        XML_ID: "s2l_spec_summary",
        SORT: 541,
        SETTINGS: { ROWS: 12 }
      },
      {
        FIELD_NAME: SPEC_ANALYZED_AT_FIELD,
        USER_TYPE_ID: "string",
        EDIT_FORM_LABEL: "Спека: проанализировано",
        LIST_COLUMN_LABEL: "Спека: проанализировано",
        XML_ID: "s2l_spec_analyzed_at",
        SORT: 542
      },
      {
        FIELD_NAME: SPEC_PDF_FIELD,
        USER_TYPE_ID: "file",
        EDIT_FORM_LABEL: "Спека: PDF",
        LIST_COLUMN_LABEL: "Спека: PDF",
        XML_ID: "s2l_spec_pdf",
        SORT: 543
      }
    ];

    for (const fields of definitions) {
      if (existing.has(fields.FIELD_NAME as string)) continue;
      await this.call("crm.deal.userfield.add", { fields });
      console.log(`[field] created ${fields.FIELD_NAME}`);
    }
  }

  private async call(method: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/${method}.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = (await response.json()) as { result: unknown; error?: string; error_description?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error_description || payload.error || `HTTP ${response.status}`);
    }
    return payload.result;
  }
}

function buildTimelineComment(analysis: SpecAnalysis, fileName: string): string {
  const verdict =
    analysis.fitVerdict === "можем" ? "МОЖЕМ" : analysis.fitVerdict === "спорно" ? "СПОРНО" : "НЕ НАШЕ";
  return [
    `[b]Разбор спецификации ИИ[/b] (${fileName})`,
    `[b]Вывод:[/b] ${verdict} — ${analysis.fitReason}`,
    `[b]Товар:[/b] ${analysis.product}`,
    `[b]Количество:[/b] ${analysis.quantity} | [b]Срок:[/b] ${analysis.deadline}`,
    analysis.summary
  ].join("\n");
}

async function readGzLotRows(inputPath: string): Promise<GzLotRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error(`No worksheet found in ${inputPath}`);

  const rows: GzLotRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cell = (i: number) => cellText(row.getCell(i));
    const lotNumber = cell(3);
    if (!lotNumber) return;
    rows.push({
      rowNumber,
      lotNumber,
      lotName: cell(4),
      customer: cell(7),
      status: cell(11),
      announceUrl: cell(13)
    });
  });
  return rows;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value) return value.richText.map((part) => part.text ?? "").join("").trim();
    if ("result" in value) return String(value.result ?? "").trim();
  }
  return String(value).trim();
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text : null;
}

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseProvider(value: string | undefined): SpecAiProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "opencode" || normalized === "anthropic") return normalized;
  throw new Error(`--provider must be opencode or anthropic, got ${value ?? "-"}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
