import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { analyzeSpecPdf, type SpecAnalysis } from "../src/analysis/specAnalyzer.js";
import { renderPdfPages } from "../src/analysis/pdfRenderer.js";
import {
  downloadPdf,
  extractAnnounceId,
  fetchTechSpecs,
  selectSpecFileForLot
} from "../src/kz/goszakupTechSpec.js";

dotenv.config();

const INPUT = "exports/gz-lots-computers-live-2026-jul-dec.xlsx";
const OUTPUT = "exports/ai-model-comparison.json";
const SAMPLE_LIMIT = 5;

interface LotRow {
  rowNumber: number;
  lotNumber: string;
  lotName: string;
  customer: string;
  announceUrl: string;
}

interface ModelResult {
  model: string;
  transport: "chat-completions" | "messages";
  success: boolean;
  latencyMs: number;
  attemptsAllowed: number;
  analysis?: SpecAnalysis;
  error?: string;
}

interface SampleResult {
  rowNumber: number;
  lotNumber: string;
  lotName: string;
  customer: string;
  fileName: string;
  pageCount: number;
  pdfBytes: number;
  models: ModelResult[];
}

const models = [
  { model: "kimi-k2.6", transport: "chat-completions" as const },
  { model: "qwen3.7-plus", transport: "messages" as const }
];

async function main(): Promise<void> {
  if (!process.env.OPENCODE_API_KEY?.trim() && !process.env.CLOUD_API_KEY?.trim()) {
    throw new Error("OPENCODE_API_KEY is required");
  }

  const rows = await readRows(INPUT);
  const samples: SampleResult[] = [];

  for (const row of rows) {
    if (samples.length >= SAMPLE_LIMIT) break;
    const announceId = extractAnnounceId(row.announceUrl);
    if (!announceId) continue;

    process.stderr.write(`[sample] lot=${row.lotNumber} fetching spec\n`);
    const spec = await fetchTechSpecs(announceId);
    const file = selectSpecFileForLot(spec.files, row.lotNumber);
    if (!file) {
      process.stderr.write(`[skip] lot=${row.lotNumber} no matching PDF\n`);
      continue;
    }

    const pdf = await downloadNonEmptyPdf(file.downloadUrl);
    const pages = await renderPdfPages(pdf);
    const sample: SampleResult = {
      rowNumber: row.rowNumber,
      lotNumber: row.lotNumber,
      lotName: row.lotName,
      customer: row.customer,
      fileName: file.fileName,
      pageCount: pages.length,
      pdfBytes: pdf.length,
      models: []
    };

    // Alternate call order to reduce systematic warm-cache / time-of-run bias.
    const orderedModels = samples.length % 2 === 0 ? models : [...models].reverse();
    for (const candidate of orderedModels) {
      process.stderr.write(`[model] lot=${row.lotNumber} model=${candidate.model}\n`);
      const started = performance.now();
      try {
        const analysis = await analyzeSpecPdf(pdf, {
          provider: "opencode",
          baseUrl: "https://opencode.ai/zen/go/v1",
          model: candidate.model,
          transport: candidate.transport,
          fallbackModel: null,
          context: `${row.lotName} — заказчик ${row.customer}`,
          maxAttemptsPerModel: 2,
          renderPdf: async () => pages
        });
        sample.models.push({
          ...candidate,
          success: true,
          latencyMs: Math.round(performance.now() - started),
          attemptsAllowed: 2,
          analysis
        });
      } catch (error) {
        sample.models.push({
          ...candidate,
          success: false,
          latencyMs: Math.round(performance.now() - started),
          attemptsAllowed: 2,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    sample.models.sort((a, b) => a.model.localeCompare(b.model));
    samples.push(sample);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    input: INPUT,
    sampleLimit: SAMPLE_LIMIT,
    sampleCount: samples.length,
    note: "Public tender PDFs only; no Bitrix writes were performed.",
    samples
  };
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({ output: OUTPUT, sampleCount: samples.length }));
}

async function downloadNonEmptyPdf(url: string): Promise<Buffer> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const pdf = await downloadPdf(url);
      if (pdf.length > 0) return pdf;
      throw new Error("downloaded PDF is empty");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError ?? new Error("failed to download PDF");
}

async function readRows(inputPath: string): Promise<LotRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error(`No worksheet found in ${inputPath}`);
  const rows: LotRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const lotNumber = row.getCell(3).text.trim();
    if (!lotNumber) return;
    rows.push({
      rowNumber,
      lotNumber,
      lotName: row.getCell(4).text.trim(),
      customer: row.getCell(7).text.trim(),
      announceUrl: row.getCell(13).text.trim()
    });
  });
  return rows;
}

await main();
