import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RuntimeConfig } from "../types.js";

const ConfigSchema = z.object({
  source: z.string().default("2gis"),
  geo: z.string().min(1),
  category: z.string().min(1),
  limit: z.coerce.number().int().positive().default(100),
  databasePath: z.string().default("data/scrape2lead.db"),
  exportDir: z.string().default("exports"),
  delayRangeMs: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).default([1200, 2500]),
  rotateEveryN: z.coerce.number().int().positive().default(50),
  maxRetries: z.coerce.number().int().nonnegative().default(2),
  concurrency: z.coerce.number().int().positive().default(1),
  headless: z.boolean().default(true),
  proxyApiUrl: z.string().url().optional(),
  proxy: z
    .object({
      server: z.string().min(1),
      username: z.string().optional(),
      password: z.string().optional()
    })
    .optional(),
  rawSnapshotDir: z.string().default("raw_snapshots"),
  fixturePath: z.string().optional(),
  rateLimit: z
    .object({
      maxCardsPerSession: z.coerce.number().int().positive().optional(),
      maxCardsPerMinute: z.coerce.number().int().positive().optional(),
      maxSessionDurationMs: z.coerce.number().int().positive().optional(),
      maxCardsPerProxy: z.coerce.number().int().positive().optional(),
      maxRequestsPerMinutePerProxy: z.coerce.number().int().positive().optional()
    })
    .optional(),
  websiteCrawl: z
    .object({
      enabled: z.boolean().optional(),
      maxPages: z.coerce.number().int().positive().optional(),
      timeoutMs: z.coerce.number().int().positive().optional()
    })
    .default({
      enabled: true,
      maxPages: 3,
      timeoutMs: 5000
    }),
  /**
   * Storage backend selector. `"sqlite"` (default) keeps the existing
   * `better-sqlite3` behaviour; `"postgres"` switches the CLI to
   * {@link PostgresStorage} (configured via `POSTGRES_CONNECTION_STRING`
   * or `postgresConnectionString` in this file). See `docs/storage.md`.
   */
  storageBackend: z.enum(["sqlite", "postgres"]).default("sqlite"),
  /**
   * Postgres connection string. Ignored unless `storageBackend` is
   * `"postgres"`. Kept separate from `databasePath` so the SQLite field
   * is never silently mis-used.
   */
  postgresConnectionString: z.string().min(1).optional()
});

export function loadConfig(configPath: string, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const fileConfig = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>
    : {};

  const envProxy = process.env.PROXY_SERVER
    ? {
        server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME || undefined,
        password: process.env.PROXY_PASSWORD || undefined
      }
    : undefined;

  const storageBackend = (process.env.STORAGE_BACKEND ??
    fileConfig["storageBackend"] ??
    "sqlite") as string;

  const parsed = ConfigSchema.parse({
    ...fileConfig,
    proxyApiUrl: process.env.PROXY_API_URL || fileConfig.proxyApiUrl,
    proxy: envProxy ?? fileConfig.proxy,
    storageBackend,
    postgresConnectionString:
      process.env.POSTGRES_CONNECTION_STRING || fileConfig["postgresConnectionString"] || undefined,
    ...overrides
  });

  // Strip the Postgres-only fields before forwarding to the SQLite
  // implementation. They are stored on the returned config so the CLI's
  // backend selector can read them, but the SQLite `Storage` class
  // must not be handed an unknown field.
  return {
    ...parsed,
    databasePath: path.resolve(parsed.databasePath),
    exportDir: path.resolve(parsed.exportDir),
    rawSnapshotDir: path.resolve(parsed.rawSnapshotDir),
    fixturePath: parsed.fixturePath ? path.resolve(parsed.fixturePath) : undefined
  };
}
