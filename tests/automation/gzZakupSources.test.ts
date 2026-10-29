import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("утренние команды без обязательного токена ows", () => {
  for (const file of ["scripts/check-gz-deal-outcomes.mts", "scripts/bitrix-refresh-gz-plan-status.mts", "scripts/bitrix-sync-gz-plan-items.mts", "scripts/bitrix-backfill-gz-lot-dates.mts"]) {
    it(`${file}: GOSZAKUP_TOKEN только для резерва`, () => {
      expect(fs.readFileSync(file, "utf8")).not.toMatch(/if\s*\(![\w.]*token\)\s*throw new Error\("GOSZAKUP_TOKEN is required"\)/);
    });
  }
  it("выгрузка лотов запрашивает сроки и без токена", () => {
    const source = fs.readFileSync("scripts/bitrix-push-gz-lots.mts", "utf8");
    expect(source.slice(source.indexOf("async function lookupBidWindow"))).not.toContain("if (!token) return null");
  });
});
