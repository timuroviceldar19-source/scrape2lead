import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without types: the seed job runs it without npm ci
import { packSeed, unpackSeed } from "../../scripts/competitors-seed.mjs";

const SCRIPT = path.resolve("scripts/competitors-seed.mjs");
const key = () => crypto.randomBytes(32).toString("base64");

describe("competitors seed: encrypted copy of the local database", () => {
  let dir: string;
  let db: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-seed-"));
    db = path.join(dir, "competitors.db");
    // Выдуманная «база»: заголовок SQLite и повторяющийся текст, чтобы сжатие было заметно.
    const body = Buffer.from("SQLite format 3\u0000" + "лот;заказчик;цена\n".repeat(20_000), "utf8");
    fs.writeFileSync(db, body);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("packs to a smaller encrypted file and unpacks byte-for-byte", async () => {
    const k = key();
    const enc = path.join(dir, "seed.enc");
    const out = path.join(dir, "restored.db");
    await packSeed(db, enc, k);

    const packed = fs.readFileSync(enc);
    expect(packed.subarray(0, 8).toString("latin1")).toBe("S2LSEED1");
    expect(packed.length).toBeLessThan(fs.statSync(db).size / 4);
    expect(packed.includes(Buffer.from("заказчик"))).toBe(false);

    await unpackSeed(enc, out, k, { expectSqlite: true });
    expect(fs.readFileSync(out).equals(fs.readFileSync(db))).toBe(true);
  });

  it("rejects a wrong key or a tampered file and leaves no output", async () => {
    const enc = path.join(dir, "seed.enc");
    const out = path.join(dir, "restored.db");
    await packSeed(db, enc, key());

    await expect(unpackSeed(enc, out, key())).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);

    const k = key();
    await packSeed(db, enc, k);
    const bytes = fs.readFileSync(enc);
    bytes[40] ^= 0xff;
    fs.writeFileSync(enc, bytes);
    await expect(unpackSeed(enc, out, k)).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
  });

  it("refuses a file that is not a SQLite database when asked to check", async () => {
    const k = key();
    const notDb = path.join(dir, "notes.txt");
    fs.writeFileSync(notDb, "просто текст ".repeat(100));
    const enc = path.join(dir, "seed.enc");
    const out = path.join(dir, "restored.db");
    await packSeed(notDb, enc, k);
    await expect(unpackSeed(enc, out, k, { expectSqlite: true })).rejects.toThrow(/SQLite/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("CLI takes the key from COMPETITORS_SEED_KEY and never prints it", () => {
    const k = key();
    const enc = path.join(dir, "seed.enc");
    const out = path.join(dir, "restored.db");
    const run = (args: string[], env: Record<string, string | undefined>) =>
      spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });

    const packed = run(["pack", db, enc], { COMPETITORS_SEED_KEY: k });
    expect(packed.status).toBe(0);
    const unpacked = run(["unpack", enc, out, "--expect-sqlite"], { COMPETITORS_SEED_KEY: k });
    expect(unpacked.status).toBe(0);
    expect(`${packed.stdout}${packed.stderr}${unpacked.stdout}${unpacked.stderr}`).not.toContain(k);
    expect(fs.readFileSync(out).equals(fs.readFileSync(db))).toBe(true);

    const noKey = run(["unpack", enc, out], { COMPETITORS_SEED_KEY: "" });
    expect(noKey.status).not.toBe(0);
    expect(noKey.stderr).toContain("COMPETITORS_SEED_KEY");

    const shortKey = run(["unpack", enc, out], { COMPETITORS_SEED_KEY: "abc" });
    expect(shortKey.status).not.toBe(0);
    expect(shortKey.stderr).not.toContain("abc");
  });
});

describe("competitors backfill time budget", () => {
  it("stops a full backfill before the 240-minute job limit so the cache is saved", async () => {
    const { resolveBackfillBudgetMs, DEFAULT_BACKFILL_BUDGET_MIN } = await import("../../src/kz/competitors/load.js");
    expect(DEFAULT_BACKFILL_BUDGET_MIN).toBe(200);
    expect(resolveBackfillBudgetMs([])).toBe(200 * 60 * 1000);
    expect(resolveBackfillBudgetMs(["--competitors-budget-min", "30"])).toBe(30 * 60 * 1000);
    expect(resolveBackfillBudgetMs(["--competitors-budget-min", "abc"])).toBe(200 * 60 * 1000);
    expect(resolveBackfillBudgetMs(["--competitors-budget-min", "0"])).toBe(200 * 60 * 1000);

    const script = fs.readFileSync("scripts/sales-pult.mts", "utf8");
    const backfillCall = script.slice(script.indexOf("await backfillCompetitors("), script.indexOf("Докачка завершена"));
    expect(backfillCall).toContain("maxDurationMs: resolveBackfillBudgetMs(args)");
  });
});
