import { describe, expect, it } from "vitest";
import type { ImportConfig } from "../../src/bitrix/importConfig.js";
import {
  applyTransform,
  buildEntityFields,
  buildOriginId,
  decideAction,
  renderTemplate,
  resolveDuplicateFilters,
  resolveFieldValue,
  validateRequired
} from "../../src/bitrix/importPlanner.js";

describe("renderTemplate", () => {
  it("substitutes column values into placeholders", () => {
    expect(renderTemplate("[{orderId}] {company}", { orderId: "42", company: "ТОО Ромашка" }))
      .toBe("[42] ТОО Ромашка");
  });

  it("replaces missing keys with an empty string and trims the result", () => {
    expect(renderTemplate("order:{missing}", {})).toBe("order:");
    expect(renderTemplate(" {a} ", { a: "x" })).toBe("x");
  });
});

describe("applyTransform", () => {
  it("parses money with spaces and comma decimal separator", () => {
    expect(applyTransform("1 234,50", "money")).toBe(1234.5);
    expect(applyTransform("не число", "money")).toBeNull();
  });

  it("accepts only 12-digit BINs", () => {
    expect(applyTransform("123456789012", "bin")).toBe("123456789012");
    expect(applyTransform("БИН 123456789012", "bin")).toBe("123456789012");
    expect(applyTransform("12345", "bin")).toBeNull();
  });

  it("takes the first email from a separated list and validates it", () => {
    expect(applyTransform("a@b.kz; c@d.kz", "email")).toBe("a@b.kz");
    expect(applyTransform("not-an-email", "email")).toBeNull();
  });

  it("normalizes phones and rejects too-short values", () => {
    expect(applyTransform("+7 (777) 123-45-67", "phone")).toBe("+77771234567");
    expect(applyTransform("12", "phone")).toBeNull();
  });

  it("accepts only http(s) urls", () => {
    expect(applyTransform("https://goszakup.gov.kz", "url")).toBe("https://goszakup.gov.kz");
    expect(applyTransform("ftp://x.kz", "url")).toBeNull();
    expect(applyTransform("nope", "url")).toBeNull();
  });

  it("extracts digits and trims", () => {
    expect(applyTransform("a1b2", "digits")).toBe("12");
    expect(applyTransform("  x ", "trim")).toBe("x");
    expect(applyTransform("   ", "trim")).toBeNull();
  });
});

describe("resolveFieldValue", () => {
  it("returns constants as-is", () => {
    expect(resolveFieldValue({ value: "KZT" }, {})).toBe("KZT");
  });

  it("returns null for empty column values", () => {
    expect(resolveFieldValue({ column: "phone" }, { phone: "  " })).toBeNull();
  });

  it("applies transforms to column values", () => {
    expect(resolveFieldValue({ column: "amount", transform: "money" }, { amount: "10 000" })).toBe(10000);
  });
});

describe("buildEntityFields", () => {
  it("maps columns, templates and constants, dropping empty values", () => {
    const fields = buildEntityFields(
      {
        TITLE: { template: "[{id}] {name}" },
        COMMENTS: { column: "comment" },
        CURRENCY_ID: { value: "KZT" }
      },
      { id: "7", name: "ТОО Тест", comment: "" }
    );
    expect(fields).toEqual({ TITLE: "[7] ТОО Тест", CURRENCY_ID: "KZT" });
  });

  it("wraps CRM multi-fields into VALUE/VALUE_TYPE arrays", () => {
    const fields = buildEntityFields(
      { PHONE: { column: "phone", transform: "phone" }, EMAIL: { column: "email", transform: "email" } },
      { phone: "+7 777 123 45 67", email: "a@b.kz" }
    );
    expect(fields.PHONE).toEqual([{ VALUE: "+77771234567", VALUE_TYPE: "WORK" }]);
    expect(fields.EMAIL).toEqual([{ VALUE: "a@b.kz", VALUE_TYPE: "WORK" }]);
  });

  it("drops fields whose transform rejects the value", () => {
    const fields = buildEntityFields(
      { EMAIL: { column: "email", transform: "email" } },
      { email: "мусор" }
    );
    expect(fields).toEqual({});
  });
});

describe("validateRequired and buildOriginId", () => {
  it("reports missing required columns", () => {
    const row = { rowNumber: 2, values: { orderId: "1", company: "" } };
    expect(validateRequired({ required: ["orderId", "company"] }, row))
      .toEqual(['missing required column "company"']);
  });

  it("builds the origin id from the template", () => {
    const row = { rowNumber: 2, values: { orderId: "42" } };
    expect(buildOriginId({ originIdTemplate: "order:{orderId}" }, row)).toBe("order:42");
  });
});

describe("resolveDuplicateFilters", () => {
  it("skips checks with unresolvable values and keeps complete ones", () => {
    const config: Pick<ImportConfig, "duplicateChecks"> = {
      duplicateChecks: [
        { reason: "phone", filter: { PHONE: { column: "phone", transform: "phone" } } },
        { reason: "email", filter: { EMAIL: { column: "email", transform: "email" } } }
      ]
    };
    const row = { rowNumber: 2, values: { phone: "+77771234567", email: "" } };
    expect(resolveDuplicateFilters(config, row)).toEqual([
      { reason: "phone", filter: { PHONE: "+77771234567" } }
    ]);
  });
});

describe("decideAction", () => {
  it("prioritizes skip, then existing/update, then duplicate, then create", () => {
    expect(decideAction({ issueCount: 1, existingId: "5", duplicateId: null, updateExisting: true })).toBe("skip");
    expect(decideAction({ issueCount: 0, existingId: "5", duplicateId: null, updateExisting: false })).toBe("existing");
    expect(decideAction({ issueCount: 0, existingId: "5", duplicateId: null, updateExisting: true })).toBe("update");
    expect(decideAction({ issueCount: 0, existingId: null, duplicateId: "9", updateExisting: false })).toBe("duplicate");
    expect(decideAction({ issueCount: 0, existingId: null, duplicateId: null, updateExisting: false })).toBe("create");
  });
});
