import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = fs.readFileSync(path.resolve(".github/workflows/sales-pult.yml"), "utf8");

describe("Sales pult workflow market cache", () => {
  it("seeds market data from the market-seed release only when the cache came back empty", () => {
    const restore = workflow.indexOf("- name: Cache market data");
    const seed = workflow.indexOf("- name: Seed market data");
    const run = workflow.indexOf("- name: Run Sales Pult");

    expect(restore).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(restore);
    expect(run).toBeGreaterThan(seed);

    const step = workflow.slice(seed, run);
    expect(step).toContain("if: hashFiles('data/market/units-2026.json') == ''");
    expect(step).toContain("gh release download market-seed --pattern units-2026.json --dir data/market");
    expect(step).toContain("GH_TOKEN: ${{ github.token }}");
    // A missing seed must not break the site build: the market tab just stays empty.
    expect(step).toContain("::warning::");
  });
});
