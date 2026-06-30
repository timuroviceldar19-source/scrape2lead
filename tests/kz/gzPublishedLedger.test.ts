import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePlanStatusIds, resolvePlanStatusNames } from "../../src/kz/gzPlansConfig.js";
import { GzPublishedLedger, buildGzPublishedFingerprint } from "../../src/kz/gzPublishedLedger.js";

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles) {
    fs.rmSync(file, { force: true });
  }
  tempFiles.length = 0;
});

function tempLedgerPath(): string {
  const file = path.join(os.tmpdir(), `gz-published-ledger-${Date.now()}-${Math.random()}.json`);
  tempFiles.push(file);
  return file;
}

describe("gz published status", () => {
  it("resolves published status by numeric id", () => {
    expect(resolvePlanStatusIds(["5"])).toEqual([5]);
    expect(resolvePlanStatusNames(["5"])).toEqual(["Опубликован"]);
  });
});

describe("GzPublishedLedger", () => {
  it("skips already recorded unchanged plan point", () => {
    const ledger = new GzPublishedLedger(tempLedgerPath());
    const fingerprint = "Опубликован|100|https://example.test/plan|Panel|Customer";

    expect(ledger.shouldUpdate("4801277", fingerprint)).toBe(true);
    ledger.record({
      plan_point_id: "4801277",
      previous_status: "Утвержден",
      detected_status: "Опубликован",
      detected_at: "2026-06-30T10:00:00.000Z",
      bitrix_lead_id: "19411",
      fingerprint
    });

    expect(ledger.shouldUpdate("4801277", fingerprint)).toBe(false);
    expect(ledger.shouldUpdate("4801277", `${fingerprint}|changed`)).toBe(true);
  });

  it("builds fingerprint from status and important published fields", () => {
    const base = buildGzPublishedFingerprint({
      status: "Опубликован",
      amount: "1 500 000.00",
      planUrl: "https://goszakup.gov.kz/plan/1",
      itemName: "Панель",
      customerName: "ГУ Тест"
    });
    const changed = buildGzPublishedFingerprint({
      status: "Опубликован",
      amount: "1 600 000.00",
      planUrl: "https://goszakup.gov.kz/plan/1",
      itemName: "Панель",
      customerName: "ГУ Тест"
    });

    expect(base).not.toBe(changed);
  });
});
