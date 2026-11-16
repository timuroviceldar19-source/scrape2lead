import { GZ_PORTAL_ORIGIN } from "../goszakupOrigin.js";
import { parseSpecFiles, parseSpecGroupId } from "../goszakupTechSpec.js";
import { mapWithConcurrency, zakupGet } from "../zakupPublicApi.js";
import { loadCompetitorsConfig, resolveEnstruCodes } from "./config.js";
import { cleanBin } from "./htmlDom.js";
import {
  classifyCompetitorLot,
  dedupeLatestLotVersions,
  normalizeCompetitorLotAndBids,
  parseAnnounceGeneral,
  parseItogiHtml,
  parseProtocolsTab,
  parseSearchLotsPage,
  parseSubpriceoffer
} from "./parsers.js";
import { matchSpecTemplates, normalizeTemplateText } from "./specTemplates.js";
import { CompetitorsStorage, DEFAULT_COMPETITORS_DB_PATH, type RawLotRow } from "./storage.js";
import { extractSpecText } from "./textExtractor.js";
import type {
  AnnounceGeneralParsed,
  CompetitorBid,
  CompetitorLot,
  CompetitorsConfig,
  DiscoveredLotRecord,
  LotDetailParsed,
  LotTemplateMatch,
  ProtocolLinkItem
} from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const RECORDS_PER_PAGE = 50;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
export const DEFAULT_CAPTCHA_PAUSE_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_CAPTCHA_RETRIES = 3;
const WALL_CLOCK_TICK_MS = 30_000;
const POST_CAPTCHA_PAUSE_MS = 1500;

export class CaptchaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaError";
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

interface ZakupPublicLotRow {
  lot_number?: string;
  announcement_external_id?: number | string;
  announcement_number?: string;
  status_name?: string;
  offer_start_date?: string;
  offer_end_date?: string;
  quantity?: number;
  total_price?: number;
  enstru_key?: string;
  description_ru?: string;
  enstrus?: Array<{ name_ru?: string; short_description_ru?: string }>;
  customers?: Array<{ bin?: string; name_ru?: string }>;
  delivery_addresses?: Array<{ code?: string }>;
}

function formatUtcIsoToAlmaty(iso: string | undefined): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const almaty = new Date(ts + 5 * 60 * 60 * 1000);
  const y = almaty.getUTCFullYear();
  const m = String(almaty.getUTCMonth() + 1).padStart(2, "0");
  const d = String(almaty.getUTCDate()).padStart(2, "0");
  const hh = String(almaty.getUTCHours()).padStart(2, "0");
  const mm = String(almaty.getUTCMinutes()).padStart(2, "0");
  const ss = String(almaty.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function formatAlmatyClockHm(epochMs: number): string {
  const almaty = new Date(epochMs + 5 * 60 * 60 * 1000);
  return `${String(almaty.getUTCHours()).padStart(2, "0")}:${String(almaty.getUTCMinutes()).padStart(2, "0")}`;
}

async function tryFetchLotDetailFromZakupApi(
  row: RawLotRow,
  options: { fetchFn?: typeof fetch; pauseMs?: number }
): Promise<LotDetailParsed | null> {
  if (row.lotNumber.includes("-ОЛ-") || row.discovered.lotNameSearch.includes("-ОЛ-")) {
    return null;
  }
  try {
    const res = await zakupGet<ZakupPublicLotRow[] | { results?: ZakupPublicLotRow[] }>(
      "/public/lots/",
      { lot_number: row.lotNumber },
      {
        fetchFn: options.fetchFn,
        maxRetries: 1,
        retryDelayMs: options.pauseMs === 0 ? 0 : 1000,
        timeoutMs: 10_000,
        pauseMs: options.pauseMs === 0 ? 0 : 100
      }
    );
    const list = Array.isArray(res) ? res : (res?.results ?? []);
    const matched = list.find(
      (item) =>
        String(item.announcement_external_id ?? "") === row.annoId ||
        item.announcement_number?.startsWith(`${row.annoId}-`)
    );
    if (!matched) return null;

    const customer = matched.customers?.[0];
    const customerBin = cleanBin(customer?.bin);
    const rawQty = typeof matched.quantity === "number" && Number.isFinite(matched.quantity) ? matched.quantity : null;
    const qty =
      rawQty === 1 && row.discovered.qtySearch && row.discovered.qtySearch > 1
        ? row.discovered.qtySearch
        : rawQty;
    const plannedSum = typeof matched.total_price === "number" && Number.isFinite(matched.total_price) ? matched.total_price : null;
    if (!customerBin || qty === null) return null;

    const unitPrice = qty > 0 && plannedSum !== null ? Math.round((plannedSum / qty) * 100) / 100 : null;
    const enstru = matched.enstrus?.[0];
    const detail: LotDetailParsed = {
      lotNumberPage: (matched.lot_number || row.lotNumber).trim(),
      statusLot: (matched.status_name || row.discovered.statusSearch || "").trim(),
      startDate: formatUtcIsoToAlmaty(matched.offer_start_date),
      endDate: formatUtcIsoToAlmaty(matched.offer_end_date),
      customerBin,
      customerName: (customer?.name_ru || row.discovered.customerNameSearch || "").replace(/""+/g, '"').replace(/\s+/g, " ").trim(),
      enstruCodePage: matched.enstru_key || row.discovered.enstruCode || "",
      truName: (enstru?.name_ru || row.discovered.lotNameSearch || "").trim(),
      shortDesc: (enstru?.short_description_ru || "").trim(),
      extraDesc: (matched.description_ru || enstru?.short_description_ru || "").trim(),
      unitPrice,
      unit: "",
      qty,
      plannedSum,
      deliveryKato: matched.delivery_addresses?.[0]?.code || "",
      subItems: []
    };
    return isValidLotDetail(detail, row.lotNumber) ? detail : null;
  } catch {
    return null;
  }
}

const SKIP_PROTOCOLS_STATUSES = new Set([
  "Изменена документация",
  "Опубликован",
  "Опубликован (прием заявок)"
]);

const TERMINAL_STATUSES = new Set([
  "Закупка состоялась",
  "Закупка не состоялась",
  "Отменен",
  "Отказ от лота",
  "Изменена документация"
]);

export function formatSearchDate(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return isoDate;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function normalizeLotKey(lotNumber: string): string {
  return lotNumber.replace(/\s+/g, "").toLocaleLowerCase("ru");
}

export function isValidLotDetail(detail: LotDetailParsed | null | undefined, expectedLotNumber: string): boolean {
  if (!detail || !detail.lotNumberPage) return false;
  return normalizeLotKey(detail.lotNumberPage) === normalizeLotKey(expectedLotNumber);
}

export function isValidAnnoGeneral(general: AnnounceGeneralParsed | null | undefined): boolean {
  if (!general) return false;
  return Boolean(general.startDate || general.annoNumberPage || general.organizerBin);
}

export function isValidProtocolsHtml(html: string): boolean {
  return /протокол|panel-heading/i.test(html);
}

export function isValidDocumentsHtml(html: string): boolean {
  return /техническ|спецификац|документац|actionModalShowFiles|tab=documents/i.test(html);
}

export function isValidModalFilesHtml(html: string): boolean {
  return /download_file|<table|нет\s+файл|файл/i.test(html);
}

function isCaptchaLocation(locOrUrl: string): boolean {
  return /\/(?:ru\/|kk\/|en\/)?captcha\b/i.test(locOrUrl);
}

function isCaptchaHtml(html: string): boolean {
  return html.length < 30_000 && (/\/(?:ru\/)?captcha/i.test(html) || /\bg-recaptcha\b|captcha_code|введите\s+код\s+с\s+картинки/i.test(html));
}

function extractSubpriceIds(lotUrl: string, lotNumber: string): { annoId: string; lotId: string } | null {
  const m = lotUrl.match(/\/subpriceoffer\/index\/(\d+)\/(\d+)/);
  if (m) return { annoId: m[1], lotId: m[2] };
  void lotNumber;
  return null;
}

class HostRateLimiter {
  private lastTs = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly pauseMs: number) {}

  async waitTurn(): Promise<void> {
    if (this.pauseMs <= 0) return;
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    try {
      const now = Date.now();
      const wait = this.pauseMs - (now - this.lastTs);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastTs = Date.now();
    } finally {
      release();
    }
  }
}

export interface HttpClientOptions {
  fetchFn?: typeof fetch;
  pauseMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  captchaPauseMs?: number;
  maxCaptchaRetries?: number;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  maxDurationMs?: number;
}

interface HostGate {
  lastTs: number;
  blockedUntil: number;
  consecutiveCaptchas: number;
  slowMode: boolean;
  chain: Promise<void>;
}

class PoliteHttpClient {
  private readonly gates = new Map<string, HostGate>();
  private readonly fetchFn: typeof fetch;
  private readonly pauseMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly captchaPauseMs: number;
  private readonly maxCaptchaRetries: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly deadlineMs: number | null;

  constructor(options: HttpClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.pauseMs = options.pauseMs ?? 420;
    this.retryDelayMs = options.retryDelayMs ?? 1500;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.captchaPauseMs = options.captchaPauseMs ?? DEFAULT_CAPTCHA_PAUSE_MS;
    this.maxCaptchaRetries = options.maxCaptchaRetries ?? DEFAULT_MAX_CAPTCHA_RETRIES;
    this.sleepFn = options.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.nowFn = options.nowFn ?? Date.now;
    this.deadlineMs =
      options.maxDurationMs !== undefined && Number.isFinite(options.maxDurationMs)
        ? this.nowFn() + options.maxDurationMs
        : null;
  }

  getRetryConfig(): { retryDelayMs: number; maxRetries: number } {
    return { retryDelayMs: this.retryDelayMs, maxRetries: this.maxRetries };
  }

  checkBudget(context: string): void {
    if (this.deadlineMs !== null && this.nowFn() >= this.deadlineMs) {
      throw new BudgetExceededError(`Достигнут лимит времени (${context})`);
    }
  }

  private async sleepWallClockUntil(targetMs: number, context: string): Promise<void> {
    while (true) {
      this.checkBudget(context);
      const rem = targetMs - this.nowFn();
      if (rem <= 0) return;
      if (this.deadlineMs !== null && this.nowFn() + rem > this.deadlineMs) {
        throw new BudgetExceededError(`Ожидание превышает лимит времени (${context})`);
      }
      await this.sleepFn(Math.min(WALL_CLOCK_TICK_MS, rem));
    }
  }

  async pause(ms: number): Promise<void> {
    if (ms <= 0) return;
    await this.sleepWallClockUntil(this.nowFn() + ms, "пауза");
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return "default";
    }
  }

  private gateFor(url: string): HostGate {
    const host = this.hostOf(url);
    let gate = this.gates.get(host);
    if (!gate) {
      gate = {
        lastTs: 0,
        blockedUntil: 0,
        consecutiveCaptchas: 0,
        slowMode: false,
        chain: Promise.resolve()
      };
      this.gates.set(host, gate);
    }
    return gate;
  }

  private async withHostGate<T>(gate: HostGate, minGapMs: number, fn: () => Promise<T>): Promise<T> {
    // Before queuing, wait out any active host-wide captcha gate cleanly.
    if (this.nowFn() < gate.blockedUntil) {
      await this.sleepWallClockUntil(gate.blockedUntil, "капча");
    }

    const prev = gate.chain;
    let release!: () => void;
    gate.chain = new Promise<void>((res) => {
      release = res;
    });
    await prev;

    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        release();
      }
    };

    const holdAfterFetch = gate.slowMode;
    try {
      if (this.nowFn() < gate.blockedUntil) {
        await this.sleepWallClockUntil(gate.blockedUntil, "капча");
      }
      const effGap = gate.slowMode ? Math.max(minGapMs, POST_CAPTCHA_PAUSE_MS) : minGapMs;
      const wait = effGap - (this.nowFn() - gate.lastTs);
      if (wait > 0) {
        await this.sleepWallClockUntil(this.nowFn() + wait, "интервал");
      }
      gate.lastTs = this.nowFn();
      if (!holdAfterFetch) {
        releaseOnce();
      }
      return await fn();
    } finally {
      releaseOnce();
    }
  }

  private async handleCaptchaHit(gate: HostGate, host: string, reason: string, url: string): Promise<void> {
    const now = this.nowFn();
    if (now < gate.blockedUntil) {
      // Another concurrent worker already started the pause window; wait on the same blockedUntil!
      await this.sleepWallClockUntil(gate.blockedUntil, "капча");
      return;
    }

    gate.consecutiveCaptchas++;
    if (gate.consecutiveCaptchas > this.maxCaptchaRetries) {
      throw new CaptchaError(
        `Портал вернул капчу (${reason}) ${gate.consecutiveCaptchas - 1} раза подряд без успешных ответов (максимум ${this.maxCaptchaRetries} пауз по ${Math.round(this.captchaPauseMs / 60_000)} мин): ${url}`
      );
    }

    gate.blockedUntil = now + this.captchaPauseMs;
    gate.slowMode = true;
    const untilHm = formatAlmatyClockHm(gate.blockedUntil);
    console.warn(
      `[Конкуренты] Капча на ${url} (${reason}), все запросы к ${host} стоят до ${untilHm} (пауза ${gate.consecutiveCaptchas}/${this.maxCaptchaRetries})...`
    );
    await this.sleepWallClockUntil(gate.blockedUntil, "капча");
  }

  private async fetchFollowingNonCaptchaRedirects(
    url: string,
    headers: Record<string, string>
  ): Promise<{ res: Response; buf: Buffer; captchaReason: string | null }> {
    let currentUrl = url;
    for (let hop = 0; hop < 6; hop++) {
      const res = await this.fetchFn(currentUrl, {
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "ru-RU,ru;q=0.9",
          ...headers
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location") || "";
        if (isCaptchaLocation(location)) {
          return { res, buf: Buffer.alloc(0), captchaReason: `${res.status} -> ${location}` };
        }
        if (!location) {
          throw new Error(`HTTP ${res.status} without Location for ${currentUrl}`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (isCaptchaLocation(res.url || "")) {
        return { res, buf, captchaReason: `redirect -> ${res.url}` };
      }
      if (res.ok) {
        const headText = buf.subarray(0, 32_000).toString("utf8");
        if (isCaptchaHtml(headText)) {
          return { res, buf, captchaReason: "captcha page HTML" };
        }
      }
      return { res, buf, captchaReason: null };
    }
    throw new Error(`Too many redirects for ${url}`);
  }

  async getBuffer(url: string, headers: Record<string, string> = {}, minPauseOverride?: number): Promise<Buffer> {
    const gate = this.gateFor(url);
    const host = this.hostOf(url);
    const gap = minPauseOverride ?? this.pauseMs;
    let lastErr: unknown;
    let netAttempts = 0;

    while (true) {
      this.checkBudget(url);
      try {
        const { res, buf, captchaReason } = await this.withHostGate(gate, gap, () =>
          this.fetchFollowingNonCaptchaRedirects(url, headers)
        );
        if (captchaReason) {
          await this.handleCaptchaHit(gate, host, captchaReason, url);
          continue;
        }
        if (RETRYABLE_STATUSES.has(res.status)) {
          netAttempts++;
          if (netAttempts > this.maxRetries) {
            throw new Error(`HTTP ${res.status} for ${url}`);
          }
          if (this.retryDelayMs > 0) {
            await this.pause(Math.min(30_000, this.retryDelayMs * 2 ** (netAttempts - 1)));
          }
          continue;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} for ${url}`);
        }
        // Any successful non-captcha response resets the consecutive captcha pause counter.
        gate.consecutiveCaptchas = 0;
        return buf;
      } catch (err) {
        if (err instanceof CaptchaError || err instanceof BudgetExceededError) {
          throw err;
        }
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/HTTP [45]\d{2}/.test(msg) && !/HTTP (429|5\d{2})/.test(msg)) {
          throw err;
        }
        netAttempts++;
        if (netAttempts > this.maxRetries) {
          throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
        }
        if (this.retryDelayMs > 0) {
          await this.pause(Math.min(30_000, this.retryDelayMs * 2 ** (netAttempts - 1)));
        }
      }
    }
  }

  async getText(url: string, ajax = false, minPauseOverride?: number): Promise<string> {
    const buf = await this.getBuffer(
      url,
      {
        Accept: "text/html,application/xhtml+xml,*/*",
        ...(ajax ? { "X-Requested-With": "XMLHttpRequest" } : {})
      },
      minPauseOverride
    );
    return buf.toString("utf8");
  }

  async getValidated<T>(
    url: string,
    parseAndValidate: (html: string) => T | null,
    describeFailure: string,
    ajax = false
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0 && this.retryDelayMs > 0) {
        await this.pause(Math.min(30_000, this.retryDelayMs * 2 ** (attempt - 1)));
      }
      const html = await this.getText(url, ajax);
      const parsed = parseAndValidate(html);
      if (parsed !== null) {
        return parsed;
      }
      lastErr = new Error(`${describeFailure} (${url}, len=${html.length})`);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

export interface DiscoverLotsOptions extends HttpClientOptions {
  fromDate: string;
  toDate: string;
  enstruCodes: readonly string[];
  methodId?: number;
  concurrency?: number;
  client?: PoliteHttpClient;
  onProgress?: (info: { code: string; index: number; total: number; found: number }) => void;
}

export async function discoverCompetitorLots(options: DiscoverLotsOptions): Promise<DiscoveredLotRecord[]> {
  const searchPause = options.pauseMs ?? (options.fetchFn ? 0 : 550);
  const client =
    options.client ??
    new PoliteHttpClient({
      ...options,
      pauseMs: searchPause
    });
  const methodId = options.methodId ?? 2;
  const dateFrom = formatSearchDate(options.fromDate);
  const dateTo = formatSearchDate(options.toDate);
  const concurrency = options.concurrency ?? 1;
  const retryDelay = options.retryDelayMs ?? (options.fetchFn ? 0 : 2000);
  const maxSearchAttempts = (options.maxRetries ?? 5) + 1;

  const buildUrl = (code: string, page: number) => {
    const url = new URL(`${GZ_PORTAL_ORIGIN}/ru/search/lots`);
    url.searchParams.set("filter[enstru]", code);
    url.searchParams.append("filter[method][]", String(methodId));
    url.searchParams.set("filter[start_date_from]", dateFrom);
    url.searchParams.set("filter[start_date_to]", dateTo);
    url.searchParams.set("count_record", String(RECORDS_PER_PAGE));
    if (page > 1) url.searchParams.set("page", String(page));
    return url.toString();
  };

  const fetchSearchPage = async (url: string, minExpectedItems: number) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxSearchAttempts; attempt++) {
      if (attempt > 0 && retryDelay > 0) {
        await client.pause(Math.min(30_000, retryDelay * 2 ** (attempt - 1)));
      }
      try {
        const html = await client.getText(url, false, searchPause);
        const hasSearchTable = /<table\b[^>]*\bid=["']search-result["']/i.test(html);
        const hasEmptyMsg = html.includes("Ничего не найдено");
        if (!hasSearchTable && !hasEmptyMsg) {
          lastErr = new Error(`Unexpected search HTML without #search-result for ${url} (len=${html.length})`);
          continue;
        }
        const parsed = parseSearchLotsPage(html);
        if (parsed.total >= 9000) {
          lastErr = new Error(`Превышен лимит выдачи поиска (total=${parsed.total} >= 9000) для ${url}`);
          continue;
        }
        if (minExpectedItems > 0 && parsed.items.length === 0) {
          lastErr = new Error(`Неполная выдача поиска: 0 лотов при ожидаемых >= ${minExpectedItems} для ${url}`);
          continue;
        }
        return parsed;
      } catch (err) {
        if (err instanceof CaptchaError || err instanceof BudgetExceededError) {
          throw err;
        }
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };

  let done = 0;
  const perCode = await mapWithConcurrency(options.enstruCodes, concurrency, async (code) => {
    const page1 = await fetchSearchPage(buildUrl(code, 1), 0);
    const items: DiscoveredLotRecord[] = [...page1.items];
    const pages = page1.total > 0 ? Math.ceil(page1.total / RECORDS_PER_PAGE) : 1;
    for (let p = 2; p <= pages; p++) {
      const expected = page1.total > (p - 1) * RECORDS_PER_PAGE ? 1 : 0;
      const parsedP = await fetchSearchPage(buildUrl(code, p), expected);
      items.push(...parsedP.items);
    }
    for (const it of items) {
      it.enstruCode = code;
      it.enstruCodesMatched = [code];
      it.methodId = methodId;
    }
    done++;
    options.onProgress?.({ code, index: done, total: options.enstruCodes.length, found: items.length });
    return items;
  });

  const deduped = new Map<string, DiscoveredLotRecord>();
  for (const list of perCode) {
    for (const item of list) {
      if (!item.annoId || !item.lotNumber) continue;
      const key = `${item.annoId}:${item.lotNumber}`;
      const prev = deduped.get(key);
      if (!prev) {
        deduped.set(key, { ...item, enstruCodesMatched: [item.enstruCode!] });
      } else if (item.enstruCode && !prev.enstruCodesMatched?.includes(item.enstruCode)) {
        prev.enstruCodesMatched = [...(prev.enstruCodesMatched ?? []), item.enstruCode];
      }
    }
  }
  return [...deduped.values()];
}

export interface CollectCompetitorsOptions extends HttpClientOptions {
  fromDate: string;
  toDate: string;
  dbPath?: string;
  cfg?: CompetitorsConfig;
  enstruCodes?: readonly string[];
  concurrency?: number;
  incremental?: boolean;
  skipDiscover?: boolean;
  useZakupPublicApi?: boolean;
  onProgress?: (stage: string, detail: string) => void;
}

export interface CollectCompetitorsResult {
  lotsCount: number;
  bidsCount: number;
  specsCount: number;
  discoveredCount: number;
  refreshedAnnos: number;
  remainingMissingDetails: number;
  incomplete: boolean;
  stopReason?: string;
  errors: string[];
}

function lotStartDate(row: RawLotRow): string {
  const raw = row.lotDetail?.startDate || row.annoGeneral?.startDate || "";
  return raw.slice(0, 10);
}

function chooseItogiLinks(protocols: readonly ProtocolLinkItem[]): ProtocolLinkItem[] {
  const cand = protocols.filter((p) => p.kind === "itogi" && p.status !== "Отменен" && p.url);
  if (cand.length === 0) return [];
  const valid = cand.filter((p) => p.status === "Действительный");
  const rest = cand.filter((p) => p.status !== "Действительный");
  return [...valid, ...rest];
}

function needsProtocolFetch(rows: readonly RawLotRow[]): boolean {
  return !rows.every((r) => SKIP_PROTOCOLS_STATUSES.has(r.lotDetail?.statusLot || r.discovered.statusSearch));
}

function needsDocumentsFetch(rows: readonly RawLotRow[]): boolean {
  return !rows.every((r) => (r.lotDetail?.statusLot || r.discovered.statusSearch) === "Изменена документация");
}

function isRowTerminalAndComplete(row: RawLotRow, storage: CompetitorsStorage): boolean {
  const status = row.lotDetail?.statusLot || row.discovered.statusSearch;
  if (!TERMINAL_STATUSES.has(status)) return false;
  if (!isValidLotDetail(row.lotDetail, row.lotNumber)) return false;
  if (!SKIP_PROTOCOLS_STATUSES.has(status) && !storage.getItogiParsed(row.annoId)) {
    // Some cancelled/failed lots have no itogi at all on portal; check if protocols were already checked
    if (row.protocols.length === 0) return false;
  }
  return true;
}

export async function collectCompetitors(options: CollectCompetitorsOptions): Promise<CollectCompetitorsResult> {
  const cfg = options.cfg ?? loadCompetitorsConfig();
  const dbPath = options.dbPath ?? DEFAULT_COMPETITORS_DB_PATH;
  const concurrency = options.concurrency ?? 2;
  const client = new PoliteHttpClient(options);
  const enstruCodes = options.enstruCodes
    ? [...options.enstruCodes]
    : options.skipDiscover
    ? []
    : await resolveEnstruCodes(cfg, {
        fetchFn: options.fetchFn,
        pauseMs: options.pauseMs,
        retryDelayMs: options.retryDelayMs,
        maxRetries: options.maxRetries
      });

  const storage = new CompetitorsStorage(dbPath);
  const errors: string[] = [];
  let discoveredCount = 0;
  let refreshedAnnos = 0;
  let fatalStop: Error | null = null;

  try {
    try {
      if (!options.skipDiscover) {
        options.onProgress?.("discover", `поиск по ${enstruCodes.length} кодам ЕНС ТРУ (${options.fromDate}..${options.toDate})`);
        const discovered = await discoverCompetitorLots({
          fromDate: options.fromDate,
          toDate: options.toDate,
          fetchFn: options.fetchFn,
          pauseMs: options.pauseMs,
          retryDelayMs: options.retryDelayMs,
          maxRetries: options.maxRetries,
          timeoutMs: options.timeoutMs,
          captchaPauseMs: options.captchaPauseMs,
          maxCaptchaRetries: options.maxCaptchaRetries,
          sleepFn: options.sleepFn,
          nowFn: options.nowFn,
          maxDurationMs: options.maxDurationMs,
          enstruCodes,
          concurrency: 1,
          client,
          onProgress: (info) => {
            if (info.index % 10 === 0 || info.index === info.total) {
              options.onProgress?.("discover_progress", `${info.index}/${info.total} (${info.code}: ${info.found})`);
            }
          }
        });
        discoveredCount = discovered.length;
        const { inserted, changed } = storage.upsertDiscoveredLots(discovered, true);
        options.onProgress?.("discover_done", `найдено ${discovered.length}, новых ${inserted}, со сменой статуса ${changed}`);
      } else {
        options.onProgress?.("discover_skipped", "пропущен этап поиска (--skip-discover)");
      }

      let rawRows = storage.loadAllRawLots();
      // Clear legacy empty stub lot_detail_json rows in SQLite so toEnrich treats them as unfetched without forcing re-fetch of completed protocols.
      for (const r of rawRows) {
        if (r.lotDetail && !isValidLotDetail(r.lotDetail, r.lotNumber)) {
          storage.saveLotEnrichment(r.annoId, r.lotNumber, { lotDetail: null });
        }
        if (r.annoGeneral && !isValidAnnoGeneral(r.annoGeneral)) {
          storage.saveLotEnrichment(r.annoId, r.lotNumber, { annoGeneral: null });
        }
      }
      rawRows = storage.loadAllRawLots();
      if (options.incremental) {
        for (const r of rawRows) {
          if (!isRowTerminalAndComplete(r, storage)) {
            storage.markNeedsRefresh(r.annoId, r.lotNumber, true);
          }
        }
        rawRows = storage.loadAllRawLots();
      }

      // Step 2: Enrich via open zakup.gov.kz API first, then fallback to HTML subpriceoffer (and general when startDate missing)
      const toEnrich = rawRows.filter((r) => !isValidLotDetail(r.lotDetail, r.lotNumber) || r.needsRefresh);
      options.onProgress?.("enrich", `лотов для деталей: ${toEnrich.length} (потоков: ${concurrency})`);

      let enrichDone = 0;
      await mapWithConcurrency(toEnrich, concurrency, async (row) => {
        if (fatalStop) return;
        try {
          client.checkBudget(`enrich ${row.annoId}`);
          let lotDetail = isValidLotDetail(row.lotDetail, row.lotNumber) ? row.lotDetail : null;
          if (!lotDetail || row.needsRefresh) {
            let apiDetail: LotDetailParsed | null = null;
            if (options.useZakupPublicApi === true) {
              apiDetail = await tryFetchLotDetailFromZakupApi(row, {
                fetchFn: options.fetchFn,
                pauseMs: options.pauseMs
              });
            }
            if (apiDetail) {
              lotDetail = apiDetail;
            } else {
              const ids = extractSubpriceIds(row.discovered.lotUrl, row.lotNumber);
              if (ids || row.discovered.lotUrl) {
                const url = ids
                  ? `${GZ_PORTAL_ORIGIN}/ru/subpriceoffer/index/${ids.annoId}/${ids.lotId}`
                  : row.discovered.lotUrl;
                lotDetail = await client.getValidated(
                  url,
                  (html) => {
                    const parsed = parseSubpriceoffer(html);
                    return isValidLotDetail(parsed, row.lotNumber) ? parsed : null;
                  },
                  `Пустая или чужая карточка subpriceoffer (ожидался ${row.lotNumber})`
                );
              }
            }
          }

          let annoGeneral = isValidAnnoGeneral(row.annoGeneral) ? row.annoGeneral : null;
          if (!lotDetail?.startDate && !annoGeneral?.startDate) {
            annoGeneral = await client.getValidated(
              `${GZ_PORTAL_ORIGIN}/ru/announce/index/${row.annoId}?tab=general`,
              (html) => {
                const parsed = parseAnnounceGeneral(html);
                return isValidAnnoGeneral(parsed) ? parsed : null;
              },
              `Пустая страница general объявления ${row.annoId}`
            );
          }
          storage.saveLotEnrichment(row.annoId, row.lotNumber, { lotDetail, annoGeneral });
        } catch (err) {
          if (err instanceof CaptchaError || err instanceof BudgetExceededError) {
            fatalStop = err;
            return;
          }
          errors.push(`enrich ${row.annoId}:${row.lotNumber}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          enrichDone++;
          if (enrichDone % 25 === 0 || enrichDone === toEnrich.length) {
            options.onProgress?.("enrich_progress", `${enrichDone}/${toEnrich.length} (ошибок: ${errors.length})`);
          }
        }
      });

      if (fatalStop) throw fatalStop;

      rawRows = storage.loadAllRawLots();
      const targetRows = rawRows.filter((r) => {
        const sd = lotStartDate(r);
        if (options.incremental && r.needsRefresh && sd) return true;
        return sd >= options.fromDate && sd <= options.toDate;
      });

      // Group target lots by announcement
      const byAnno = new Map<string, RawLotRow[]>();
      for (const r of targetRows) {
        const arr = byAnno.get(r.annoId) ?? [];
        arr.push(r);
        byAnno.set(r.annoId, arr);
      }

      const annosToFetch = [...byAnno.entries()].filter(([, rows]) =>
        rows.some((r) => r.needsRefresh || (needsProtocolFetch([r]) && !storage.getItogiParsed(r.annoId)) || (needsDocumentsFetch([r]) && storage.getTechSpecsForAnno(r.annoId).length === 0 && !r.techspecMeta))
      );
      options.onProgress?.("annos", `объявлений к загрузке протоколов/ТС: ${annosToFetch.length}`);

      let annosDone = 0;
      await mapWithConcurrency(annosToFetch, concurrency, async ([annoId, rows]) => {
        if (fatalStop) return;
        let annoFailed = false;
        try {
          client.checkBudget(`anno ${annoId}`);
          let protocols = rows[0]?.protocols ?? [];
          if (needsProtocolFetch(rows) && (rows.some((r) => r.needsRefresh) || protocols.length === 0)) {
            protocols = await client.getValidated(
              `${GZ_PORTAL_ORIGIN}/ru/announce/index/${annoId}?tab=protocols`,
              (html) => (isValidProtocolsHtml(html) ? parseProtocolsTab(html) : null),
              `Пустая вкладка протоколов объявления ${annoId}`
            );
          }

          const itogiCandidates = chooseItogiLinks(protocols);
          const existingItogi = storage.getItogiParsed(annoId);
          if (itogiCandidates.length > 0 && (rows.some((r) => r.needsRefresh) || !existingItogi)) {
            const targetLotNums = new Set(rows.map((r) => r.lotNumber));
            const mergedParsed: Record<string, ReturnType<typeof parseItogiHtml>[string]> = {};
            for (const cand of itogiCandidates) {
              try {
                const parsed = await client.getValidated(
                  cand.url,
                  (html) => {
                    if (html.trimStart().startsWith("%PDF")) return {};
                    const out = parseItogiHtml(html, targetLotNums);
                    return Object.keys(out).length > 0 ? out : null;
                  },
                  `Пустой или заглушечный протокол итогов объявления ${annoId}`
                );
                for (const [k, v] of Object.entries(parsed)) {
                  if (!(k in mergedParsed)) mergedParsed[k] = v;
                }
              } catch (err) {
                if (err instanceof CaptchaError || err instanceof BudgetExceededError) throw err;
                annoFailed = true;
                errors.push(`itogi ${annoId}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            if (Object.keys(mergedParsed).length > 0) {
              storage.saveItogiParsed(annoId, itogiCandidates[0].url, mergedParsed);
            }
          }

          // Documents & techspec modal
          if (needsDocumentsFetch(rows)) {
            const existingSpecs = storage.getTechSpecsForAnno(annoId);
            const wantedKeys = new Set(rows.map((r) => normalizeLotKey(r.lotNumber)));
            const missingSpec = rows.some((r) => {
              const specKey = `${annoId}:${r.lotNumber}`;
              return !storage.getTechSpec(specKey) && !existingSpecs.some((s) => normalizeLotKey(s.lotNumber) === normalizeLotKey(r.lotNumber));
            });

            if (missingSpec) {
              const { gid } = await client.getValidated(
                `${GZ_PORTAL_ORIGIN}/ru/announce/index/${annoId}?tab=documents`,
                (html) => (isValidDocumentsHtml(html) ? { gid: parseSpecGroupId(html) } : null),
                `Пустая вкладка документов объявления ${annoId}`
              );
              if (gid) {
                const specFiles = await client.getValidated(
                  `${GZ_PORTAL_ORIGIN}/ru/announce/actionAjaxModalShowFiles/${annoId}/${gid}`,
                  (html) => (isValidModalFilesHtml(html) ? parseSpecFiles(html) : null),
                  `Пустая модалка файлов ТС объявления ${annoId}`,
                  true
                );
                for (const sf of specFiles) {
                  const sfNorm = normalizeLotKey(sf.lotNumber);
                  const matchesWanted = specFiles.length === 1 || !sfNorm || wantedKeys.has(sfNorm);
                  if (!matchesWanted) continue;

                  const matchingRows = sfNorm
                    ? rows.filter((r) => normalizeLotKey(r.lotNumber) === sfNorm)
                    : rows;
                  const targetRows = matchingRows.length > 0 ? matchingRows : rows;

                  for (const r of targetRows) {
                    storage.saveLotEnrichment(annoId, r.lotNumber, {
                      techspecMeta: { fileName: sf.fileName, downloadUrl: sf.downloadUrl, lotNumber: sf.lotNumber }
                    });
                  }

                  const specKey = `${annoId}:${sfNorm || targetRows[0].lotNumber}`;
                  if (!storage.getTechSpec(specKey)) {
                    try {
                      const buf = await client.getBuffer(sf.downloadUrl, { Accept: "*/*" });
                      const { kind, text } = await extractSpecText(buf);
                      storage.saveTechSpec({
                        specKey,
                        annoId,
                        lotNumber: sf.lotNumber || targetRows[0].lotNumber,
                        fileName: sf.fileName,
                        downloadUrl: sf.downloadUrl,
                        fileKind: kind,
                        text,
                        normalizedText: normalizeTemplateText(text),
                        extractedAt: new Date().toISOString()
                      });
                    } catch (err) {
                      if (err instanceof CaptchaError || err instanceof BudgetExceededError) throw err;
                      annoFailed = true;
                      errors.push(`spec ${annoId} ${sf.downloadUrl}: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }
                }
              }
            }
          }

          for (const r of rows) {
            storage.saveLotEnrichment(annoId, r.lotNumber, {
              protocols,
              needsRefresh: annoFailed ? true : !isValidLotDetail(r.lotDetail, r.lotNumber)
            });
          }
          refreshedAnnos++;
        } catch (err) {
          if (err instanceof CaptchaError || err instanceof BudgetExceededError) {
            fatalStop = err;
            return;
          }
          errors.push(`anno ${annoId}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          annosDone++;
          if (annosDone % 25 === 0 || annosDone === annosToFetch.length) {
            options.onProgress?.("annos_progress", `${annosDone}/${annosToFetch.length} (ошибок: ${errors.length})`);
          }
        }
      });

      if (fatalStop) throw fatalStop;
    } catch (err) {
      if (!(err instanceof CaptchaError || err instanceof BudgetExceededError)) {
        throw err;
      }
      fatalStop = err;
      errors.push(err.message);
    }

    const remainingMissingDetails = storage
      .loadAllRawLots()
      .filter((r) => !isValidLotDetail(r.lotDetail, r.lotNumber)).length;
    const incomplete = Boolean(fatalStop) || remainingMissingDetails > 0;

    if (fatalStop && storage.loadLots().length > 0 && remainingMissingDetails > 0) {
      // Stopped mid-run (captcha/budget): update normalized tables ONLY when all details are loaded, or keep valid DB intact.
      const existingLots = storage.loadLots();
      const existingBids = storage.loadBids();
      return {
        lotsCount: existingLots.length,
        bidsCount: existingBids.length,
        specsCount: 0,
        discoveredCount,
        refreshedAnnos,
        remainingMissingDetails,
        incomplete: true,
        stopReason: fatalStop.message,
        errors
      };
    }

    // Step 4: Recompute normalized lots, bids, and template matches across ALL stored raw_lots
    const minStartDate = options.incremental ? (storage.getMeta("backfill_from") || "2026-01-01") : options.fromDate;
    const { lots, bids, templateMatches, specsCount } = rebuildNormalizedFromStorage(storage, cfg, minStartDate);
    storage.replaceNormalizedData(lots, bids, templateMatches);
    if (!incomplete) {
      storage.setMeta("updated_at", options.toDate);
      if (!options.incremental) {
        storage.setMeta("backfill_from", options.fromDate);
      }
    }

    return {
      lotsCount: lots.length,
      bidsCount: bids.length,
      specsCount,
      discoveredCount,
      refreshedAnnos,
      remainingMissingDetails,
      incomplete,
      stopReason: fatalStop?.message,
      errors
    };
  } finally {
    storage.close();
  }
}

export function rebuildNormalizedFromStorage(
  storage: CompetitorsStorage,
  cfg: CompetitorsConfig,
  minStartDate = "2026-01-01"
): { lots: CompetitorLot[]; bids: CompetitorBid[]; templateMatches: LotTemplateMatch[]; specsCount: number } {
  const allRaw = storage.loadAllRawLots();
  const lots: CompetitorLot[] = [];
  const allBidsByLot: Array<{ lot: CompetitorLot; bids: CompetitorBid[] }> = [];
  const templateMatches: LotTemplateMatch[] = [];
  let specsCount = 0;

  for (const r of allRaw) {
    const sd = lotStartDate(r);
    if (!sd || sd < minStartDate) continue;

    const ld = isValidLotDetail(r.lotDetail, r.lotNumber) ? r.lotDetail : null;
    const ag = isValidAnnoGeneral(r.annoGeneral) ? r.annoGeneral : null;
    const annoId = r.annoId;
    const lotNumber = r.lotNumber;
    const lotNorm = normalizeLotKey(lotNumber);

    const annoSpecs = storage.getTechSpecsForAnno(annoId);
    const matchingSpec =
      annoSpecs.find((s) => normalizeLotKey(s.lotNumber) === lotNorm) ??
      annoSpecs[0] ??
      null;
    const specText = matchingSpec?.text ?? "";
    if (specText.trim()) specsCount++;

    const titleText = [
      r.discovered.annoName,
      r.discovered.lotNameSearch,
      ld?.truName ?? "",
      ld?.shortDesc ?? "",
      ld?.extraDesc ?? "",
      ...(ld?.subItems ?? []).map((s) => `${s.name} ${s.extraDesc}`)
    ].join(" ");

    const enstruCodes = r.discovered.enstruCodesMatched?.length
      ? r.discovered.enstruCodesMatched
      : [r.discovered.enstruCode || ld?.enstruCodePage || ""].filter(Boolean);

    const qty = ld?.qty ?? r.discovered.qtySearch ?? 1;
    const plannedSum = ld?.plannedSum ?? r.discovered.plannedSumSearch ?? null;
    const unitPrice = ld?.unitPrice ?? (plannedSum !== null && qty > 0 ? Math.round((plannedSum / qty) * 100) / 100 : null);

    const cls = classifyCompetitorLot(
      {
        enstruCodes,
        lotNumber,
        titleText,
        unitPrice,
        plannedSum,
        qty,
        subItemsCount: ld?.subItems.length ?? 0
      },
      specText,
      cfg
    );
    if (!cls.include || !cls.group) continue;

    const itogiStored = storage.getItogiParsed(annoId);
    let parsedItogi = itogiStored?.parsed[lotNumber] ?? null;
    if (!parsedItogi && itogiStored) {
      for (const [k, v] of Object.entries(itogiStored.parsed)) {
        if (normalizeLotKey(k) === lotNorm) {
          parsedItogi = v;
          break;
        }
      }
    }

    const status = r.discovered.statusSearch || ld?.statusLot || "";
    const endDate = (ld?.endDate || ag?.endDate || "").slice(0, 10);
    const customerName = ld?.customerName || r.discovered.customerNameSearch || "";
    const customerBin = ld?.customerBin || "";

    const norm = normalizeCompetitorLotAndBids({
      annoId,
      annoNumber: r.discovered.annoNumber || ag?.annoNumberPage || "",
      annoName: r.discovered.annoName || ag?.annoNamePage || "",
      lotNumber,
      lotName: r.discovered.lotNameSearch || ld?.truName || "",
      enstruCode: r.discovered.enstruCode || enstruCodes[0] || "",
      group: cls.group,
      kind: cls.kind,
      diagonal: cls.diagonal,
      cpu: cls.cpu,
      isCombinedLot: cls.isCombinedLot,
      isKit: cls.isKit,
      status,
      startDate: sd,
      endDate,
      customerBin,
      customerName,
      qty,
      plannedUnitPriceNoVat: unitPrice,
      plannedSumNoVat: plannedSum,
      hasTechspec: Boolean(specText.trim()),
      techspecUrl: matchingSpec?.downloadUrl || r.techspecMeta?.downloadUrl || "",
      protocolUrl: itogiStored?.protocolUrl || "",
      parsedItogi,
      cfg
    });

    lots.push(norm.lot);
    allBidsByLot.push(norm);

    if (specText.trim()) {
      const matches = matchSpecTemplates(specText, cfg.templates);
      for (const m of matches) {
        templateMatches.push({ ...m, annoId, lotNumber });
      }
    }
  }

  const latestMap = dedupeLatestLotVersions(lots);
  const finalBids: CompetitorBid[] = [];
  for (const entry of allBidsByLot) {
    const isLatest = latestMap.get(`${entry.lot.annoId}:${entry.lot.lotNumber}`) ?? false;
    entry.lot.isLatestVersion = isLatest;
    for (const b of entry.bids) {
      b.isLatestLotVersion = isLatest;
      finalBids.push(b);
    }
  }

  return { lots, bids: finalBids, templateMatches, specsCount };
}

export async function backfillCompetitors(options: CollectCompetitorsOptions): Promise<CollectCompetitorsResult> {
  return collectCompetitors({ ...options, incremental: false });
}
