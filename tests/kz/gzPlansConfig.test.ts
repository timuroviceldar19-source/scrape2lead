import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadGzPlansConfig,
  mergeGzPlansExportOptions,
  resolvePlanStatusIds,
  resolvePlanStatusNames
} from "../../src/kz/gzPlansConfig.js";
import { buildPlanSearchUrl, matchesPlanStatus } from "../../src/kz/goszakupPlanHtmlParser.js";

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles) {
    fs.rmSync(file, { force: true });
  }
  tempFiles.length = 0;
});

function writeTempConfig(content: Record<string, unknown>): string {
  const file = path.join(os.tmpdir(), `gz-plans-config-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(content), "utf8");
  tempFiles.push(file);
  return file;
}

describe("loadGzPlansConfig", () => {
  it("loads the strict filters from the real PK config", () => {
    const config = loadGzPlansConfig("config/gz-plans.pk.json");

    expect(config.minAmount).toBe(500000);
    expect(config.excludeKeywords).toEqual([
      "Уголок",
      "Стойка",
      "Калькулятор",
      "Игра",
      "Плинтус",
      "Источник бесперебойного питания",
      "Услуги",
      "Коммутационная панель"
    ]);
  });

  it("loads and validates config from JSON file", () => {
    const configPath = writeTempConfig({
      keywords: ["Панель интерактивная"],
      year: 2026,
      months: [6],
      statuses: ["Утвержден"],
      maxPages: 3
    });

    const config = loadGzPlansConfig(configPath);
    expect(config.keywords).toEqual(["Панель интерактивная"]);
    expect(config.months).toEqual([6]);
    expect(config.statuses).toEqual(["Утвержден"]);
    expect(config.maxPages).toBe(3);
  });

  it("rejects empty keywords array", () => {
    const configPath = writeTempConfig({ keywords: [] });
    expect(() => loadGzPlansConfig(configPath)).toThrow();
  });

  it("reads minAmount and excludeKeywords from the config file", () => {
    const configPath = writeTempConfig({
      keywords: ["Панель интерактивная"],
      minAmount: 500000,
      excludeKeywords: ["Уголок", "Стойка"]
    });

    const config = loadGzPlansConfig(configPath);
    expect(config.minAmount).toBe(500000);
    expect(config.excludeKeywords).toEqual(["Уголок", "Стойка"]);
  });

  it("defaults minAmount to 0 and excludeKeywords to the shared stop-list", () => {
    const configPath = writeTempConfig({ keywords: ["Панель интерактивная"] });
    const config = loadGzPlansConfig(configPath);
    expect(config.minAmount).toBe(0);
    expect(config.excludeKeywords).toContain("Уголок");
  });
});

describe("resolvePlanStatusIds", () => {
  it("resolves status name to goszakup ID", () => {
    expect(resolvePlanStatusIds(["Утвержден"])).toEqual([2]);
  });

  it("accepts numeric IDs", () => {
    expect(resolvePlanStatusIds(["2", "5"])).toEqual([2, 5]);
  });

  it("throws on unknown status name", () => {
    expect(() => resolvePlanStatusIds(["Несуществующий"])).toThrow(/Unknown plan status/);
  });

  it("returns empty array for no statuses", () => {
    expect(resolvePlanStatusIds([])).toEqual([]);
  });
});

describe("resolvePlanStatusNames", () => {
  it("resolves ID to canonical status name", () => {
    expect(resolvePlanStatusNames(["2"])).toEqual(["Утвержден"]);
  });
});

describe("mergeGzPlansExportOptions", () => {
  it("CLI overrides take precedence over file config", () => {
    const configPath = writeTempConfig({
      keywords: ["Панель интерактивная"],
      months: [6, 7, 8],
      statuses: ["Утвержден"]
    });
    const fileConfig = loadGzPlansConfig(configPath);
    const merged = mergeGzPlansExportOptions(fileConfig, {
      keywords: ["Доска специальная"],
      months: [9],
      statuses: ["Опубликован"]
    });

    expect(merged.keywords).toEqual(["Доска специальная"]);
    expect(merged.months).toEqual([9]);
    expect(merged.statuses).toEqual(["Опубликован"]);
  });

  it("threads minAmount and excludeKeywords into export options", () => {
    const configPath = writeTempConfig({
      keywords: ["Панель интерактивная"],
      minAmount: 500000,
      excludeKeywords: ["Уголок"]
    });
    const merged = mergeGzPlansExportOptions(loadGzPlansConfig(configPath));

    expect(merged.minAmount).toBe(500000);
    expect(merged.excludeKeywords).toEqual(["Уголок"]);
  });
});

describe("buildPlanSearchUrl", () => {
  it("omits status filter by default (collector filters client-side)", () => {
    const url = buildPlanSearchUrl({
      keyword: "Панель интерактивная",
      year: 2026,
      months: [6]
    });
    expect(url).not.toContain("filter%5Bstatus%5D");
  });

  it("can include status filter when statusIds passed (not used by collector)", () => {
    const url = buildPlanSearchUrl({
      keyword: "Панель интерактивная",
      year: 2026,
      months: [6],
      statusIds: [2]
    });
    expect(url).toContain("filter%5Bstatus%5D%5B%5D=2");
  });
});

describe("matchesPlanStatus", () => {
  it("matches status case-insensitively", () => {
    expect(matchesPlanStatus("утвержден", ["Утвержден"])).toBe(true);
    expect(matchesPlanStatus("Опубликован", ["Утвержден"])).toBe(false);
  });

  it("allows all when filter list is empty", () => {
    expect(matchesPlanStatus("Утвержден", [])).toBe(true);
  });
});
