import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collectGzPlans: vi.fn(),
  collectRegistry: vi.fn()
}));

vi.mock("../../src/kz/goszakupPlanCollector.js", () => ({ collectGzPlans: mocks.collectGzPlans }));
vi.mock("../../src/kz/goszakupRegistryCollector.js", () => ({ collectGoszakupRegistryForBins: mocks.collectRegistry }));

import { exportGzPlansReport } from "../../src/kz/gzPlanExporter.js";
import { KzStorage } from "../../src/kz/kzStorage.js";
import { parseRegistryProfileHtml } from "../../src/kz/goszakupRegistryParser.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("export registry preflight", () => {
  it("excludes only the BIN with a confirmed network failure and preserves other plans", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-partial-registry-")); tempDirs.push(dir);
    const databasePath = path.join(dir, "db.sqlite"); const storage = new KzStorage({ databasePath });
    const record = parseRegistryProfileHtml(fs.readFileSync("tests/fixtures/goszakup-registry-profile-980840002897.html", "utf8"), "980840002897")!;
    storage.upsertGoszakupRegistry({ ...record, updated_at: new Date().toISOString(), raw_snapshot_path: null }); storage.close();
    mocks.collectGzPlans.mockResolvedValue({ successfulQueries: 1, skippedQueries: [], items: ["980840002897", "000240001420"].map((bin, index) => ({
      plan_point_id: String(index + 1), plan_list_number: String(index + 1), customer_name: "Заказчик", customer_url: null,
      item_name: "Компьютер", method: null, unit: null, quantity: "1", unit_price: "1000000", planned_amount: "1000000",
      planned_month: "Ноябрь", status: "Утвержден", detail_url: null, keyword: "Компьютер",
      detail: { customer_bin: bin, name_ru: "Компьютер" }
    })) });
    mocks.collectRegistry.mockImplementation(async (_bins, options) => {
      options.onFailure?.("000240001420", new Error("page.goto: Timeout 30000ms exceeded"), 3);
      return { processed: 1, success: 0, not_found: 0, failed: 1, cached: 1, skipped: 0 };
    });
    const options = { databasePath, outPath: path.join(dir, "plans.xlsx"), partialCollection: true, year: 2026, months: [11, 12] };
    expect(await exportGzPlansReport(options)).toMatchObject({ rows: 1, skippedQueries: [{ stage: "registry",
      query: "000240001420", year: 2026, months: [11, 12], failedPage: null, planPointIds: ["2"], attempts: 3 }] });
  });

  it("keeps missing registry data fatal when no network failure was confirmed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-invalid-registry-")); tempDirs.push(dir);
    mocks.collectGzPlans.mockResolvedValue({ items: [{ plan_point_id: "42", keyword: "Панель", detail: { customer_bin: "000240001420" } }] });
    mocks.collectRegistry.mockResolvedValue({ processed: 1, not_found: 1 });
    await expect(exportGzPlansReport({ databasePath: path.join(dir, "db.sqlite"), outPath: path.join(dir, "out.xlsx"), partialCollection: true }))
      .rejects.toThrow(/registry preflight failed/);
  });
  it("stops before writing XLSX when the customer profile is still missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-export-"));
    tempDirs.push(dir);
    const outPath = path.join(dir, "nested", "plans.xlsx");
    mocks.collectGzPlans.mockResolvedValue({
      items: [{
        plan_point_id: "87017028",
        plan_list_number: "83427345",
        customer_name: null,
        customer_url: "https://goszakup.gov.kz/ru/registry/show_supplier/34591",
        item_name: "Компьютер",
        method: null,
        unit: null,
        quantity: null,
        unit_price: null,
        planned_amount: "1000000",
        planned_month: "Июль",
        status: "Утвержден",
        detail_url: "https://goszakup.gov.kz/ru/registry/show_plan/87017028/4772320",
        keyword: "Компьютер",
        detail: {
          plan_point_id: "87017028",
          customer_bin: "980840002897",
          customer_name: null,
          name_ru: "Компьютер",
          ref_enstru_code: null,
          desc_ru: null,
          extra_desc_ru: null,
          date_approved: null,
          ref_abp_code: null,
          abp_name: null,
          delivery_address: null,
          plan_act_number: null
        }
      }]
    });
    mocks.collectRegistry.mockResolvedValue({ processed: 1, success: 0, not_found: 1, failed: 0, cached: 0, skipped: 0 });

    await expect(exportGzPlansReport({
      databasePath: path.join(dir, "registry.db"),
      outPath,
      delayMs: 0
    })).rejects.toThrow(/980840002897.*87017028/);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(path.dirname(outPath))).toBe(false);
  });

  it("drops an unrelated TRU code before registry enrichment", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-export-"));
    tempDirs.push(dir);
    const outPath = path.join(dir, "plans.xlsx");
    mocks.collectGzPlans.mockResolvedValue({
      items: [{
        plan_point_id: "87390348",
        plan_list_number: "87390348",
        customer_name: "Customer",
        customer_url: "https://goszakup.gov.kz/ru/registry/show_supplier/46684",
        item_name: "Транспондер",
        method: null,
        unit: "Комплект",
        quantity: "9",
        unit_price: "4396551.72",
        planned_amount: "39568965.48",
        planned_month: "Июль",
        status: "На проверке камерального контроля",
        detail_url: null,
        keyword: "Монитор",
        detail: {
          plan_point_id: "87390348",
          customer_bin: "101040007723",
          customer_name: "Customer",
          name_ru: "Транспондер",
          ref_enstru_code: "262030.100.000051",
          desc_ru: null,
          extra_desc_ru: "Блок монитора",
          date_approved: null,
          ref_abp_code: null,
          abp_name: null,
          delivery_address: null,
          plan_act_number: null
        }
      }]
    });

    const result = await exportGzPlansReport({
      databasePath: path.join(dir, "registry.db"),
      outPath,
      delayMs: 0,
      includeTruCodePrefixes: ["262011.", "262013.", "262017.100."]
    });

    expect(result.rows).toBe(0);
    expect(mocks.collectRegistry).not.toHaveBeenCalled();
    expect(fs.existsSync(outPath)).toBe(true);
  });
});
