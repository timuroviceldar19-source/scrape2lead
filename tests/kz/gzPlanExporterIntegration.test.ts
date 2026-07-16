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

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("export registry preflight", () => {
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
});
