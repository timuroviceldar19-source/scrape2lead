import { describe, expect, it } from "vitest";
import { planProcurementReassignments } from "../../src/bitrix/procurementReassignment.js";

describe("procurement deal reassignment", () => {
  it("reassigns only integration-owned category-1 deals and changes no field except the assignee", () => {
    const result = planProcurementReassignments([
      {
        ID: "43001", CATEGORY_ID: "1", STAGE_ID: "C1:NEW", ASSIGNED_BY_ID: "1751",
        ORIGINATOR_ID: "scrape2lead-procurement", ORIGIN_ID: "proc:samruk:plan:3231947791"
      },
      {
        ID: "43003", CATEGORY_ID: "1", STAGE_ID: "C1:NEW", ASSIGNED_BY_ID: "2255",
        ORIGINATOR_ID: "scrape2lead-procurement", ORIGIN_ID: "proc:samruk:plan:3338426062"
      },
      {
        ID: "manual", CATEGORY_ID: "1", STAGE_ID: "C1:NEW", ASSIGNED_BY_ID: "147",
        ORIGINATOR_ID: null, ORIGIN_ID: null
      },
      {
        ID: "other-pipeline", CATEGORY_ID: "9", STAGE_ID: "NEW", ASSIGNED_BY_ID: "147",
        ORIGINATOR_ID: "scrape2lead-procurement", ORIGIN_ID: "proc:samruk:plan:other"
      }
    ]);

    expect(result).toEqual([{
      dealId: "43001",
      previousAssigneeId: "1751",
      stageId: "C1:NEW",
      fields: { ASSIGNED_BY_ID: "2255" }
    }]);
  });
});
