import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractEnstruSuffix,
  gzRoutingConfigSchema,
  loadGzRoutingConfig,
  resolveGzRoute,
  type GzRoutingConfig
} from "../../src/bitrix/gzDealRouting.js";

const CONFIG: GzRoutingConfig = {
  rules: [
    {
      name: "pk-monitors",
      keywordsAny: ["компьютер", "монитор", "моноблок", "многофункциональн", "мфу"],
      categoryId: 9,
      stageId: "C9:NEW"
    },
    {
      name: "panels-21-43",
      enstruSuffixes: [21, 43],
      categoryId: 41,
      stageId: "C41:NEW"
    }
  ],
  default: { categoryId: 29, stageId: "C29:NEW" }
};

describe("extractEnstruSuffix", () => {
  it("takes the last two significant digits of the last ENSTRU segment", () => {
    expect(extractEnstruSuffix("262030.100.000043")).toBe(43);
    expect(extractEnstruSuffix("262030.100.000021")).toBe(21);
    expect(extractEnstruSuffix("262030.100.000007")).toBe(7);
  });

  it("returns null for empty or malformed codes", () => {
    expect(extractEnstruSuffix("")).toBeNull();
    expect(extractEnstruSuffix(null)).toBeNull();
    expect(extractEnstruSuffix(undefined)).toBeNull();
    expect(extractEnstruSuffix("нет кода")).toBeNull();
    expect(extractEnstruSuffix("262030.100.00004a")).toBeNull();
  });
});

describe("resolveGzRoute", () => {
  it("routes ENSTRU suffixes 21 and 43 to the panels pipeline", () => {
    expect(resolveGzRoute({ truCode: "262030.100.000043", keyword: "Доска специальная" }, CONFIG))
      .toEqual({ categoryId: 41, stageId: "C41:NEW", ruleName: "panels-21-43" });
    expect(resolveGzRoute({ truCode: "262030.100.000021", itemName: "Панель интерактивная" }, CONFIG))
      .toEqual({ categoryId: 41, stageId: "C41:NEW", ruleName: "panels-21-43" });
  });

  it("routes other panels to the legal-department pipeline by default", () => {
    expect(resolveGzRoute({ truCode: "262030.100.000099", keyword: "Панель жидкокристаллическая" }, CONFIG))
      .toEqual({ categoryId: 29, stageId: "C29:NEW", ruleName: "default" });
    expect(resolveGzRoute({ truCode: "", keyword: "Панель интерактивная" }, CONFIG).categoryId).toBe(29);
  });

  it("prioritizes the PC/monitors keyword rule over suffix rules", () => {
    expect(resolveGzRoute({ truCode: "262020.300.000043", itemName: "Монитор LED 27\"" }, CONFIG))
      .toEqual({ categoryId: 9, stageId: "C9:NEW", ruleName: "pk-monitors" });
    expect(resolveGzRoute({ truCode: "", keyword: "Устройство многофункциональное (МФУ)" }, CONFIG).categoryId).toBe(9);
    expect(resolveGzRoute({ keyword: "Компьютер персональный" }, CONFIG).categoryId).toBe(9);
  });

  it("matches keywords case-insensitively across keyword and itemName", () => {
    expect(resolveGzRoute({ itemName: "МОНОБЛОК 23.8" }, CONFIG).ruleName).toBe("pk-monitors");
  });
});

describe("shipped PK plans routing", () => {
  it("routes every keyword of the PK plans collector to the PK pipeline", () => {
    const routing = loadGzRoutingConfig("config/bitrix-gz-routing.json");
    const pk = JSON.parse(fs.readFileSync("config/gz-plans.pk.json", "utf8")) as { keywords: string[] };
    expect(pk.keywords.length).toBeGreaterThan(0);
    for (const keyword of pk.keywords) {
      expect(resolveGzRoute({ keyword }, routing))
        .toEqual({ categoryId: 9, stageId: "C9:NEW", ruleName: "pk-monitors" });
    }
  });
});

describe("gzRoutingConfigSchema", () => {
  it("rejects rules without any matcher", () => {
    expect(() => gzRoutingConfigSchema.parse({
      rules: [{ name: "bad", categoryId: 1, stageId: "C1:NEW" }],
      default: { categoryId: 29, stageId: "C29:NEW" }
    })).toThrow(/enstruSuffixes and\/or keywordsAny/);
  });

  it("accepts the shipped config shape", () => {
    expect(() => gzRoutingConfigSchema.parse(CONFIG)).not.toThrow();
  });

  it("ignores a retired publishedStageId left over in an existing config", () => {
    const parsed = gzRoutingConfigSchema.parse({
      rules: [{ name: "pc", keywordsAny: ["pc"], categoryId: 9, stageId: "C9:NEW", publishedStageId: "C9:S2L_PUBLISHED" }],
      default: { categoryId: 29, stageId: "C29:NEW", publishedStageId: "C29:S2L_PUBLISHED" }
    });
    expect(parsed.rules[0]).not.toHaveProperty("publishedStageId");
    expect(parsed.default).not.toHaveProperty("publishedStageId");
  });

  it("rejects conflicting stage mappings for the same category", () => {
    expect(() => gzRoutingConfigSchema.parse({
      rules: [
        { name: "one", keywordsAny: ["pc"], categoryId: 9, stageId: "C9:NEW" },
        { name: "two", keywordsAny: ["monitor"], categoryId: 9, stageId: "C9:OTHER" }
      ],
      default: { categoryId: 29, stageId: "C29:NEW" }
    })).toThrow(/conflicting stage mapping.*category 9/i);
  });
});
