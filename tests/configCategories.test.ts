import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { resolveCategories } from "../src/core/jobManager.js";
import type { RuntimeConfig } from "../src/types.js";

describe("config: categories array support", () => {
  it("accepts a single legacy `category` string", () => {
    const tmpDir = makeTmpConfig({ category: "Автозапчасти" });
    try {
      const config = loadConfig(tmpDir);
      expect(config.category).toBe("Автозапчасти");
      expect(config.categories).toBeUndefined();
      expect(resolveCategories(config)).toEqual(["Автозапчасти"]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("accepts a `categories` array and resolves them in order", () => {
    const tmpDir = makeTmpConfig({
      categories: ["Автозапчасти", "Шины и диски", "Автохимия", "Автоаксессуары"]
    });
    try {
      const config = loadConfig(tmpDir);
      expect(config.categories).toEqual([
        "Автозапчасти",
        "Шины и диски",
        "Автохимия",
        "Автоаксессуары"
      ]);
      expect(resolveCategories(config)).toEqual([
        "Автозапчасти",
        "Шины и диски",
        "Автохимия",
        "Автоаксессуары"
      ]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("prefers `categories` over legacy `category` when both are set", () => {
    const tmpDir = makeTmpConfig({
      category: "Стройматериалы",
      categories: ["Автозапчасти", "Шины и диски"]
    });
    try {
      const config = loadConfig(tmpDir);
      expect(resolveCategories(config)).toEqual(["Автозапчасти", "Шины и диски"]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("rejects configs with neither `category` nor `categories`", () => {
    const tmpDir = makeTmpConfig({});
    try {
      expect(() => loadConfig(tmpDir)).toThrowError(/category/);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("rejects an empty `categories` array", () => {
    const tmpDir = makeTmpConfig({ categories: [] });
    try {
      expect(() => loadConfig(tmpDir)).toThrowError();
    } finally {
      cleanup(tmpDir);
    }
  });
});

function makeTmpConfig(overrides: Record<string, unknown>): string {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-cfg-"));
  const filePath = path.join(dir, "config.json");
  const base = {
    source: "kaspi",
    geo: "Астана",
    limit: 10,
    databasePath: "data/test.db",
    exportDir: "exports",
    delayRangeMs: [1000, 2000],
    rotateEveryN: 5,
    maxRetries: 1,
    concurrency: 1,
    headless: true,
    rawSnapshotDir: "raw_snapshots"
  };
  fs.writeFileSync(filePath, JSON.stringify({ ...base, ...overrides }));
  return filePath;
}

function cleanup(filePath: string): void {
  const fs = require("node:fs") as typeof import("node:fs");
  try {
    fs.rmSync(filePath.replace(/config\.json$/, ""), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// Smoke: ensure RuntimeConfig now allows omitting `category` when `categories`
// is provided. This is a type-level contract, not a runtime test, but we
// assert via a no-op cast so an accidental type regression is loud.
const _typeCheck: RuntimeConfig = {
  source: "kaspi",
  geo: "Астана",
  categories: ["Автозапчасти"],
  limit: 1,
  databasePath: "data/test.db",
  exportDir: "exports",
  delayRangeMs: [0, 1],
  rotateEveryN: 1,
  maxRetries: 0,
  concurrency: 1,
  headless: true,
  rawSnapshotDir: "raw_snapshots"
};
void _typeCheck;
