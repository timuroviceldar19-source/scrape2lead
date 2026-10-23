import { describe, expect, it } from "vitest";
import { parseGoszakupPlanDetailHtml } from "../../src/kz/goszakupPlanHtmlParser.js";

const PLAN_ID = "88303329";
const itemField = '<input name="enstru-name" value="Компьютер" readonly>';

describe("plan act date in HTML details", () => {
  it.each([
    ["2026-10-19", "2026-10-19"],
    ["19.10.2026", "2026-10-19"]
  ])("reads the current portal act_date_tmp input (%s)", (value, expected) => {
    const html = `
      ${itemField}
      <label for="act_date">Дата акта, которым утвержден (изменен) годовой план</label>
      <input type="text" name="act_date_tmp" id="act_date_tmp"
        value="${value}" readonly="readonly" disabled="disabled" />
    `;

    expect(parseGoszakupPlanDetailHtml(html, PLAN_ID)?.date_approved).toBe(expected);
  });

  it("finds the act date by input id when the input name differs", () => {
    const html = `${itemField}<input value='2026-10-19' id='act_date_tmp' name='readonly_date'>`;

    expect(parseGoszakupPlanDetailHtml(html, PLAN_ID)?.date_approved).toBe("2026-10-19");
  });

  it("preserves the date from legacy labelled fields", () => {
    const html = `
      ${itemField}
      <table><tr><th>Дата акта, которым утвержден план</th><td>19.10.2026</td></tr></table>
    `;

    expect(parseGoszakupPlanDetailHtml(html, PLAN_ID)?.date_approved).toBe("2026-10-19");
  });

  it("keeps the legacy labelled value authoritative when both formats occur", () => {
    const html = `
      ${itemField}
      <table><tr><th>Дата утверждения</th><td>19.10.2026</td></tr></table>
      <input name="act_date_tmp" value="2026-10-22">
    `;

    expect(parseGoszakupPlanDetailHtml(html, PLAN_ID)?.date_approved).toBe("2026-10-19");
  });

  it("does not substitute a publication date when the act date is absent", () => {
    const html = `${itemField}<input name="publish_date" value="2026-10-22">`;

    expect(parseGoszakupPlanDetailHtml(html, PLAN_ID)?.date_approved).toBeNull();
  });

  it("returns null when the act date input is empty", () => {
    const html = `${itemField}<input name="act_date_tmp" value="">`;

    expect(parseGoszakupPlanDetailHtml(html, PLAN_ID)?.date_approved).toBeNull();
  });
});
