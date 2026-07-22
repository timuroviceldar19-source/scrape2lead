import { describe, expect, it, vi } from "vitest";
import { waitForProcurementAssignments } from "../../src/bitrix/procurementAssignmentControl.js";

describe("procurement assignment control", () => {
  it("waits until every newly-created deal is assigned to the sales pool", async () => {
    const readDeal = vi.fn()
      .mockResolvedValueOnce({ ID: "10", ASSIGNED_BY_ID: "2301" })
      .mockResolvedValueOnce({ ID: "10", ASSIGNED_BY_ID: "147" });

    const result = await waitForProcurementAssignments(["10"], readDeal, {
      managerIds: ["147", "1751", "725"], timeoutMs: 10, pollIntervalMs: 0
    });

    expect(result).toEqual({ ok: true, invalidDealIds: [] });
    expect(readDeal).toHaveBeenCalledTimes(2);
  });

  it("fails closed for a missing deal or an assignee outside the pool", async () => {
    const readDeal = vi.fn(async (id: string) => id === "10"
      ? { ID: id, ASSIGNED_BY_ID: "2301" }
      : null);

    const result = await waitForProcurementAssignments(["10", "11"], readDeal, {
      managerIds: ["147", "1751", "725"], timeoutMs: 0, pollIntervalMs: 0
    });

    expect(result).toEqual({ ok: false, invalidDealIds: ["10", "11"] });
  });

  it("does nothing when the push created no new deals", async () => {
    const readDeal = vi.fn();
    await expect(waitForProcurementAssignments([], readDeal, {
      managerIds: ["205"], timeoutMs: 0, pollIntervalMs: 0
    })).resolves.toEqual({ ok: true, invalidDealIds: [] });
    expect(readDeal).not.toHaveBeenCalled();
  });
});
