import { describe, expect, it } from "vitest";
import {
  GZ_PLAN_DETAILS_FIELD_NAMES,
  GZ_PLAN_DETAILS_SECTION_NAME,
  mergeGzPlanDetailsSection
} from "../../src/bitrix/gzPlanDealLayout.js";

describe("GZ plan deal card layout", () => {
  const existing = [
    {
      name: "main",
      title: "О сделке",
      type: "section" as const,
      elements: [{ name: "TITLE", optionFlags: "0" }]
    },
    {
      name: "required",
      title: "Обязательные поля",
      type: "section" as const,
      elements: [{ name: "UF_CRM_PLAN_LINK", optionFlags: "0" }]
    }
  ];

  it("preserves the current card and adds a dedicated plan-data section", () => {
    const result = mergeGzPlanDetailsSection(existing);

    expect(result.slice(0, 2)).toEqual(existing);
    const planSection = result.find((section) => section.name === GZ_PLAN_DETAILS_SECTION_NAME);
    expect(planSection?.title).toBe("Данные плана закупки");
    expect(planSection?.elements.map((element) => element.name)).toEqual(
      GZ_PLAN_DETAILS_FIELD_NAMES.filter((name) => name !== "UF_CRM_PLAN_LINK")
    );
  });

  it("never duplicates a field that is already visible elsewhere", () => {
    const result = mergeGzPlanDetailsSection(existing);
    const allFields = result.flatMap((section) => section.elements.map((element) => element.name));

    expect(allFields.filter((name) => name === "UF_CRM_PLAN_LINK")).toHaveLength(1);
    expect(new Set(allFields).size).toBe(allFields.length);
  });

  it("is idempotent and replaces a stale generated section", () => {
    const stale = [
      ...existing,
      {
        name: GZ_PLAN_DETAILS_SECTION_NAME,
        title: "Старый заголовок",
        type: "section" as const,
        elements: [{ name: "OBSOLETE_FIELD", optionFlags: "0" }]
      }
    ];

    const once = mergeGzPlanDetailsSection(stale);
    const twice = mergeGzPlanDetailsSection(once);

    expect(twice).toEqual(once);
    expect(twice.flatMap((section) => section.elements.map((element) => element.name)))
      .not.toContain("OBSOLETE_FIELD");
  });

  it("does not mutate the live configuration object returned by Bitrix", () => {
    const snapshot = structuredClone(existing);
    mergeGzPlanDetailsSection(existing);
    expect(existing).toEqual(snapshot);
  });
});
