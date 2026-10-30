import { parseGoszakupPlanDetailHtml, parseGoszakupPlanSearchHtml } from './goszakupPlanHtmlParser.js';
import { GZ_PORTAL_ORIGIN } from './goszakupOrigin.js';
import type { GoszakupPlanDetail, GoszakupPlanListItem } from './goszakupPlanTypes.js';

export class PortalThrottledError extends Error {
  constructor() { super('portal returned a stripped page twice'); this.name = 'PortalThrottledError'; }
}
class HtmlBudgetError extends Error {}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
interface PortalOptions {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  deadline?: number;
  now?: () => number;
}

/** Портал отвечает на частые запросы короткой страницей с HTTP 200. */
export async function fetchPortalPage(url: string, options: PortalOptions = {}, retried = false): Promise<string> {
  const remaining = (options.deadline ?? Infinity) - (options.now ?? Date.now)();
  if (remaining <= 0) throw new HtmlBudgetError();
  const response = await (options.fetchFn ?? fetch)(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(Math.max(1, Math.min(60_000, Math.ceil(remaining))))
  }).catch((error: unknown) => {
    const cause = error instanceof Error ? error.cause as { code?: string; message?: string } | undefined : undefined;
    throw new Error(`${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause.code ?? cause.message})` : ''}`);
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  if (html.length < 10_000) {
    if (retried) throw new PortalThrottledError();
    if ((options.deadline ?? Infinity) - (options.now ?? Date.now)() <= 30_000) throw new HtmlBudgetError();
    await (options.sleepFn ?? sleep)(30_000);
    return fetchPortalPage(url, options, true);
  }
  return html;
}

export async function fetchRegisterRows(url: string, options: PortalOptions = {}): Promise<GoszakupPlanListItem[]> {
  return parseGoszakupPlanSearchHtml(await fetchPortalPage(url, options), 'outcome-check')
    .filter(row => Number.isSafeInteger(Number(row.plan_point_id)) && Number(row.plan_point_id) > 0);
}

/** Поиск портала неточный: соседние номера отсекаются до выбора новой версии. */
export async function searchPlanRows(planNumber: number, options: PortalOptions = {}): Promise<GoszakupPlanListItem[]> {
  if (!Number.isSafeInteger(planNumber) || planNumber <= 0) throw new Error('Номер плана должен быть положительным целым');
  return (await fetchRegisterRows(`${GZ_PORTAL_ORIGIN}/ru/registry/plan?filter%5Bnumber%5D=${planNumber}&count_record=500`, options))
    .filter(row => row.plan_list_number === String(planNumber));
}

export type PortalVerificationReason = 'confirmed' | 'source_conflict' | 'portal_unavailable' | 'html_budget';
export interface PortalVerification {
  reason: PortalVerificationReason;
  portalVersion?: number;
  portalStatus?: string | null;
  message?: string;
}
interface VerifierOptions extends PortalOptions {
  delayMs?: number;
  searchFn?: (number: number) => Promise<GoszakupPlanListItem[]>;
  detailFn?: (row: GoszakupPlanListItem) => Promise<Pick<GoszakupPlanDetail, 'ref_enstru_code'> | null>;
}

/** Один экземпляр на прогон: общий бюджет, последовательная пауза и кэш поиска. */
export class PortalPlanVerifier {
  readonly stats = { confirmed: 0, source_conflict: 0, portal_unavailable: 0, html_budget: 0 };
  private readonly rows = new Map<number, Promise<GoszakupPlanListItem[]>>();
  private readonly details = new Map<string, Promise<Pick<GoszakupPlanDetail, 'ref_enstru_code'> | null>>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequest: number | null = null;
  constructor(private readonly options: VerifierOptions = {}) {}

  private request<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => {
      const now = this.options.now ?? Date.now;
      const pause = this.lastRequest === null ? 0 : Math.max(0, (this.options.delayMs ?? 1500) - (now() - this.lastRequest));
      if (now() + pause >= (this.options.deadline ?? Infinity)) throw new HtmlBudgetError();
      if (pause) await (this.options.sleepFn ?? sleep)(pause);
      try { return await fn(); } finally { this.lastRequest = now(); }
    });
    this.queue = pending.catch(() => {});
    return pending;
  }

  search(number: number): Promise<GoszakupPlanListItem[]> {
    let pending = this.rows.get(number);
    if (!pending) {
      pending = this.request(() => this.options.searchFn ? this.options.searchFn(number) : searchPlanRows(number, this.options));
      this.rows.set(number, pending);
    }
    return pending;
  }

  detail(row: GoszakupPlanListItem): Promise<Pick<GoszakupPlanDetail, 'ref_enstru_code'> | null> {
    let pending = this.details.get(row.plan_point_id);
    if (!pending) {
      pending = this.request(async () => {
        if (this.options.detailFn) return this.options.detailFn(row);
        if (!row.detail_url) throw new Error('Нет ссылки на карточку версии');
        const url = new URL(row.detail_url, GZ_PORTAL_ORIGIN);
        return parseGoszakupPlanDetailHtml(await fetchPortalPage(`${GZ_PORTAL_ORIGIN}${url.pathname}`, this.options), row.plan_point_id);
      });
      this.details.set(row.plan_point_id, pending);
    }
    return pending;
  }

  async verify(number: number, version: number | null, matches: (row: GoszakupPlanListItem) => boolean | Promise<boolean>): Promise<PortalVerification> {
    let result: PortalVerification;
    try {
      const rows = (await this.search(number)).filter(row => row.plan_list_number === String(number));
      const row = [...rows].sort((a, b) => Number(b.plan_point_id) - Number(a.plan_point_id))[0];
      const same = !!row && version === Number(row.plan_point_id) && await matches(row);
      result = { reason: same ? 'confirmed' : 'source_conflict', ...(row ? { portalVersion: Number(row.plan_point_id), portalStatus: row.status } : {}) };
    } catch (error) {
      result = { reason: error instanceof HtmlBudgetError ? 'html_budget' : 'portal_unavailable', message: error instanceof Error ? error.message : String(error) };
    }
    this.stats[result.reason]++;
    return result;
  }

  verifyItem(number: number, version: number, code: string): Promise<PortalVerification> {
    return this.verify(number, version, async row => {
      const detail = await this.detail(row);
      if (!detail?.ref_enstru_code) throw new Error('Карточка версии не содержит код ЕНС ТРУ');
      return detail.ref_enstru_code.trim() === code.trim();
    });
  }
}
