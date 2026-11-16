import fs from "node:fs";
import path from "node:path";
import { loadMarketConfig } from "../market/config.js";
import { zakupGet, type ZakupApiOptions } from "../zakupPublicApi.js";
import { loadSpecTemplatesConfig } from "./specTemplates.js";
import type { CompetitorsConfig } from "./types.js";

/**
 * Fallback exact ENSTRU codes matching `config/market-monitor.json` (excluding hiddenKinds),
 * used when `zakup.gov.kz/api/core/api/dicts/enstrus/` is unavailable.
 */
export const DEFAULT_COMPETITOR_ENSTRU_CODES: readonly string[] = [
  // ИП
  "262030.100.000021",
  "262030.100.000043",
  "329959.900.000019",
  ...Array.from({ length: 14 }, (_, i) => `279020.100.${String(i).padStart(6, "0")}`),
  // КТ
  "262013.000.000011",
  "262013.000.000012",
  "262040.000.000267",
  "262040.000.000268",
  ...Array.from({ length: 9 }, (_, i) => `262011.100.${String(i).padStart(6, "0")}`),
  ...Array.from({ length: 8 }, (_, i) => `262018.900.${String(i).padStart(6, "0")}`),
  ...Array.from({ length: 5 }, (_, i) => `262016.300.${String(i + 15).padStart(6, "0")}`),
  ...Array.from({ length: 12 }, (_, i) => `262017.100.${String(i).padStart(6, "0")}`)
];

interface DealOutcomesConfig {
  ourBins?: string[];
  partnerBins?: string[];
}

export interface LoadCompetitorsConfigOptions {
  marketConfigPath?: string;
  outcomesConfigPath?: string;
  templatesConfigPath?: string;
}

export function loadCompetitorsConfig(options: LoadCompetitorsConfigOptions = {}): CompetitorsConfig {
  const market = loadMarketConfig(options.marketConfigPath);
  const outcomesPath = options.outcomesConfigPath || path.resolve("config/gz-deal-outcomes.json");
  let outcomes: DealOutcomesConfig = {};
  if (fs.existsSync(outcomesPath)) {
    outcomes = JSON.parse(fs.readFileSync(outcomesPath, "utf8")) as DealOutcomesConfig;
  }

  const ourBins = new Set<string>(outcomes.ourBins ?? []);
  const partnerBins = new Set<string>(outcomes.partnerBins ?? []);
  const allOurBins = new Set<string>([...ourBins, ...partnerBins]);
  const ourCompanyNames: Record<string, string> = { ...(market.ourCompanyNames ?? {}) };

  for (const entry of market.ourBins) {
    const bin = typeof entry === "string" ? entry : entry.bin;
    if (allOurBins.size === 0 || !ourBins.size) {
      ourBins.add(bin);
    }
    allOurBins.add(bin);
    if (typeof entry !== "string" && entry.name && !ourCompanyNames[bin]) {
      ourCompanyNames[bin] = entry.name;
    }
  }

  const templates = loadSpecTemplatesConfig(options.templatesConfigPath);
  return {
    market,
    ourBins,
    partnerBins,
    allOurBins,
    ourCompanyNames,
    templates
  };
}

/**
 * Checks whether an exact ENSTRU code falls within active (non-hidden) ИП or КТ kinds
 * of `config/market-monitor.json`.
 */
export function isActiveEnstruCode(code: string, cfg: CompetitorsConfig): boolean {
  const hidden = new Set(cfg.market.hiddenKinds ?? []);
  for (const group of [cfg.market.groups["ИП"], cfg.market.groups["КТ"]]) {
    for (const kind of group.kinds) {
      if (hidden.has(kind.name)) continue;
      if (kind.patterns.some((p) => new RegExp(p).test(code))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolves exact 17-char ENSTRU codes for `procurement.gov.kz` search by querying
 * `zakup.gov.kz/api/core/api/dicts/enstrus/` for active prefixes, falling back to
 * `DEFAULT_COMPETITOR_ENSTRU_CODES` if the dictionary endpoint fails.
 */
export async function resolveEnstruCodes(
  cfg: CompetitorsConfig,
  apiOptions: ZakupApiOptions = {}
): Promise<string[]> {
  const prefixes = [...new Set([
    ...cfg.market.groups["ИП"].prefixes,
    ...cfg.market.groups["КТ"].prefixes
  ])];
  const resolved = new Set<string>(DEFAULT_COMPETITOR_ENSTRU_CODES.filter((c) => isActiveEnstruCode(c, cfg)));

  for (const prefix of prefixes) {
    try {
      const body = await zakupGet<{ result?: Array<{ code?: string }>; results?: Array<{ code?: string }> }>(
        "/dicts/enstrus/",
        { q: prefix, limit: 100 },
        { ...apiOptions, maxRetries: apiOptions.maxRetries ?? 0, timeoutMs: apiOptions.timeoutMs ?? 4_000 }
      );
      const rows = body?.result ?? body?.results ?? [];
      for (const row of rows) {
        const code = row.code?.trim();
        if (code && /^\d{6}\.\d{3}\.\d{6}$/.test(code) && isActiveEnstruCode(code, cfg)) {
          resolved.add(code);
        }
      }
    } catch {
      // Dictionary unavailable (e.g. HTTP 503): fall back immediately to DEFAULT_COMPETITOR_ENSTRU_CODES.
      break;
    }
  }

  return [...resolved].sort();
}
