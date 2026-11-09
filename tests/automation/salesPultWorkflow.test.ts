import { spawnSync } from "node:child_process";
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
  expect(step).toContain("if: ${{ inputs.market_import_education == true || inputs.market_reseed == true }}");
  expect(step).toContain("--pattern education-kits-2026.json");
  expect(step).toContain("npx tsx scripts/market-import-education.mts data/market/education-kits-2026.json");
});

it("guards and resets reseeding before seed, with strict site-only update", () => {
  expect(workflow).toMatch(/market_reseed:[\s\S]*?default: false[\s\S]*?type: boolean/);
  const guard = workflow.indexOf("- name: Validate market reseed");
  const cache = workflow.indexOf("- name: Cache market data");
  const reset = workflow.indexOf("- name: Reset market history");
  const seed = workflow.indexOf("- name: Seed market data");
  expect(guard).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(workflow.indexOf("- name: Cache register history"));
  expect(reset).toBeGreaterThan(cache);
  expect(reset).toBeLessThan(seed);
  expect(workflow.slice(reset, seed)).toContain("if: ${{ inputs.market_reseed == true }}");
  expect(workflow.slice(reset, seed)).toContain("rm -f data/market/units-2026.json");
  expect(workflow.slice(guard, cache)).toContain('[ "$MODE" != "site" ]');
  expect(workflow.slice(guard, cache)).toContain('[ -n "$MARKET_BACKFILL" ]');
  const seedStep = workflow.slice(seed, workflow.indexOf("- name: Import verified education history"));
  expect(seedStep).toContain('[ "$MARKET_RESEED" = "true" ]');
  expect(seedStep).toContain("exit 1");
  expect(seedStep).toContain("::warning::");
  const run = workflow.slice(workflow.indexOf("- name: Run Sales Pult"), workflow.indexOf("- name: Deploy"));
  expect(run).toContain('RESEED_FLAGS="--market-update --market-update-strict"');
  expect(run).toContain('--mode site $BACKFILL_FLAG $RESEED_FLAGS');
  expect(run).toContain('[ "$MARKET_RESEED" = "true" ]');
  expect(run).not.toMatch(/--mode (morning|evening).*RESEED/);
});

// Execute the actual workflow shell with fake commands; no network or cache access.
function shellStep(name: string, env: Record<string, string>, mocks = "") {
  const step = workflow.split(`      - name: ${name}\n`)[1].split("\n      - name:")[0];
  const body = step.split("        run: |\n")[1].split("\n").map(line => line.slice(10)).join("\n");
  return spawnSync("bash", ["-c", `${mocks}\n${body}`], { encoding: "utf8", env: { ...process.env, ...env } });
}
it.each(["morning", "evening"])("rejects reseed in %s before cache access", mode => {
  const result = shellStep("Validate market reseed", { MODE: mode, MARKET_BACKFILL: "" });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("requires mode=site");
});
it("rejects a simultaneous backfill and accepts site reseed alone", () => {
  expect(shellStep("Validate market reseed", { MODE: "site", MARKET_BACKFILL: "2026-01-01" }).status).toBe(1);
  expect(shellStep("Validate market reseed", { MODE: "site", MARKET_BACKFILL: "" }).status).toBe(0);
});
it.each(["true", "false"])("handles failed seed download with reseed=%s", reseed => {
  const result = shellStep("Seed market data", { MARKET_RESEED: reseed }, "gh() { return 1; }; mkdir() { :; }");
  expect(result.status).toBe(reseed === "true" ? 1 : 0);
  expect(result.stdout).toContain(reseed === "true" ? "::error::" : "::warning::");
});
it.each(["true", "false"])("passes update flags only for site reseed=%s", reseed => {
  const result = shellStep("Run Sales Pult", { MODE: "site", MARKET_RESEED: reseed, MARKET_BACKFILL: "" }, 'npm() { echo "ARGS:$*"; }');
  expect(result.status).toBe(0);
  if (reseed === "true") expect(result.stdout).toContain("--market-update --market-update-strict");
  else expect(result.stdout).not.toContain("--market-update");
});
it("records all three counts and emits one restoration summary", () => {
  expect(workflow).toContain('echo "MARKET_SEED_COUNT=$COUNT" >> "$GITHUB_ENV"');
  expect(workflow).toContain('echo "MARKET_EDUCATION_COUNT=$COUNT" >> "$GITHUB_ENV"');
  const script = fs.readFileSync("scripts/sales-pult.mts", "utf8");
  expect(script.match(/Восстановление:/g)).toHaveLength(1);
  expect(script).toContain("в копии ${process.env.MARKET_SEED_COUNT}, после импорта комплектов ${process.env.MARKET_EDUCATION_COUNT}, после обновления окна ${total}");
});
