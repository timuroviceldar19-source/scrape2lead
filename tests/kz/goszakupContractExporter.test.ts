import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildContractSearchUrl,
  exportGoszakupContracts,
  type ContractPageLoader
} from "../../src/kz/goszakupContractExporter.js";

const FIXTURES = path.resolve("tests/fixtures/gz-contracts");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gz-contracts-"));
  tempDirs.push(dir);
  return path.join(dir, "contracts.xlsx");
}

function loader(options: { parties?: string; failCode?: string } = {}): ContractPageLoader {
  return vi.fn(async (url: string) => {
    if (options.failCode && url.includes(encodeURIComponent(options.failCode))) throw new Error("portal unavailable");
    if (url.includes("customer_n_supplier")) return options.parties ?? fixture("parties-bin.html");
    if (url.includes("/units/")) return fixture("units.html");
    if (url.includes("/show/")) return fixture("general.html");
    return fixture("search.html");
  });
}

describe("goszakup contract exporter", () => {
  it("builds a separate encoded search URL for a code and signing period", () => {
    const url = buildContractSearchUrl({
      code: "262030.100.000021", from: "2026-01-01", to: "2026-07-13", page: 2, recordsPerPage: 50
    });
    expect(url).toContain("filter%5Benstru%5D=262030.100.000021");
    expect(url).toContain("filter%5Bstart_date_from%5D=2026-01-01");
    expect(url).toContain("page=2");
  });

  it("searches codes sequentially, deduplicates per contract and writes five Excel columns", async () => {
    const pageLoader = loader();
    const outPath = tempFile();
    const result = await exportGoszakupContracts({
      codes: ["262030.100.000021", "262030.100.000021"],
      from: "2026-01-01", to: "2026-07-13", outPath, delayMs: 0, pageLoader
    });

    expect(result.rows).toBe(1);
    expect(result.missingIdentifiers).toBe(0);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outPath);
    const sheet = workbook.worksheets[0];
    expect(sheet.columnCount).toBe(5);
    expect(sheet.getRow(2).values).toEqual([
      undefined, "980840002542", "КГУ «Тестовая школа»", "120340012345", "ТОО «Тест-поставщик»", "262030.100.000021"
    ]);
    expect((pageLoader as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).includes("customer_n_supplier"))).toBe(true);
  });

  it("uses supplier IIN, reports missing identifiers and honors limit", async () => {
    const outPath = tempFile();
    const iinResult = await exportGoszakupContracts({
      codes: ["262030.100.000021"], from: "2026-01-01", to: "2026-07-13",
      outPath, delayMs: 0, limit: 1, pageLoader: loader({ parties: fixture("parties-iin.html") })
    });
    expect(iinResult.rows).toBe(1);
    expect(iinResult.missingIdentifiers).toBe(0);

    const missing = fixture("parties-iin.html").replace("980840002542", "").replace("080419653489", "");
    const missingResult = await exportGoszakupContracts({
      codes: ["262030.100.000021"], from: "2026-01-01", to: "2026-07-13",
      outPath: tempFile(), delayMs: 0, pageLoader: loader({ parties: missing })
    });
    expect(missingResult.missingIdentifiers).toBe(1);
  });

  it("rejects an incomplete crawl when a search page fails", async () => {
    await expect(exportGoszakupContracts({
      codes: ["262030.100.000021", "262030.100.000043"], from: "2026-01-01", to: "2026-07-13",
      outPath: tempFile(), delayMs: 0, pageLoader: loader({ failCode: "262030.100.000043" })
    })).rejects.toThrow(/incomplete.*262030\.100\.000043/i);
  });
});
