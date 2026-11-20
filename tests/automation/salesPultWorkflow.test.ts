import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

describe("Sales pult workflow competitors cache and backfill", () => {
  it("caches data/competitors, sets NODE_EXTRA_CA_CERTS, and supports competitors_backfill_from", () => {
    expect(workflow).toMatch(/competitors_backfill_from:[\s\S]*?required:\s*false[\s\S]*?type:\s*string/);
    const cache = workflow.indexOf("- name: Cache competitors data");
    const run = workflow.indexOf("- name: Run Sales Pult");
    expect(cache).toBeGreaterThan(-1);
    expect(cache).toBeLessThan(run);
    expect(workflow.slice(cache, run)).toContain("path: data/competitors");
    expect(workflow.slice(cache, run)).toContain("key: gz-competitors-v1-${{ github.run_id }}");

    const runStep = workflow.slice(run, workflow.indexOf("- name: Deploy"));
    expect(workflow).toContain("timeout-minutes:");
    expect(runStep).toContain("NODE_EXTRA_CA_CERTS: certs/rapidssl-tls-rsa-ca-g1.crt");
    expect(runStep).toContain("--competitors-backfill-from");
  });
});

describe("Sales pult workflow spec templates secret", () => {
  const start = workflow.indexOf("- name: Spec templates from secret");
  const end = workflow.indexOf("- name:", start + 10);
  const step = workflow.slice(start, end);
  const script = step
    .slice(step.indexOf("run: |") + "run: |".length)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");

  function runStep(secret: string): { code: number | null; out: string; file: string | null } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-tpl-step-"));
    try {
      const res = spawnSync("bash", ["-c", script], {
        cwd: dir,
        env: { ...process.env, SPEC_TEMPLATES: secret },
        encoding: "utf8"
      });
      const target = path.join(dir, "data/spec-templates.json");
      return {
        code: res.status,
        out: `${res.stdout}${res.stderr}`,
        file: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("writes the SPEC_TEMPLATES secret to data/ before the pult run", () => {
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(workflow.indexOf("- name: Run Sales Pult"));
    expect(step).toContain("SPEC_TEMPLATES: ${{ secrets.SPEC_TEMPLATES }}");
    expect(step).toContain("data/spec-templates.json");
  });

  it("keeps the build green and never prints the template text", () => {
    const secretText = "секретная фраза из ТС заказчика";
    const ok = runStep(JSON.stringify({ templates: [{ id: "a", name: "A", text: secretText }] }));
    expect(ok.code).toBe(0);
    expect(ok.file).toContain(secretText);
    expect(ok.out).toContain("шаблонов 1");
    expect(ok.out).not.toContain(secretText);

    const missing = runStep("");
    expect(missing.code).toBe(0);
    expect(missing.file).toBeNull();
    expect(missing.out).toContain("::warning::");

    const broken = runStep(`{"templates": [${secretText}`);
    expect(broken.code).toBe(0);
    expect(broken.file).toBeNull();
    expect(broken.out).toContain("::warning::");
    expect(broken.out).not.toContain(secretText);
  });
});

describe("Sales pult workflow competitors seed from the encrypted draft release", () => {
  const jobStart = workflow.indexOf("  seed-competitors:");
  const jobEnd = workflow.indexOf("  run-pult:");
  const job = workflow.slice(jobStart, jobEnd);
  const stepStart = job.indexOf("- name: Download and decrypt competitors seed");
  const stepEnd = job.indexOf("- name:", stepStart + 10);
  const step = job.slice(stepStart, stepEnd);
  const script = step
    .slice(step.indexOf("run: |") + "run: |".length)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");

  it("runs only on request, with write access but without npm packages or other secrets", () => {
    expect(workflow).toMatch(/competitors_seed:[\s\S]*?default:\s*false[\s\S]*?type:\s*boolean/);
    expect(jobStart).toBeGreaterThan(-1);
    expect(jobStart).toBeLessThan(jobEnd);
    expect(job).toContain("if: ${{ inputs.competitors_seed == true }}");
    expect(job).toMatch(/permissions:\s*\n\s*contents: write/);
    expect(job).not.toContain("npm ci");
    expect(job.match(/secrets\.[A-Z_]+/g)).toEqual(["secrets.COMPETITORS_SEED_KEY"]);
    expect(job).toContain("uses: actions/cache/save@v4");
    expect(job).toContain("key: gz-competitors-v1-seed-${{ github.run_id }}");

    const pult = workflow.slice(jobEnd);
    expect(pult).toMatch(/needs: seed-competitors/);
    expect(pult).toContain("if: ${{ !cancelled() }}");
    // Пульт берёт самый свежий кэш по префиксу, то есть только что залитую копию.
    expect(pult).toContain("gz-competitors-v1-");
    expect(workflow.slice(0, jobEnd)).not.toMatch(/^permissions:/m);
  });

  function runSeedStep(env: Record<string, string>, seedFile: string | null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-seed-step-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.copyFileSync(path.resolve("scripts/competitors-seed.mjs"), path.join(dir, "scripts/competitors-seed.mjs"));
    // Подставной gh: кладёт подготовленный файл туда, куда просит --dir.
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do if [ "$1" = "--dir" ]; then D="$2"; fi; shift; done\n` +
        (seedFile ? `cp "${seedFile}" "$D/competitors.db.enc"\n` : "exit 1\n"),
      { mode: 0o755 }
    );
    const res = spawnSync("bash", ["-c", script], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: path.join(dir, "tmp"), ...env },
      encoding: "utf8"
    });
    const dbPath = path.join(dir, "data/competitors/competitors.db");
    const restored = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: res.status, out: `${res.stdout}${res.stderr}`, restored };
  }

  it("restores the database with the right key and fails loudly otherwise", async () => {
    // @ts-expect-error -- plain ESM script without types
    const { packSeed } = await import("../../scripts/competitors-seed.mjs");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "comp-seed-src-"));
    try {
      const db = path.join(work, "competitors.db");
      fs.writeFileSync(db, Buffer.from("SQLite format 3\u0000" + "строка\n".repeat(1000), "utf8"));
      const key = crypto.randomBytes(32).toString("base64");
      const enc = path.join(work, "competitors.db.enc");
      await packSeed(db, enc, key);

      const ok = runSeedStep({ COMPETITORS_SEED_KEY: key }, enc);
      expect(ok.code).toBe(0);
      expect(ok.restored?.equals(fs.readFileSync(db))).toBe(true);
      expect(ok.out).not.toContain(key);

      const noKey = runSeedStep({ COMPETITORS_SEED_KEY: "" }, enc);
      expect(noKey.code).not.toBe(0);
      expect(noKey.out).toContain("::error::");
      expect(noKey.restored).toBeNull();

      const wrongKey = runSeedStep({ COMPETITORS_SEED_KEY: crypto.randomBytes(32).toString("base64") }, enc);
      expect(wrongKey.code).not.toBe(0);
      expect(wrongKey.restored).toBeNull();

      const noRelease = runSeedStep({ COMPETITORS_SEED_KEY: key }, null);
      expect(noRelease.code).not.toBe(0);
      expect(noRelease.restored).toBeNull();
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
