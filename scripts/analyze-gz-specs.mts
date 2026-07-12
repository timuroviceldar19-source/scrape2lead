import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { BitrixClient as SharedBitrixClient } from "../src/bitrix/client.js";
import {
  analyzeSpecPdf,
  buildSpecSummaryText,
  resolveClientConfig,
  PROMPT_VERSION,
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

export const DEFAULT_INPUT = "exports/gz-lots-latest.xlsx";
export const ORIGINATOR_ID = "scrape2lead-gz-lots";
export const ORIGIN_ID_PREFIX = "gz-lot:";
const SPEC_PDF_FIELD = "UF_CRM_S2L_SPEC_PDF";
const SPEC_VERDICT_FIELD = "UF_CRM_S2L_SPEC_VERDICT";
const SPEC_SUMMARY_FIELD = "UF_CRM_S2L_SPEC_SUMMARY";
const SPEC_ANALYZED_AT_FIELD = "UF_CRM_S2L_SPEC_ANALYZED_AT";
const SPEC_MODEL_FIELD = "UF_CRM_S2L_SPEC_MODEL";
const SPEC_PDF_HASH_FIELD = "UF_CRM_S2L_SPEC_PDF_HASH";
const SPEC_RESULT_HASH_FIELD = "UF_CRM_S2L_SPEC_RESULT_HASH";
const NO_SPEC_VERDICT = "нет спеки";
const DEFAULT_DELAY_MS = 1200;

const DEAL_SELECT_FIELDS = [
  "ID",
  "TITLE",
  "ORIGINATOR_ID",
  "ORIGIN_ID",
  SPEC_ANALYZED_AT_FIELD,
  SPEC_VERDICT_FIELD,
  SPEC_RESULT_HASH_FIELD,
  SPEC_PDF_HASH_FIELD
];

const SPEC_FIELD_DEFINITIONS: Array<Record<string, unknown>> = [
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
  },
  {
    FIELD_NAME: SPEC_MODEL_FIELD,
    USER_TYPE_ID: "string",
    EDIT_FORM_LABEL: "Спека: модель",
    LIST_COLUMN_LABEL: "Спека: модель",
    XML_ID: "s2l_spec_model",
    SORT: 544
  },
  {
    FIELD_NAME: SPEC_PDF_HASH_FIELD,
    USER_TYPE_ID: "string",
    EDIT_FORM_LABEL: "Спека: хеш PDF",
    LIST_COLUMN_LABEL: "Спека: хеш PDF",
    XML_ID: "s2l_spec_pdf_hash",
    SORT: 545
  },
  {
    FIELD_NAME: SPEC_RESULT_HASH_FIELD,
    USER_TYPE_ID: "string",
    EDIT_FORM_LABEL: "Спека: хеш результата",
    LIST_COLUMN_LABEL: "Спека: хеш результата",
    XML_ID: "s2l_spec_result_hash",
    SORT: 546
  }
];

export interface CliArgs {
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
  dealId: string | null;
  lotNumberArg: string | null;
  confirmDealId: string | null;
}

export interface GzLotRow {
  rowNumber: number;
  lotNumber: string;
  lotName: string;
  customer: string;
  status: string;
  announceUrl: string;
}

export interface DealRef {
  id: string;
  title: string;
  analyzedAt: string | null;
  verdict: string | null;
  resultHash: string | null;
  pdfHash: string | null;
}

export interface AnalysisMeta {
  pdfHash: string;
  resultHash: string;
  modelLabel: string;
}

/** A pre-resolved target: dealId is non-null exactly when --deal-id/--lot-number picked one exact deal. */
export interface WorkItem {
  row: GzLotRow;
  dealId: string | null;
}

/** Narrow surface SpecDealClient needs from resolveTargetRows/main, so tests can inject a fake. */
export interface DealResolver {
  findDeal(dealOriginId: string): Promise<DealRef | null>;
  getDealById(dealId: string): Promise<DealRef & { originId: string | null }>;
}

export function parseArgs(argv: string[]): CliArgs {
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
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    dealId: null,
    lotNumberArg: null,
    confirmDealId: null
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
    else if (arg === "--deal-id") args.dealId = argv[++i]?.trim() || null;
    else if (arg === "--lot-number") args.lotNumberArg = argv[++i]?.trim() || null;
    else if (arg === "--confirm-deal") args.confirmDealId = argv[++i]?.trim() || null;
  }

  return args;
}

export function isTargetMode(args: Pick<CliArgs, "dealId" | "lotNumberArg">): boolean {
  return Boolean(args.dealId || args.lotNumberArg);
}

/**
 * Fail-fast safety gates, checked before any Bitrix write (including field
 * creation). Kept separate from execution so they can be unit-tested without
 * a Bitrix client.
 */
export function assertSafeInvocation(args: Pick<CliArgs, "execute" | "force" | "confirmDealId">, targetMode: boolean): void {
  if (args.execute && args.force && !targetMode) {
    throw new Error(
      "--execute --force without --deal-id/--lot-number is disabled: positional/--limit selection previously caused " +
        "writes to the wrong deal. Target one deal with --deal-id or --lot-number plus --confirm-deal."
    );
  }
  if (targetMode && args.execute && !args.confirmDealId) {
    throw new Error(
      "--deal-id/--lot-number with --execute requires --confirm-deal <id> naming the exact deal to write to"
    );
  }
}

/** Aborts before any write if --confirm-deal doesn't name the exact resolved deal. */
export function assertConfirmDealMatches(resolvedDealId: string | null, confirmDealId: string | null, lotNumber: string): void {
  if (!resolvedDealId || resolvedDealId !== confirmDealId) {
    throw new Error(
      `--confirm-deal ${confirmDealId ?? "-"} does not match resolved deal ${resolvedDealId ?? "-"} ` +
        `(lot ${lotNumber}); aborting before any write`
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");

  const targetMode = isTargetMode(args);
  assertSafeInvocation(args, targetMode);

  // Fail fast if credentials are missing — both dry-run and execute call the model.
  const aiOptions = {
    provider: args.provider ?? undefined,
    baseUrl: args.baseUrl ?? undefined,
    model: args.model ?? undefined,
    fallbackBaseUrl: args.fallbackBaseUrl ?? undefined,
    fallbackModel: args.fallbackModel
  };
  const aiConfig = resolveClientConfig(aiOptions);

  const client = new SpecDealClient(new SharedBitrixClient(args.webhookUrl));

  const allRows = await readGzLotRows(args.inputPath);
  const items = await resolveTargetRows(args, allRows, client);

  // Confirm-deal is validated against the actually-resolved deal before any
  // mutation — including ensureSpecFields, which itself writes new custom
  // fields to the Bitrix account.
  if (targetMode && args.execute) {
    const target = items[0];
    assertConfirmDealMatches(target.dealId, args.confirmDealId, target.row.lotNumber);
  }
  if (args.execute) await client.ensureSpecFields();

  console.log(
    `analyze gz specs: mode=${args.execute ? "execute" : "dry-run"} force=${args.force} ` +
      `target=${args.dealId ? `deal:${args.dealId}` : args.lotNumberArg ? `lot:${args.lotNumberArg}` : "batch"}`
  );
  console.log(
    `ai_provider=${aiConfig.provider} model=${aiConfig.model} prompt_version=${PROMPT_VERSION} ` +
      `fallback=${aiConfig.fallback?.model ?? "none"}`
  );
  console.log(`input=${args.inputPath} rows_total=${allRows.length} rows_checked=${items.length}`);

  const specCache = new Map<string, TechSpecResult>();
  const stats = { analyzed: 0, noSpec: 0, noDeal: 0, alreadyDone: 0, skippedInvalid: 0, failed: 0 };

  for (const item of items) {
    const row = item.row;
    const annoId = extractAnnounceId(row.announceUrl);
    if (!annoId || !row.lotNumber) {
      stats.skippedInvalid += 1;
      console.warn(`[skip] row ${row.rowNumber}: missing annoId/lotNumber (${row.announceUrl || "-"})`);
      continue;
    }

    const dealOriginId = `${ORIGIN_ID_PREFIX}${row.lotNumber}`;
    try {
      // Fetch fresh, by exact ID when one was pre-resolved — never re-search
      // by ORIGIN_ID here, since duplicate ORIGIN_IDs would silently pick
      // the wrong deal.
      const deal = item.dealId ? await client.getDealById(item.dealId) : await client.findDeal(dealOriginId);
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
        if (args.execute) {
          printPreview(deal, row.lotNumber, NO_SPEC_VERDICT);
          await client.markNoSpec(deal.id);
        }
        continue;
      }

      const pdf = await downloadPdf(file.downloadUrl);
      const pdfHash = sha256Hex(pdf);
      let modelUsed: { provider: SpecAiProvider; model: string } | null = null;
      const analysis = await analyzeSpecPdf(pdf, {
        ...aiOptions,
        context: `${row.lotName} — заказчик ${row.customer}`.trim(),
        onModelResolved: (info) => { modelUsed = info; }
      });
      const resultHash = sha256Hex(JSON.stringify(analysis));
      const resolvedModel = modelUsed ?? { provider: aiConfig.provider, model: aiConfig.model };
      const modelLabel = `${resolvedModel.provider}:${resolvedModel.model}@${PROMPT_VERSION}`;

      if (!args.execute) {
        stats.analyzed += 1;
        console.log(`\n[dry-run] ${dealOriginId} -> deal ${deal.id} | ${file.fileName}`);
        console.log(`  title="${deal.title}" | current_verdict=${deal.verdict ?? "-"} -> ${analysis.fitVerdict}`);
        console.log(indent(buildSpecSummaryText(analysis)));
        continue;
      }

      printPreview(deal, row.lotNumber, analysis.fitVerdict);
      await client.writeAnalysis(deal.id, analysis, file.fileName, pdf, { pdfHash, resultHash, modelLabel });

      // Idempotency is decided from the timeline itself (not the stored hash
      // field), and re-checked around the add itself: if Bitrix created the
      // comment but the response was lost, a blind retry would duplicate it.
      const outcome = await client.addTimelineCommentIdempotently(
        deal.id,
        buildTimelineComment(analysis, file.fileName, resultHash),
        resultHash
      );
      if (outcome === "already-existed") {
        console.log(`[reconfirmed] ${dealOriginId} -> deal ${deal.id}: comment for this result already exists, skipped duplicate`);
      } else {
        console.log(`[analyzed] ${dealOriginId} -> deal ${deal.id} | ${file.fileName} | ${analysis.fitVerdict}`);
      }
      stats.analyzed += 1;
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

/**
 * Narrows to what to process: an exact, pre-resolved deal when targeted via
 * --deal-id/--lot-number, else the (optionally limited) batch. Target-mode
 * resolution here is read-only (crm.deal.get / crm.deal.list); nothing is
 * written until the caller validates --confirm-deal against the result.
 */
export async function resolveTargetRows(args: CliArgs, allRows: GzLotRow[], client: DealResolver): Promise<WorkItem[]> {
  if (args.dealId) {
    const deal = await client.getDealById(args.dealId);
    if (!deal.originId?.startsWith(ORIGIN_ID_PREFIX)) {
      throw new Error(`deal ${args.dealId} has unexpected ORIGIN_ID "${deal.originId ?? "-"}"; expected ${ORIGIN_ID_PREFIX}<lotNumber>`);
    }
    const lotNumber = deal.originId.slice(ORIGIN_ID_PREFIX.length);
    if (args.lotNumberArg && args.lotNumberArg !== lotNumber) {
      throw new Error(`--lot-number ${args.lotNumberArg} does not match deal ${args.dealId}'s lot ${lotNumber}`);
    }
    const row = allRows.find((candidate) => candidate.lotNumber === lotNumber);
    if (!row) throw new Error(`lot ${lotNumber} (deal ${args.dealId}) not found in ${args.inputPath}`);
    return [{ row, dealId: deal.id }];
  }

  if (args.lotNumberArg) {
    const matches = allRows.filter((candidate) => candidate.lotNumber === args.lotNumberArg);
    if (matches.length === 0) throw new Error(`lot ${args.lotNumberArg} not found in ${args.inputPath}`);
    if (matches.length > 1) {
      throw new Error(
        `lot ${args.lotNumberArg} matches ${matches.length} rows in ${args.inputPath}; use --deal-id to disambiguate`
      );
    }
    const row = matches[0];
    const deal = await client.findDeal(`${ORIGIN_ID_PREFIX}${row.lotNumber}`);
    if (!deal) throw new Error(`no Bitrix deal found for lot ${row.lotNumber} (${ORIGIN_ID_PREFIX}${row.lotNumber})`);
    return [{ row, dealId: deal.id }];
  }

  const rows = args.limit ? allRows.slice(0, args.limit) : allRows;
  return rows.map((row) => ({ row, dealId: null }));
}

export function printPreview(deal: DealRef, lotNumber: string, newVerdict: string): void {
  console.log(
    `[preview] "${deal.title}" (deal ${deal.id}, lot ${lotNumber}) ` +
      `current_verdict=${deal.verdict ?? "-"} -> new_verdict=${newVerdict}`
  );
}

/** Narrow surface this script needs from the shared, throttled Bitrix client. */
interface BitrixCaller {
  call(method: string, body?: unknown, callOptions?: { maxRetries?: number }): Promise<unknown>;
}

const TIMELINE_PAGE_SIZE = 50;
const TIMELINE_MAX_PAGES = 200;

export class SpecDealClient implements DealResolver {
  constructor(private readonly client: BitrixCaller) {}

  async findDeal(dealOriginId: string): Promise<DealRef | null> {
    const result = await this.client.call("crm.deal.list", {
      filter: { ORIGINATOR_ID, ORIGIN_ID: dealOriginId },
      select: DEAL_SELECT_FIELDS
    });
    const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
    if (rows.length > 1) {
      throw new Error(`${rows.length} deals share ORIGIN_ID ${dealOriginId}; resolve the duplicate before writing`);
    }
    const first = rows[0];
    return first?.ID ? toDealRef(first) : null;
  }

  async getDealById(dealId: string): Promise<DealRef & { originId: string | null }> {
    const result = await this.client.call("crm.deal.get", { id: dealId });
    const row = (result ?? {}) as Record<string, unknown>;
    if (!row.ID) throw new Error(`deal ${dealId} not found`);
    if (String(row.ORIGINATOR_ID ?? "") !== ORIGINATOR_ID) {
      throw new Error(`deal ${dealId} does not belong to ${ORIGINATOR_ID} (found ORIGINATOR_ID=${row.ORIGINATOR_ID ?? "-"})`);
    }
    return { ...toDealRef(row), originId: stringOrNull(row.ORIGIN_ID) };
  }

  async writeAnalysis(id: string, analysis: SpecAnalysis, fileName: string, pdf: Buffer, meta: AnalysisMeta): Promise<void> {
    await this.client.call("crm.deal.update", {
      id,
      fields: {
        [SPEC_VERDICT_FIELD]: analysis.fitVerdict,
        [SPEC_SUMMARY_FIELD]: buildSpecSummaryText(analysis),
        [SPEC_ANALYZED_AT_FIELD]: new Date().toISOString(),
        [SPEC_PDF_FIELD]: { fileData: [fileName, pdf.toString("base64")] },
        [SPEC_MODEL_FIELD]: meta.modelLabel,
        [SPEC_PDF_HASH_FIELD]: meta.pdfHash,
        [SPEC_RESULT_HASH_FIELD]: meta.resultHash
      }
    });
  }

  async markNoSpec(id: string): Promise<void> {
    await this.client.call("crm.deal.update", {
      id,
      fields: {
        [SPEC_VERDICT_FIELD]: NO_SPEC_VERDICT,
        [SPEC_SUMMARY_FIELD]: "Техническая спецификация не найдена в документации объявления.",
        [SPEC_ANALYZED_AT_FIELD]: new Date().toISOString()
      }
    });
  }

  /**
   * Looks at the timeline itself (not the stored hash field), paginated
   * through every comment: `crm.timeline.comment.list` returns a single
   * 50-row page by default, and the marker comment could be older than that.
   */
  async hasCommentWithHash(dealId: string, resultHash: string): Promise<boolean> {
    const marker = `hash:${resultHash.slice(0, 12)}`;
    for (let page = 0; page < TIMELINE_MAX_PAGES; page++) {
      const result = await this.client.call("crm.timeline.comment.list", {
        filter: { ENTITY_ID: Number(dealId), ENTITY_TYPE: "deal" },
        select: ["ID", "COMMENT"],
        order: { ID: "DESC" },
        start: page * TIMELINE_PAGE_SIZE
      });
      const rows = Array.isArray(result) ? (result as Array<{ COMMENT?: unknown }>) : [];
      if (rows.some((row) => typeof row.COMMENT === "string" && row.COMMENT.includes(marker))) return true;
      if (rows.length < TIMELINE_PAGE_SIZE) return false;
    }
    throw new Error(
      `crm.timeline.comment.list: exceeded ${TIMELINE_MAX_PAGES * TIMELINE_PAGE_SIZE} comments for deal ${dealId} while searching for a hash marker`
    );
  }

  /**
   * Posts the comment only if no existing comment already carries this
   * result's hash marker. The retry itself disables the shared client's
   * automatic retry (`maxRetries: 0`): if Bitrix created the comment but the
   * response was lost to a network error, a blind retry would duplicate it,
   * so every retry here re-checks the timeline first instead.
   */
  async addTimelineCommentIdempotently(
    dealId: string,
    comment: string,
    resultHash: string,
    maxAttempts = 3
  ): Promise<"posted" | "already-existed"> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (await this.hasCommentWithHash(dealId, resultHash)) return "already-existed";
      try {
        await this.client.call(
          "crm.timeline.comment.add",
          { fields: { ENTITY_ID: Number(dealId), ENTITY_TYPE: "deal", COMMENT: comment } },
          { maxRetries: 0 }
        );
        return "posted";
      } catch (error) {
        if (attempt === maxAttempts - 1) throw error;
      }
    }
    throw new Error("unreachable");
  }

  async ensureSpecFields(): Promise<void> {
    const result = await this.client.call("crm.deal.userfield.list", { order: { SORT: "ASC" } });
    const existing = new Set(
      (Array.isArray(result) ? (result as Array<{ FIELD_NAME?: string }>) : []).map((field) => field.FIELD_NAME)
    );

    for (const fields of SPEC_FIELD_DEFINITIONS) {
      if (existing.has(fields.FIELD_NAME as string)) continue;
      await this.client.call("crm.deal.userfield.add", { fields });
      console.log(`[field] created ${fields.FIELD_NAME}`);
    }
  }
}

export function toDealRef(row: Record<string, unknown>): DealRef {
  return {
    id: String(row.ID),
    title: stringOrNull(row.TITLE) ?? "(no title)",
    analyzedAt: stringOrNull(row[SPEC_ANALYZED_AT_FIELD]),
    verdict: stringOrNull(row[SPEC_VERDICT_FIELD]),
    resultHash: stringOrNull(row[SPEC_RESULT_HASH_FIELD]),
    pdfHash: stringOrNull(row[SPEC_PDF_HASH_FIELD])
  };
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function buildTimelineComment(analysis: SpecAnalysis, fileName: string, resultHash: string): string {
  const verdict =
    analysis.fitVerdict === "можем" ? "МОЖЕМ" : analysis.fitVerdict === "спорно" ? "СПОРНО" : "НЕ НАШЕ";
  return [
    `[b]Разбор спецификации ИИ[/b] (${fileName})`,
    `[b]Вывод:[/b] ${verdict} — ${analysis.fitReason}`,
    `[b]Товар:[/b] ${analysis.product}`,
    `[b]Количество:[/b] ${analysis.quantity} | [b]Срок:[/b] ${analysis.deadline}`,
    analysis.summary,
    `[i]hash:${resultHash.slice(0, 12)}[/i]`
  ].join("\n");
}

export async function readGzLotRows(inputPath: string): Promise<GzLotRow[]> {
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
