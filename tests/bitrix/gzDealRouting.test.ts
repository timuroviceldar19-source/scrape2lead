import { describe, expect, it } from "vitest";
import {
  extractEnstruSuffix,
  gzRoutingConfigSchema,
  resolveGzRoute,
  type GzRoutingConfig
} from "../../src/bitrix/gzDealRouting.js";

const CONFIG: GzRoutingConfig = {
  rules: [
    {
      name: "pk-monitors",
      keywordsAny: ["компьютер", "монитор", "моноблок", "многофункциональн", "мфу"],
      categoryId: 9,
      stageId: "C9:NEW",
      publishedStageId: "C9:S2L_PUBLISHED"
    },
    {
      name: "panels-21-43",
      enstruSuffixes: [21, 43],
      categoryId: 41,
      stageId: "C41:NEW",
      publishedStageId: "C41:S2L_PUBLISHED"
    }
  ],
  default: { categoryId: 29, stageId: "C29:NEW", publishedStageId: "C29:S2L_PUBLISHED" }
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

describe("gzRoutingConfigSchema", () => {
  it("rejects rules without any matcher", () => {
    expect(() => gzRoutingConfigSchema.parse({
      rules: [{ name: "bad", categoryId: 1, stageId: "C1:NEW", publishedStageId: "C1:S2L_PUBLISHED" }],
      default: { categoryId: 29, stageId: "C29:NEW", publishedStageId: "C29:S2L_PUBLISHED" }
    })).toThrow(/enstruSuffixes and\/or keywordsAny/);
  });

  it("accepts the shipped config shape", () => {
    expect(() => gzRoutingConfigSchema.parse(CONFIG)).not.toThrow();
  });

  it("requires a published stage for every route", () => {
    expect(() => gzRoutingConfigSchema.parse({
      rules: [{ name: "bad", keywordsAny: ["pc"], categoryId: 9, stageId: "C9:NEW" }],
      default: { categoryId: 29, stageId: "C29:NEW", publishedStageId: "C29:S2L_PUBLISHED" }
    })).toThrow(/publishedStageId/);
  });

  it("rejects conflicting stage mappings for the same category", () => {
    expect(() => gzRoutingConfigSchema.parse({
      rules: [
        { name: "one", keywordsAny: ["pc"], categoryId: 9, stageId: "C9:NEW", publishedStageId: "C9:S2L_PUBLISHED" },
        { name: "two", keywordsAny: ["monitor"], categoryId: 9, stageId: "C9:OTHER", publishedStageId: "C9:OTHER_PUBLISHED" }
      ],
      default: { categoryId: 29, stageId: "C29:NEW", publishedStageId: "C29:S2L_PUBLISHED" }
    })).toThrow(/conflicting stage mapping.*category 9/i);
  });
});
