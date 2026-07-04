import { describe, expect, it } from "vitest";
import { parseImportConfig } from "../../src/bitrix/importConfig.js";

function validConfig(): Record<string, unknown> {
  return {
    entity: "lead",
    originatorId: "xlsx-import",
    originIdTemplate: "order:{orderId}",
    columns: [
      { key: "orderId", header: "Номер" },
      { key: "company", header: "Компания" },
      { key: "phone", index: 5 }
    ],
    required: ["orderId"],
    fields: {
      TITLE: { template: "[{orderId}] {company}" },
      PHONE: { column: "phone", transform: "phone" }
    }
  };
}

describe("parseImportConfig", () => {
  it("parses a valid config and applies defaults", () => {
    const config = parseImportConfig(validConfig());
    expect(config.headerRow).toBe(1);
    expect(config.duplicateChecks).toEqual([]);
    expect(config.defaults).toEqual({});
  });

  it("rejects field specs with both column and value", () => {
    const data = validConfig();
    (data.fields as Record<string, unknown>).TITLE = { column: "company", value: "x" };
    expect(() => parseImportConfig(data)).toThrow(/exactly one of/);
  });

  it("rejects columns with both header and index", () => {
    const data = validConfig();
    (data.columns as unknown[]).push({ key: "bad", header: "X", index: 9 });
    expect(() => parseImportConfig(data)).toThrow(/exactly one of/);
  });

  it("rejects unknown column references in fields and templates", () => {
    const data = validConfig();
    (data.fields as Record<string, unknown>).COMMENTS = { column: "missingColumn" };
    expect(() => parseImportConfig(data)).toThrow(/unknown column reference.*missingColumn/);
  });

  it("rejects unknown column references in the origin id template", () => {
    const data = validConfig();
    data.originIdTemplate = "order:{nope}";
    expect(() => parseImportConfig(data)).toThrow(/unknown column reference.*nope/);
  });

  it("rejects duplicate column keys", () => {
    const data = validConfig();
    (data.columns as unknown[]).push({ key: "orderId", header: "Дубль" });
    expect(() => parseImportConfig(data)).toThrow(/duplicate column key/);
  });

  it("validates company link column references", () => {
    const data = validConfig();
    data.company = {
      searchField: "UF_CRM_BIN",
      searchColumn: "binMissing",
      fields: {}
    };
    expect(() => parseImportConfig(data)).toThrow(/unknown column reference.*binMissing/);
  });
});
