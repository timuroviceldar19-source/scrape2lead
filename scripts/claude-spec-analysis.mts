/**
 * "Claude-as-analyst" spec flow. Splits the analysis into two steps so the
 * agent (not an LLM API) reads the PDF and authors the verdict:
 *
 *   fetch  — download the tender spec PDFs for the given lots into a work dir
 *            (no Bitrix, no AI). The agent then reads each PDF and writes a
 *            <slug>.analysis.json conforming to SpecAnalysisSchema.
 *   write  — validate that JSON and push it into the Bitrix deal, reusing the
 *            exact safe plumbing from analyze-gz-specs (findDeal/confirm-deal
 *            gate, writeAnalysis, idempotent timeline). No AI key required.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { BitrixClient } from "../src/bitrix/client.js";
import { SpecAnalysisSchema, type SpecAnalysis } from "../src/analysis/specAnalyzer.js";
import {
  downloadPdf,
  extractAnnounceId,
  fetchTechSpecs,
  selectSpecFileForLot,
  type TechSpecResult
} from "../src/kz/goszakupTechSpec.js";
import {
  assertConfirmDealMatches,
  buildTimelineComment,
  ORIGIN_ID_PREFIX,
  readGzLotRows,
  sha256Hex,
  SpecDealClient
} from "./analyze-gz-specs.mjs";

dotenv.config();

const WORK_FILE = "work.json";

/** One lot's fetch result; the agent adds a sibling <slug>.analysis.json before `write`. */
export interface SpecWorkEntry {
  lotNumber: string;
  lotName: string;
  customer: string;
  announceUrl: string;
  context: string;
  fileName: string | null;
  pdfFile: string | null;
  noSpec: boolean;
}

/** Filesystem-safe stem for a lot number (keeps Cyrillic, collapses the rest). */
export function safeLotSlug(lotNumber: string): string {
  return lotNumber.replace(/[^0-9A-Za-zА-Яа-яЁё]+/g, "-").replace(/^-+|-+$/g, "");
}

export function loadWork(dir: string): SpecWorkEntry[] {
  return JSON.parse(fs.readFileSync(path.join(dir, WORK_FILE), "utf8")) as SpecWorkEntry[];
}

export function loadAnalysis(dir: string, lotNumber: string): SpecAnalysis {
  const file = path.join(dir, `${safeLotSlug(lotNumber)}.analysis.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  return SpecAnalysisSchema.parse(raw);
}

/** Downloads spec PDFs for the given lots; writes work.json. No Bitrix, no AI. */
export async function runFetch(opts: { inputPath: string; outDir: string; lotNumbers: string[] }): Promise<SpecWorkEntry[]> {
  const rows = await readGzLotRows(opts.inputPath);
  const byLot = new Map(rows.map((row) => [row.lotNumber, row]));
  fs.mkdirSync(opts.outDir, { recursive: true });

  const specCache = new Map<string, TechSpecResult>();
  const entries: SpecWorkEntry[] = [];

  for (const lotNumber of opts.lotNumbers) {
    const row = byLot.get(lotNumber);
    if (!row) throw new Error(`lot ${lotNumber} not found in ${opts.inputPath}`);
    const context = `${row.lotName} — заказчик ${row.customer}`.trim();
    const base = { lotNumber, lotName: row.lotName, customer: row.customer, announceUrl: row.announceUrl, context };

    const annoId = extractAnnounceId(row.announceUrl);
    if (!annoId) {
      entries.push({ ...base, fileName: null, pdfFile: null, noSpec: true });
      console.warn(`[no-anno] ${lotNumber}: ${row.announceUrl || "-"}`);
      continue;
    }

    const spec = specCache.get(annoId) ?? (await fetchTechSpecs(annoId));
    specCache.set(annoId, spec);
    const file = selectSpecFileForLot(spec.files, lotNumber);
    if (!file) {
      entries.push({ ...base, fileName: null, pdfFile: null, noSpec: true });
      console.log(`[no-spec] ${lotNumber} (group=${spec.groupId ?? "-"})`);
      continue;
    }

    const pdf = await downloadPdf(file.downloadUrl);
    const pdfFile = `${safeLotSlug(lotNumber)}.pdf`;
    fs.writeFileSync(path.join(opts.outDir, pdfFile), pdf);
    entries.push({ ...base, fileName: file.fileName, pdfFile, noSpec: false });
    console.log(`[fetched] ${lotNumber} -> ${pdfFile} (${file.fileName}, ${pdf.length} bytes)`);
  }

  fs.writeFileSync(path.join(opts.outDir, WORK_FILE), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  return entries;
}

export type WriteOutcome = "posted" | "already-existed" | "already" | "no-spec";

/** Pushes the agent-authored analysis into one deal, gated by --confirm-deal. */
export async function runWrite(opts: {
  client: SpecDealClient;
  dir: string;
  dealId: string;
  confirmDealId: string;
  force: boolean;
}): Promise<{ outcome: WriteOutcome; lotNumber: string }> {
  const deal = await opts.client.getDealById(opts.dealId);
  const originId = deal.originId ?? "";
  if (!originId.startsWith(ORIGIN_ID_PREFIX)) {
    throw new Error(`deal ${opts.dealId} ORIGIN_ID '${originId || "-"}' is not a ${ORIGIN_ID_PREFIX}* lot`);
  }
  const lotNumber = originId.slice(ORIGIN_ID_PREFIX.length);
  assertConfirmDealMatches(deal.id, opts.confirmDealId, lotNumber);

  if (deal.analyzedAt && !opts.force) {
    return { outcome: "already", lotNumber };
  }

  const entry = loadWork(opts.dir).find((item) => item.lotNumber === lotNumber);
  if (!entry) throw new Error(`no ${WORK_FILE} entry for lot ${lotNumber} in ${opts.dir}`);

  await opts.client.ensureSpecFields();

  if (entry.noSpec || !entry.pdfFile || !entry.fileName) {
    await opts.client.markNoSpec(deal.id);
    return { outcome: "no-spec", lotNumber };
  }

  const analysis = loadAnalysis(opts.dir, lotNumber);
  const pdf = fs.readFileSync(path.join(opts.dir, entry.pdfFile));
  const resultHash = sha256Hex(JSON.stringify(analysis));
  await opts.client.writeAnalysis(deal.id, analysis, entry.fileName, pdf, {
    pdfHash: sha256Hex(pdf),
    resultHash,
    modelLabel: "claude-agent"
  });
  const outcome = await opts.client.addTimelineCommentIdempotently(
    deal.id,
    buildTimelineComment(analysis, entry.fileName, resultHash),
    resultHash
  );
  return { outcome, lotNumber };
}

interface CliFlags {
  input: string | null;
  out: string | null;
  dir: string | null;
  dealId: string | null;
  confirmDealId: string | null;
  force: boolean;
  webhookUrl: string | null;
  lotNumbers: string[];
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    input: null,
    out: null,
    dir: null,
    dealId: null,
    confirmDealId: null,
    force: false,
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    lotNumbers: []
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") flags.input = argv[++i] ?? null;
    else if (arg === "--out") flags.out = argv[++i] ?? null;
    else if (arg === "--dir") flags.dir = argv[++i] ?? null;
    else if (arg === "--deal-id") flags.dealId = argv[++i]?.trim() || null;
    else if (arg === "--confirm-deal") flags.confirmDealId = argv[++i]?.trim() || null;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--webhook-url") flags.webhookUrl = argv[++i]?.trim() || null;
    else if (arg === "--lot-number") {
      const value = argv[++i]?.trim();
      if (value) flags.lotNumbers.push(value);
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (subcommand === "fetch") {
    if (!flags.input || !flags.out) throw new Error("fetch requires --input <xlsx> and --out <dir>");
    if (flags.lotNumbers.length === 0) throw new Error("fetch requires at least one --lot-number");
    const entries = await runFetch({ inputPath: flags.input, outDir: flags.out, lotNumbers: flags.lotNumbers });
    const withSpec = entries.filter((entry) => !entry.noSpec).length;
    console.log(`\nfetched: ${withSpec}/${entries.length} lots have a spec; work file: ${path.join(flags.out, WORK_FILE)}`);
    console.log("Next: read each <slug>.pdf and author <slug>.analysis.json, then run `write`.");
    return;
  }

  if (subcommand === "write") {
    if (!flags.dir || !flags.dealId || !flags.confirmDealId) {
      throw new Error("write requires --dir <dir>, --deal-id <id> and --confirm-deal <id>");
    }
    if (!flags.webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");
    const client = new SpecDealClient(new BitrixClient(flags.webhookUrl));
    const result = await runWrite({
      client,
      dir: flags.dir,
      dealId: flags.dealId,
      confirmDealId: flags.confirmDealId,
      force: flags.force
    });
    console.log(`[${result.outcome}] deal ${flags.dealId} (lot ${result.lotNumber})`);
    return;
  }

  throw new Error("usage: claude-spec-analysis <fetch|write> [flags]");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
