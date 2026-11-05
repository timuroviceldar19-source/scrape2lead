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

it("restores closed-month cache before collection and saves each run independently", () => {
  const cache = workflow.indexOf("- name: Cache pult closed months");
  expect(cache).toBeGreaterThan(-1);
  expect(cache).toBeLessThan(workflow.indexOf("- name: Run Sales Pult"));
  expect(workflow.slice(cache)).toContain("path: data/pult-months");
  expect(workflow.slice(cache)).toContain("key: gz-pult-months-v1-${{ github.run_id }}");
});

it("imports verified education contracts only on request and before generating the site", () => {
  const start = workflow.indexOf("- name: Import verified education history");
  const run = workflow.indexOf("- name: Run Sales Pult");
  expect(start).toBeGreaterThan(workflow.indexOf("- name: Cache market data"));
  expect(run).toBeGreaterThan(start);
  const step = workflow.slice(start, run);
  expect(step).toContain("if: ${{ inputs.market_import_education == true }}");
  expect(step).toContain("--pattern education-kits-2026.json");
  expect(step).toContain("npx tsx scripts/market-import-education.mts data/market/education-kits-2026.json");
});
