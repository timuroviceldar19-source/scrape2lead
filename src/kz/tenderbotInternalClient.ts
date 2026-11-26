/**
 * Неофициальный клиент внутреннего API tenderbot.kz (тот, что использует сам сайт).
 *
 * Публичный API (api.tenderbot.kz/api/external/v1) требует платный токен.
 * Внутренний API работает по обычному логину сайта и отдаёт те же лоты,
 * включая номер объявления (source_id), GZID и ссылку на карточку заказчика.
 */

export const TENDERBOT_HTML_ORIGIN = "https://tenderbot.kz";
export const TENDERBOT_API_BASE = "https://api.tenderbot.kz/api";

/** Больше 400 сайт молча сбрасывает per_page до 26. */
export const TENDERBOT_MAX_PER_PAGE = 400;

export interface TenderbotInternalClientOptions {
  apiBaseUrl?: string;
  login: string;
  password: string;
  /** Пауза между запросами: сайт банит за частые запросы. */
  delayMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
}

export interface TenderbotSearchFilters {
  /** Фразы через запятую, OR. */
  searchstr?: string;
  /** Слова-исключения. */
  excluded?: string[];
  /** Коды ТРУ (НСТРУ), OR. */
  truCodes?: string[];
  /** 1 — товары, 2 — услуги, 3 — работы. */
  subject?: Array<"1" | "2" | "3">;
  /** ID регионов из справочника KATO. */
  regionIds?: number[];
  methods?: string[];
  gzid?: string;
  amountFrom?: number;
  amountTo?: number;
  openDateFrom?: string;
  openDateTo?: string;
  closeDateFrom?: string;
  closeDateTo?: string;
  markPko?: boolean;
  markInvalid?: boolean;
  exactMatch?: boolean;
  sortCol?: string;
  sortType?: "asc" | "desc";
}

export interface TenderbotLot {
  id: number;
  sourceId: string | null;
  gzid: string | null;
  goszakupLink: string | null;
  name: string | null;
  amount: number | null;
  customer: string | null;
  customerBin: string | null;
  customerId: number | null;
  ktru: string | null;
  measure: string | null;
  count: number | null;
  pricePerUnit: number | null;
  deliveryPlace: string | null;
  openDate: string | null;
  closeDate: string | null;
  status: number | null;
  method: string | null;
}

export interface TenderbotSearchPage {
  total: number;
  perPage: number;
  currentPage: number;
  lastPage: number;
  lots: TenderbotLot[];
}

export class TenderbotAuthError extends Error {
  constructor(status: number) {
    super(`tenderbot.kz: HTTP ${status} — проверьте TENDERBOT_LOGIN/TENDERBOT_PASSWORD`);
    this.name = "TenderbotAuthError";
  }
}

export class TenderbotRateLimitError extends Error {
  constructor() {
    super("tenderbot.kz: слишком много запросов, сайт временно банит IP — увеличьте --delay-ms");
    this.name = "TenderbotRateLimitError";
  }
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 403]);

export function buildTenderbotSearchBody(
  filters: TenderbotSearchFilters,
  page: number,
  perPage: number
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    excluded: filters.excluded ?? [],
    customers: [],
    companies: [],
    kato_id: filters.regionIds ?? [],
    city_id: [],
    summ: filters.amountFrom || filters.amountTo
      ? [String(filters.amountFrom ?? 0), String(filters.amountTo ?? 9_999_999_999)]
      : [],
    close_date: filters.closeDateFrom || filters.closeDateTo
      ? [filters.closeDateFrom ?? "", filters.closeDateTo ?? ""]
      : [],
    open_date: filters.openDateFrom || filters.openDateTo
      ? [filters.openDateFrom ?? "", filters.openDateTo ?? ""]
      : [],
    reduct_perc: [],
    gzid: filters.gzid ?? "",
    search_tags: [],
    searchstr: filters.searchstr ?? "",
    tru_codes: filters.truCodes ?? [],
    markPko: filters.markPko ? 1 : 0,
    markInvalid: filters.markInvalid ? 1 : 0,
    subject: filters.subject ?? [],
    methods: filters.methods ?? [],
    failed_lots: 0,
    sort_col: filters.sortCol ?? "id",
    sort_type: filters.sortType ?? "desc",
    exactNameOnly: filters.exactMatch ? "1" : "0",
    page,
    per_page: Math.min(perPage, TENDERBOT_MAX_PER_PAGE)
  };
  return body;
}

interface RawLot {
  id?: number;
  source_id?: string | null;
  name_ru?: string | null;
  amount?: string | number | null;
  customer?: string | null;
  bin_inn?: string | null;
  customer_id?: number | null;
  ktru?: string | null;
  measure?: string | null;
  count?: string | number | null;
  price_per_unit?: string | number | null;
  delivery_place?: string | null;
  tenderOpenDate?: string | null;
  tenderCloseDate?: string | null;
  cstatus?: number | null;
  method?: { title?: string | null } | null;
  tender?: { gzid?: string | null; link?: string | null } | null;
}

interface RawLotsPayload {
  success?: boolean;
  aData?: {
    lots?: {
      total?: number;
      per_page?: number;
      current_page?: number;
      last_page?: number;
      data?: RawLot[];
    };
  };
}

const toNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Просроченный токен: поля приходят, но название/номер/заказчик скрыты. */
const isDegraded = (lot: RawLot | undefined): boolean =>
  lot !== undefined && (lot.name_ru === "" || lot.source_id === "hidden" || lot.tender?.gzid === "hidden");

export function mapTenderbotLot(raw: RawLot): TenderbotLot {
  return {
    id: Number(raw.id ?? 0),
    sourceId: raw.source_id ?? null,
    gzid: raw.tender?.gzid ?? null,
    goszakupLink: raw.tender?.link ?? null,
    name: raw.name_ru ?? null,
    amount: toNumber(raw.amount),
    customer: raw.customer ?? null,
    customerBin: raw.bin_inn ?? null,
    customerId: raw.customer_id ?? null,
    ktru: raw.ktru ?? null,
    measure: raw.measure ?? null,
    count: toNumber(raw.count),
    pricePerUnit: toNumber(raw.price_per_unit),
    deliveryPlace: raw.delivery_place ?? null,
    openDate: raw.tenderOpenDate ?? null,
    closeDate: raw.tenderCloseDate ?? null,
    status: raw.cstatus ?? null,
    method: raw.method?.title ?? null
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TenderbotInternalClient {
  private readonly apiBaseUrl: string;
  private readonly loginValue: string;
  private readonly password: string;
  private readonly delayMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;
  private token: string | null = null;
  private degradedChecked = false;

  constructor(options: TenderbotInternalClientOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? TENDERBOT_API_BASE).replace(/\/+$/, "");
    this.loginValue = options.login;
    this.password = options.password;
    this.delayMs = options.delayMs ?? 1200;
    this.maxRetries = options.maxRetries ?? 4;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async login(): Promise<string> {
    const response = await this.fetchFn(`${this.apiBaseUrl}/login`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ login: this.loginValue, password: this.password, remember: true })
    });
    if (!response.ok) throw new TenderbotAuthError(response.status);
    const payload = (await response.json()) as { accessToken?: string; success?: boolean };
    if (!payload.success || !payload.accessToken) throw new TenderbotAuthError(401);
    this.token = payload.accessToken;
    this.degradedChecked = false;
    return payload.accessToken;
  }

  async searchPage(
    filters: TenderbotSearchFilters,
    page: number,
    perPage = TENDERBOT_MAX_PER_PAGE
  ): Promise<TenderbotSearchPage> {
    let token = this.token ?? (await this.login());
    const body = buildTenderbotSearchBody(filters, page, perPage);
    let lastStatus = 0;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(this.delayMs * 2 ** attempt, 15_000));
      const response = await this.fetchFn(`${this.apiBaseUrl}/lots`, {
        method: "POST",
        headers: { ...this.headers(), Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      lastStatus = response.status;

      if (response.status === 401) {
        this.token = null;
        return this.searchPage(filters, page, perPage);
      }
      if (RETRYABLE_STATUSES.has(response.status)) continue;
      if (!response.ok) {
        throw new Error(`tenderbot.kz: HTTP ${response.status} для ${this.apiBaseUrl}/lots`);
      }

      const payload = (await response.json()) as RawLotsPayload;
      const lots = payload.aData?.lots;

      // Просроченный токен отдаёт 200, но прячет название, номер и заказчика.
      // Один раз перелогиниваемся, чтобы не собирать пустые строки.
      if (!this.degradedChecked) {
        this.degradedChecked = true;
        if (isDegraded(lots?.data?.[0]) && attempt === 0) {
          token = await this.login();
          continue;
        }
      }

      return {
        total: Number(lots?.total ?? 0),
        perPage: Number(lots?.per_page ?? perPage),
        currentPage: Number(lots?.current_page ?? page),
        lastPage: Number(lots?.last_page ?? 1),
        lots: (lots?.data ?? []).map(mapTenderbotLot)
      };
    }

    if (lastStatus === 403) throw new TenderbotRateLimitError();
    throw new Error(`tenderbot.kz: не удалось получить страницу ${page}, последний статус ${lastStatus}`);
  }

  /**
   * Перебирает все страницы выдачи. Возвращает уникальные лоты и число страниц.
   * Пауза между запросами обязательна: сайт режет залпом запросов.
   */
  async searchAll(
    filters: TenderbotSearchFilters,
    options: { maxPages?: number; perPage?: number; onPage?: (page: TenderbotSearchPage) => void } = {}
  ): Promise<{ lots: TenderbotLot[]; pages: number; total: number }> {
    const maxPages = options.maxPages ?? 200;
    const perPage = Math.min(options.perPage ?? TENDERBOT_MAX_PER_PAGE, TENDERBOT_MAX_PER_PAGE);
    const seen = new Set<number>();
    const collected: TenderbotLot[] = [];
    let total = 0;
    let pages = 0;

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(this.delayMs);
      const result = await this.searchPage(filters, page, perPage);
      pages = page;
      total = result.total;
      options.onPage?.(result);

      for (const lot of result.lots) {
        if (seen.has(lot.id)) continue;
        seen.add(lot.id);
        collected.push(lot);
      }

      if (page >= result.lastPage || result.lots.length === 0) break;
    }

    return { lots: collected, pages, total };
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: TENDERBOT_HTML_ORIGIN,
      Referer: `${TENDERBOT_HTML_ORIGIN}/lots`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    };
  }
}
