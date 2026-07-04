import { describe, expect, it } from "vitest";
import {
  buildGzLeadCleanupFilter,
  findExactUsersByName,
  formatBitrixUserName,
  isGzOriginId,
  isSafeGzLeadForAssignee
} from "../src/bitrix/gzLeadCleanup.js";

describe("bitrix GZ lead cleanup safety", () => {
  it("matches an active Bitrix user by exact first and last name", () => {
    const users = [
      { ID: 1, NAME: "Эльдар", LAST_NAME: "Айткенов", ACTIVE: "Y" },
      { ID: 2, NAME: "Эльдар", LAST_NAME: "Другой", ACTIVE: "Y" },
      { ID: 3, NAME: "Эльдар", LAST_NAME: "Айткенов", ACTIVE: "N" }
    ];

    expect(findExactUsersByName(users, "Эльдар Айткенов")).toEqual([
      { ID: 1, NAME: "Эльдар", LAST_NAME: "Айткенов", ACTIVE: "Y" }
    ]);
  });

  it("requires GZ originator, GZ origin id, and matching assignee before delete", () => {
    expect(isSafeGzLeadForAssignee({
      ID: 10,
      ORIGINATOR_ID: "scrape2lead-gz-plans",
      ORIGIN_ID: "gz-plan:4798246",
      ASSIGNED_BY_ID: "42"
    }, "42")).toBe(true);

    expect(isSafeGzLeadForAssignee({
      ID: 11,
      ORIGINATOR_ID: "scrape2lead-gz-plans",
      ORIGIN_ID: "manual-import:4798246",
      ASSIGNED_BY_ID: "42"
    }, "42")).toBe(false);

    expect(isSafeGzLeadForAssignee({
      ID: 12,
      ORIGINATOR_ID: "scrape2lead-gz-plans",
      ORIGIN_ID: "gz-plan:4798246",
      ASSIGNED_BY_ID: "99"
    }, "42")).toBe(false);
  });

  it("builds the Bitrix list filter without broad deletion fields", () => {
    expect(buildGzLeadCleanupFilter("42")).toEqual({
      ORIGINATOR_ID: "scrape2lead-gz-plans",
      ASSIGNED_BY_ID: "42"
    });
  });

  it("recognizes only numeric GZ plan origin ids", () => {
    expect(isGzOriginId("gz-plan:123")).toBe(true);
    expect(isGzOriginId("gz-plan:abc")).toBe(false);
  });

  it("formats the Bitrix user name used for exact matching", () => {
    expect(formatBitrixUserName({ NAME: "Эльдар", LAST_NAME: "Айткенов" })).toBe("Эльдар Айткенов");
  });
});
