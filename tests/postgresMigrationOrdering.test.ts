/**
 * Postgres slice blocker regression tests (no live DB required).
 *
 * The `pg` module is mocked with an in-memory fake Pool that records every
 * query (text + bound params) in order. This lets us assert two properties
 * that previously broke the Postgres backend at runtime:
 *
 *  1. Clean-start migration ordering — the schema must be migrated before the
 *     first runtime query touches a table. PostgresStorage runs a lazy,
 *     memoised migration guard ahead of every `withClient`/`withTransaction`
 *     call, so even a direct first `saveRawSnapshot(...)` migrates first and
 *     migrates exactly once.
 *
 *  2. String raw-snapshot payloads — opaque HTML/text bodies such as
 *     "<captcha/>" are not valid JSON. With `raw_snapshots.payload` stored as
 *     TEXT and bound as a plain string (no ::jsonb cast), they go on the wire
 *     verbatim, matching the SQLite default. Non-string payloads are
 *     JSON-serialised first.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; params: unknown[] }>,
  connectCount: 0
}));

vi.mock("pg", () => {
  class FakePool {
    constructor(_config: unknown) {
      void _config;
    }
    async connect() {
      state.connectCount += 1;
      return {
        query: async (text: string, params: unknown[] = []) => {
          state.queries.push({ text, params });
          if (/SELECT MAX\(version\)/.test(text)) {
            return { rows: [{ version: null }], rowCount: 1 };
          }
          if (/RETURNING snapshot_id/.test(text)) {
            return { rows: [{ snapshot_id: 1 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined
      };
    }
    async end() {
      return undefined;
    }
  }
  return { Pool: FakePool };
});

import { PostgresStorage } from "../src/storage/postgres/PostgresStorage.js";

const MIGRATION_RECORD = /INSERT INTO schema_version \(version\)/;
const MIGRATION_VERSION_CHECK = /SELECT MAX\(version\)/;
const RAW_INSERT = /INSERT INTO raw_snapshots/;

beforeEach(() => {
  state.queries.length = 0;
  state.connectCount = 0;
});

describe("PostgresStorage clean-start migration ordering", () => {
  it("migrates the schema before the first runtime query", async () => {
    const pg = new PostgresStorage("postgres://user:pass@localhost:5432/db");
    await pg.saveRawSnapshot({
      source: "2gis",
      kind: "html",
      purpose: "captcha",
      payload: "<captcha/>"
    });

    const texts = state.queries.map((q) => q.text);
    const migrationIdx = texts.findIndex((t) => MIGRATION_RECORD.test(t));
    const insertIdx = texts.findIndex((t) => RAW_INSERT.test(t));

    expect(migrationIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(migrationIdx);
  });

  it("migrates exactly once across multiple queries", async () => {
    const pg = new PostgresStorage("postgres://user:pass@localhost:5432/db");
    await pg.saveRawSnapshot({ source: "2gis", kind: "html", purpose: "captcha", payload: "<captcha/>" });
    await pg.saveRawSnapshot({ source: "2gis", kind: "html", purpose: "error", payload: "<x/>" });
    await pg.countOpenTasks("job-1");

    const migrationRecords = state.queries.filter((q) => MIGRATION_RECORD.test(q.text));
    const versionChecks = state.queries.filter((q) => MIGRATION_VERSION_CHECK.test(q.text));

    expect(migrationRecords.length).toBeGreaterThanOrEqual(1);
    expect(versionChecks).toHaveLength(1);
  });
});

describe("PostgresStorage.saveRawSnapshot payload shapes", () => {
  it("stores a plain non-JSON string payload verbatim", async () => {
    const pg = new PostgresStorage("postgres://user:pass@localhost:5432/db");
    await pg.saveRawSnapshot({
      source: "2gis",
      kind: "html",
      purpose: "captcha",
      payload: "<captcha/>"
    });

    const insert = state.queries.find((q) => RAW_INSERT.test(q.text));
    expect(insert).toBeDefined();
    // params: [companyTaskId, source, externalId, kind, purpose, payload, ...]
    expect(insert?.params[5]).toBe("<captcha/>");
    // No ::jsonb cast on the payload bind.
    expect(insert?.text).not.toMatch(/\$6::jsonb/);
  });

  it("JSON-serialises a non-string (object) payload", async () => {
    const pg = new PostgresStorage("postgres://user:pass@localhost:5432/db");
    const body = { a: 1, nested: ["x"] };
    await pg.saveRawSnapshot({ source: "2gis", kind: "json", purpose: "fixture", payload: body });

    const insert = state.queries.find((q) => RAW_INSERT.test(q.text));
    expect(insert?.params[5]).toBe(JSON.stringify(body));
  });

  it("stores a null payload when none is supplied", async () => {
    const pg = new PostgresStorage("postgres://user:pass@localhost:5432/db");
    await pg.saveRawSnapshot({ source: "2gis", kind: "html", purpose: "error" });

    const insert = state.queries.find((q) => RAW_INSERT.test(q.text));
    expect(insert?.params[5]).toBeNull();
  });
});
