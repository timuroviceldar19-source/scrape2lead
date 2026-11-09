import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { updateMarketWindow } from "../../src/kz/market/updateWindow.js";
import { saveStoredMarketUnits, loadStoredMarketUnits } from "../../src/kz/market/fetchMarket.js";
import type { MarketUnit } from "../../src/kz/market/types.js";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-window-")); dirs.push(dir);
  const filePath = path.join(dir, "units.json");
  const unit = (id: number, date = "2026-11-01"): MarketUnit => ({ id, date, month: date.slice(0,7), group: "ИП", code: "test", kind: "test", sum: 1, qty: 1, price: 1, supplier: "", customer: "", supplierName: "", customerName: "", method: "test", us: false });
  saveStoredMarketUnits([unit(1, "2026-01-01"), unit(2), unit(3)], filePath);
  return { filePath, unit };
}
it.each([false, true])("preserves bytes on fetch failure (strict=%s)", async strict => {
  const { filePath } = setup(); const before = fs.readFileSync(filePath, "utf8");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = new Error("synthetic source failure");
  const run = updateMarketWindow({ todayAlmaty: "2026-11-08", filePath, strict, fetchUnits: async () => { throw error; } });
  if (strict) { await expect(run).rejects.toBe(error); expect(warn).not.toHaveBeenCalled(); }
  else { await expect(run).resolves.toBeUndefined(); expect(warn).toHaveBeenCalledWith(expect.stringContaining("::warning::[Рынок] Ошибка при утреннем обновлении рынка: synthetic source failure")); }
  expect(fs.readFileSync(filePath, "utf8")).toBe(before);
});
it("replaces the window while retaining keepContractIds and older history", async () => {
  const { filePath, unit } = setup();
  const result = await updateMarketWindow({ todayAlmaty: "2026-11-08", filePath, strict: true, fetchUnits: async options => {
    expect(options.fromDate).toBe("2026-09-24");
    return { source: "zakup", units: [unit(4)], keepContractIds: [3] };
  } });
  expect(result).toBe(3);
  expect(loadStoredMarketUnits(filePath).map(u => u.id)).toEqual([1,3,4]);
});
