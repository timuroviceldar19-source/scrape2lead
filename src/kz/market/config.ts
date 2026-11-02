import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MarketConfig } from "./types.js";

/**
 * Fingerprint of the rules that decide which contract items land in the market cache and how they are labelled.
 * A cache built under another fingerprint (for example, before a group got new codes) is stale.
 */
export function marketConfigKey(cfg: MarketConfig): string {
  const { ourBins, minUnitPrice, excludedStatuses, allowedStatuses, methods, groups } = cfg;
  const rules = JSON.stringify({ ourBins, minUnitPrice, excludedStatuses, allowedStatuses, methods, groups });
  return crypto.createHash("sha256").update(rules).digest("hex").slice(0, 16);
}

interface CompiledMatcher {
  regex: RegExp;
  group: "ИП" | "КТ";
  kind: string;
  textPatterns?: string[];
}

let cachedConfig: MarketConfig | null = null;
const matchersCache = new WeakMap<MarketConfig, CompiledMatcher[]>();

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

function getCompiledMatchers(cfg: MarketConfig): CompiledMatcher[] {
  const cached = matchersCache.get(cfg);
  if (cached) return cached;
  const list: CompiledMatcher[] = [];

  for (const [groupKey, groupConf] of Object.entries(cfg.groups) as [
    "ИП" | "КТ",
    MarketConfig["groups"]["ИП" | "КТ"]
  ][]) {
    for (const kind of groupConf.kinds) {
      for (const pattern of kind.patterns) {
        list.push({
          regex: new RegExp(pattern),
          group: groupKey,
          kind: kind.name,
          textPatterns: kind.textPatterns
        });
      }
    }
  }
  matchersCache.set(cfg, list);
  return list;
}

export function classifyCode(
  code: string,
  cfg: MarketConfig = loadMarketConfig(),
  text?: string | null
): { group: "ИП" | "КТ"; kind: string } | null {
  const matchers = getCompiledMatchers(cfg);
  for (const m of matchers) {
    if (m.regex.test(code)) {
      if (m.textPatterns && m.textPatterns.length > 0) {
        if (!text || !text.trim()) continue;
        const matched = m.textPatterns.some((p) => new RegExp(p, "i").test(text));
        if (!matched) continue;
      }
      return { group: m.group, kind: m.kind };
    }
  }
  return null;
}

export function matchesMarketCode(
  code: string,
  cfg: MarketConfig = loadMarketConfig()
): boolean {
  const matchers = getCompiledMatchers(cfg);
  return matchers.some((m) => m.regex.test(code));
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
