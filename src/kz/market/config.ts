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
    if (typeof (cfg as any).bin === "string" && /^\d{12}$/.test((cfg as any).bin)) {
      cfg.ourBins = [(cfg as any).bin];
    } else {
      throw new Error(`Invalid market config at ${cfgPath}: ourBins must be a non-empty array of 12-digit BINs`);
    }
  }

  for (const b of cfg.ourBins) {
    if (typeof b !== "string" || !/^\d{12}$/.test(b)) {
      throw new Error(`Invalid BIN "${b}" in ourBins: must be exactly 12 digits`);
    }
  }

  if (!cfg.bin && cfg.ourBins.length > 0) {
    cfg.bin = cfg.ourBins[0];
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
