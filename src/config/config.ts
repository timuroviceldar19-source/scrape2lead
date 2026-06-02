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
  fixturePath: z.string().optional()
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

  const parsed = ConfigSchema.parse({
    ...fileConfig,
    proxyApiUrl: process.env.PROXY_API_URL || fileConfig.proxyApiUrl,
    proxy: envProxy ?? fileConfig.proxy,
    ...overrides
  });

  return {
    ...parsed,
    databasePath: path.resolve(parsed.databasePath),
    exportDir: path.resolve(parsed.exportDir),
    rawSnapshotDir: path.resolve(parsed.rawSnapshotDir),
    fixturePath: parsed.fixturePath ? path.resolve(parsed.fixturePath) : undefined
  };
}
