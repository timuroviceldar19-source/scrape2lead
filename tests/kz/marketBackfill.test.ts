import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMarketConfig, marketConfigKey } from "../../src/kz/market/config.js";
import {
  backfillMarketByMonths,
  loadStoredMarketData,
  saveStoredMarketData,
  saveStoredMarketUnits,
  type FetchMarketUnitsOptions
} from "../../src/kz/market/fetchMarket.js";
import type { MarketUnit } from "../../src/kz/market/types.js";

const cfg = loadMarketConfig();
const dirs: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-backfill-"));
  dirs.push(dir);
  return path.join(dir, "units.json");
}

function unit(date: string, code = "262030.100.000021"): MarketUnit {
  return {
    id: Number(date.replace(/-/g, "")), unitIndex: 0, month: date.slice(0, 7), date, group: "ИП", code,
    kind: "Интерактивные панели", sum: 1_000_000, qty: 1, price: 1_000_000, supplier: "1", customer: "2",
    supplierName: "S", customerName: "C", method: "Электронный магазин", us: false
  };
}

function recordingFetch(calls: string[]) {
  return async (options: FetchMarketUnitsOptions) => {
    calls.push(options.fromDate.slice(0, 7));
    return { units: [unit(options.fromDate, "279020.100.000001")], source: "zakup" as const };
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("market backfill and the market config", () => {
  it("skips months already complete for the same market config", async () => {
    const file = tempFile();
    saveStoredMarketData({ units: [unit("2026-01-10")], completeMonths: ["2026-01"], configKey: marketConfigKey(cfg) }, file);
    const calls: string[] = [];

    await backfillMarketByMonths({ fromDate: "2026-01-01", toDate: "2026-02-15", filePath: file, cfg, fetchUnits: recordingFetch(calls) });

    expect(calls).toEqual(["2026-02"]);
  });

  it("downloads complete months again when the cache was built with other codes", async () => {
    const file = tempFile();
    // A cache from before the config change: complete months, no key.
    saveStoredMarketData({ units: [unit("2026-01-10")], completeMonths: ["2026-01"] }, file);
    const calls: string[] = [];

    await backfillMarketByMonths({ fromDate: "2026-01-01", toDate: "2026-02-15", filePath: file, cfg, fetchUnits: recordingFetch(calls) });

    expect(calls).toEqual(["2026-01", "2026-02"]);
    const stored = loadStoredMarketData(file);
    expect(stored.configKey).toBe(marketConfigKey(cfg));
    expect(stored.completeMonths).toEqual(["2026-01"]);
    expect(stored.units.filter((u) => u.month === "2026-01").map((u) => u.code)).toEqual(["279020.100.000001"]);
  });

  it("keeps the old config key on a morning update, so a later backfill still downloads old months", () => {
    const file = tempFile();
    saveStoredMarketData({ units: [unit("2026-01-10")], completeMonths: ["2026-01"] }, file);

    saveStoredMarketUnits([unit("2026-01-10"), unit("2026-10-20")], file);

    const stored = loadStoredMarketData(file);
    expect(stored.configKey).toBeUndefined();
    expect(stored.completeMonths).toEqual(["2026-01"]);
  });

  it("changes the key when a group gets new codes", () => {
    const withoutLcd = {
      ...cfg,
      groups: { ...cfg.groups, "ИП": { ...cfg.groups["ИП"], prefixes: ["262030.100."] } }
    };
    expect(marketConfigKey(withoutLcd)).not.toBe(marketConfigKey(cfg));
    expect(marketConfigKey(loadMarketConfig())).toBe(marketConfigKey(cfg));
  });
});
