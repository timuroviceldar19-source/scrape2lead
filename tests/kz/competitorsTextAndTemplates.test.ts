import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractSpecText } from "../../src/kz/competitors/textExtractor.js";
import {
  DEFAULT_SPEC_TEMPLATES_PATH,
  loadSpecTemplatesConfig,
  matchSpecTemplates,
  normalizeTemplateText,
  summarizeTemplateWinners
} from "../../src/kz/competitors/specTemplates.js";
import { CompetitorsStorage } from "../../src/kz/competitors/storage.js";
import type { CompetitorBid, CompetitorLot } from "../../src/kz/competitors/types.js";

// Все данные в этом файле выдуманные.
const TEMPLATES_FIXTURE = "tests/fixtures/kz/spec-templates.demo.json";

function buildMinimalPdf(text: string): Buffer {
  const escaped = text.replace(/([()\\])/g, "\\$1");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objs = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n"
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objs) {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += obj;
  }
  const xrefOffset = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("spec text extractor (magic bytes)", () => {
  it("extracts text from PDF, DOCX, XLSX, nested ZIP, and skips unknown/RAR", async () => {
    const pdfBuf = buildMinimalPdf("Interactive panel 75 inch test specification");
    const pdfRes = await extractSpecText(pdfBuf);
    expect(pdfRes.kind).toBe("pdf");
    expect(pdfRes.text).toContain("Interactive panel 75 inch test specification");

    const docxZip = new JSZip();
    docxZip.file(
      "word/document.xml",
      "<w:document><w:body><w:p><w:r><w:t>Модуль учёта комнатных растений</w:t></w:r></w:p></w:body></w:document>"
    );
    const docxBuf = await docxZip.generateAsync({ type: "nodebuffer" });
    const docxRes = await extractSpecText(docxBuf);
    expect(docxRes.kind).toBe("docx");
    expect(docxRes.text).toContain("Модуль учёта комнатных растений");

    const xlsxZip = new JSZip();
    xlsxZip.file("xl/sharedStrings.xml", "<sst><si><t>Интерактивная панель 86</t></si></sst>");
    const xlsxBuf = await xlsxZip.generateAsync({ type: "nodebuffer" });
    const xlsxRes = await extractSpecText(xlsxBuf);
    expect(xlsxRes.kind).toBe("xlsx");
    expect(xlsxRes.text).toContain("Интерактивная панель 86");

    const outerZip = new JSZip();
    outerZip.file("inner.docx", docxBuf);
    const outerBuf = await outerZip.generateAsync({ type: "nodebuffer" });
    const zipRes = await extractSpecText(outerBuf);
    expect(zipRes.kind).toBe("zip");
    expect(zipRes.text).toContain("Модуль учёта");

    const rarRes = await extractSpecText(Buffer.from("Rar!\x1a\x07\x00test"));
    expect(rarRes.kind).toBe("rar");
    expect(rarRes.text).toBe("");
  });
});

describe("spec templates matching and aggregation", () => {
  it("reads templates from SPEC_TEMPLATES_PATH or data/, and treats a missing file as no templates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-tpl-"));
    const prevEnv = process.env.SPEC_TEMPLATES_PATH;
    try {
      expect(loadSpecTemplatesConfig(path.join(dir, "missing.json")).templates).toEqual([]);

      const viaEnv = path.join(dir, "from-secret.json");
      fs.copyFileSync(TEMPLATES_FIXTURE, viaEnv);
      process.env.SPEC_TEMPLATES_PATH = viaEnv;
      expect(loadSpecTemplatesConfig().templates.map((t) => t.id)).toEqual(["demo"]);

      delete process.env.SPEC_TEMPLATES_PATH;
      expect(DEFAULT_SPEC_TEMPLATES_PATH).toBe("data/spec-templates.json");
    } finally {
      if (prevEnv === undefined) delete process.env.SPEC_TEMPLATES_PATH;
      else process.env.SPEC_TEMPLATES_PATH = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps techspec template texts out of the public repository", () => {
    expect(fs.existsSync("config/spec-templates.json")).toBe(false);
    expect(fs.existsSync("config/spec-templates")).toBe(false);
    const gitignore = fs.readFileSync(".gitignore", "utf8");
    expect(gitignore).toMatch(/^data\/\*$/m);
  });

  it("matches a template and summarizes winners", () => {
    const compiled = loadSpecTemplatesConfig(TEMPLATES_FIXTURE);
    expect(compiled.templates).toHaveLength(1);
    const demoText = String(JSON.parse(fs.readFileSync(TEMPLATES_FIXTURE, "utf8")).templates[0].text);

    const strongMatches = matchSpecTemplates(`Техническая спецификация.\n${demoText}`, compiled);
    expect(strongMatches).toHaveLength(1);
    expect(strongMatches[0].templateId).toBe("demo");
    expect(strongMatches[0].strength).toBe("strong");
    expect(strongMatches[0].share).toBeGreaterThanOrEqual(0.8);

    const partialText = "Требуется программа: поддержка режим полива по лунному календарю и интерфейс.";
    const partialMatches = matchSpecTemplates(partialText, compiled);
    expect(partialMatches).toHaveLength(1);
    expect(partialMatches[0].strength).toBe("partial");

    const unrelated = matchSpecTemplates("Обычная интерактивная панель 75 дюймов Android 13 без спец ПО", compiled);
    expect(unrelated).toEqual([]);

    const lot: CompetitorLot = {
      annoId: "1001",
      annoNumber: "1001-1",
      annoName: "Панель",
      lotNumber: "L-100",
      lotName: "Панель интерактивная",
      enstruCode: "262030.100.000021",
      group: "ИП",
      kind: "Интерактивная панель",
      diagonal: '75"',
      cpu: "",
      isCombinedLot: false,
      isKit: false,
      isLatestVersion: true,
      status: "Закупка состоялась",
      startDate: "2026-05-01",
      endDate: "2026-05-10",
      customerBin: "111111111111",
      customerName: 'КГУ "Тестовая школа"',
      qty: 1,
      plannedUnitPriceNoVat: 1200000,
      plannedSumNoVat: 1200000,
      numSubmitted: 2,
      numAdmitted: 1,
      winnerBin: "222222222222",
      winnerName: "ТОО «Тест Победитель»",
      winnerIsOurs: "",
      winnerBidUnitPriceNoVat: 1150000,
      winnerBidTotalPriceNoVat: 1150000,
      winnerDiscountFromPlanPct: 4.17,
      winnerCondDiscountPct: 2,
      secondBin: "",
      secondName: "",
      failureReason: "",
      lotUrl: "https://procurement.gov.kz/ru/announce/index/1001",
      annoUrl: "https://procurement.gov.kz/ru/announce/index/1001",
      protocolUrl: "",
      techspecUrl: "https://v3bl.goszakup.gov.kz/files/download_file/1/2/",
      hasTechspec: true,
      hasItogi: true
    };
    const bids: CompetitorBid[] = [
      {
        annoId: "1001",
        lotNumber: "L-100",
        isLatestLotVersion: true,
        group: "ИП",
        kind: "Интерактивная панель",
        diagonal: '75"',
        cpu: "",
        isCombinedLot: false,
        isKit: false,
        startDate: "2026-05-01",
        lotStatus: "Закупка состоялась",
        plannedQty: 1,
        plannedUnitPriceNoVat: 1200000,
        plannedSumNoVat: 1200000,
        bidderBin: "222222222222",
        bidderName: "ТОО «Тест Победитель»",
        ourCompany: "",
        admittedStatus: "Допущен",
        rejectionShort: "",
        rejectionDetail: "",
        bidUnitPriceNoVat: 1150000,
        bidTotalPriceNoVat: 1150000,
        discountFromPlanPct: 4.17,
        condDiscountPct: 2,
        otpKtpPct: 0,
        condPriceNoVat: 1127000,
        isWinner: true,
        isSecondPlace: false
      },
      {
        annoId: "1001",
        lotNumber: "L-100",
        isLatestLotVersion: true,
        group: "ИП",
        kind: "Интерактивная панель",
        diagonal: '75"',
        cpu: "",
        isCombinedLot: false,
        isKit: false,
        startDate: "2026-05-01",
        lotStatus: "Закупка состоялась",
        plannedQty: 1,
        plannedUnitPriceNoVat: 1200000,
        plannedSumNoVat: 1200000,
        bidderBin: "333333333333",
        bidderName: "ТОО «Тест Отклонённый»",
        ourCompany: "",
        admittedStatus: "Отклонен",
        rejectionShort: "Нет письма правообладателя",
        rejectionDetail: "",
        bidUnitPriceNoVat: null,
        bidTotalPriceNoVat: null,
        discountFromPlanPct: null,
        condDiscountPct: null,
        otpKtpPct: 0,
        condPriceNoVat: null,
        isWinner: false,
        isSecondPlace: false
      }
    ];
    const summary = summarizeTemplateWinners(
      compiled.templates[0],
      [lot],
      bids,
      [{ annoId: "1001", lotNumber: "L-100", ...strongMatches[0] }]
    );
    expect(summary.totalLots).toBe(1);
    expect(summary.uniqueCustomers).toBe(1);
    expect(summary.admittedRatePct).toBe(50);
    expect(summary.winners[0]).toMatchObject({ bin: "222222222222", wins: 1, wonSum: 1150000 });
  });
});

describe("CompetitorsStorage SQLite persistence and snippet search", () => {
  it("stores raw lots, techspecs, normalized lots/bids, and searches techspecs by snippet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-storage-"));
    const dbPath = path.join(dir, "competitors.db");
    const storage = new CompetitorsStorage(dbPath);
    try {
      storage.setMeta("updated_at", "2026-11-15");
      expect(storage.getMeta("updated_at")).toBe("2026-11-15");

      storage.saveTechSpec({
        specKey: "1001:L-1",
        annoId: "1001",
        lotNumber: "L-1",
        fileName: "spec.pdf",
        downloadUrl: "https://v3bl.goszakup.gov.kz/files/download_file/1/2/",
        fileKind: "pdf",
        text: "Модуль поддерживает режим полива по лунному календарю и печать этикеток для горшков.",
        normalizedText: normalizeTemplateText("Модуль поддерживает режим полива по лунному календарю и печать этикеток для горшков."),
        extractedAt: "2026-11-15T10:00:00Z"
      });

      const hits = storage.searchTechSpecs("режим полива по лунному календарю");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ annoId: "1001", lotNumber: "L-1" });
    } finally {
      storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
