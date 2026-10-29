import fs from "node:fs";
import path from "node:path";
import type { MarketConfig } from "./types.js";

let cachedConfig: MarketConfig | null = null;
let compiledMatchers: Array<{ regex: RegExp; group: "ИП" | "КТ"; kind: string }> | null = null;

export function loadMarketConfig(customPath?: string): MarketConfig {
  if (!customPath && cachedConfig) return cachedConfig;
  const cfgPath = customPath || path.resolve("config/market-monitor.json");
  const raw = fs.readFileSync(cfgPath, "utf8");
  const cfg = JSON.parse(raw) as MarketConfig;

  if (!Array.isArray(cfg.ourBins) || cfg.ourBins.length === 0) {
    if (typeof cfg.bin === "string" && /^\d{12}$/.test(cfg.bin)) {
      cfg.ourBins = [cfg.bin];
    } else {
      throw new Error(`Invalid market config at ${cfgPath}: ourBins must be a non-empty array`);
    }
  }

  const companyNames: Record<string, string> = { ...cfg.ourCompanyNames };

  for (const item of cfg.ourBins) {
    if (typeof item === "string") {
      if (!/^\d{12}$/.test(item)) {
        throw new Error(`Invalid BIN "${item}" in ourBins: must be exactly 12 digits`);
      }
    } else if (item && typeof item === "object" && typeof item.bin === "string") {
      if (!/^\d{12}$/.test(item.bin)) {
        throw new Error(`Invalid BIN "${item.bin}" in ourBins: must be exactly 12 digits`);
      }
      if (item.name) {
        companyNames[item.bin] = item.name;
      }
    } else {
      throw new Error(`Invalid entry in ourBins: must be 12-digit string or { bin, name } object`);
    }
  }

  cfg.ourCompanyNames = companyNames;

  if (!cfg.bin && cfg.ourBins.length > 0) {
    const first = cfg.ourBins[0];
    cfg.bin = typeof first === "string" ? first : first.bin;
  }

  if (!customPath) cachedConfig = cfg;
  return cfg;
}

function getCompiledMatchers(cfg: MarketConfig) {
  if (compiledMatchers) return compiledMatchers;
  const list: Array<{ regex: RegExp; group: "ИП" | "КТ"; kind: string }> = [];

  for (const [groupKey, groupConf] of Object.entries(cfg.groups) as [
    "ИП" | "КТ",
    MarketConfig["groups"]["ИП" | "КТ"]
  ][]) {
    for (const kind of groupConf.kinds) {
      for (const pattern of kind.patterns) {
        list.push({
          regex: new RegExp(pattern),
          group: groupKey,
          kind: kind.name
        });
      }
    }
  }
  compiledMatchers = list;
  return list;
}

export function classifyCode(
  code: string,
  cfg: MarketConfig = loadMarketConfig()
): { group: "ИП" | "КТ"; kind: string } | null {
  const matchers = getCompiledMatchers(cfg);
  for (const m of matchers) {
    if (m.regex.test(code)) {
      return { group: m.group, kind: m.kind };
    }
  }
  return null;
}

export function getMethodName(methodId: number | string, cfg: MarketConfig = loadMarketConfig()): string {
  const strId = String(methodId);
  return cfg.methods[strId] ?? `Способ ${methodId}`;
}

export function isExcludedStatus(statusId: number, cfg: MarketConfig = loadMarketConfig()): boolean {
  return cfg.excludedStatuses.includes(statusId);
}

export function cleanEntityName(name: unknown): string {
  if (!name) return "";
  return String(name)
    .replace(/\s+/g, " ")
    .replace(/"{2,}/g, '"')
    .trim();
}
