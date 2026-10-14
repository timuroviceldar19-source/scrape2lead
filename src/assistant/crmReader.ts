/**
 * Чтение CRM Bitrix24 для помощника. У входящего вебхука нет режима «только чтение»
 * (права задаются по модулям), поэтому запись исключена здесь, в коде: разрешены лишь
 * методы получения данных из белого списка, всё остальное отклоняется до любого сетевого запроса.
 */

const ALLOWED_METHODS = new Set([
  "crm.deal.get",
  "crm.deal.list",
  "crm.deal.fields",
  "crm.company.get",
  "crm.company.list",
  "crm.contact.list",
  "crm.activity.list",
  "crm.status.list"
]);

/** Робот пишет `ORIGIN_ID` компании как `gz-company:<БИН>`, у старых карточек там голый БИН. */
function binFromOriginId(origin: string): string | null {
  return /^(?:gz-company:)?(\d{12})$/.exec(origin.trim())?.[1] ?? null;
}
const MAX_VALUE_CHARS = 400;
const ALMATY_OFFSET_MS = 5 * 3_600_000;
const COMPANY_DEALS_READ = 100;
const COMPANY_DEALS_SHOWN = 8;
const CALL_OWNERS_READ = 50;
const CALLS_SHOWN = 10;
const CONTACTS_SHOWN = 15;
const CRM_OWNER_DEAL = 2;
const CRM_OWNER_CONTACT = 3;
const ACTIVITY_CALL = 2;

export class CrmReadError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "CrmReadError";
  }
}

/** Компания сделки. У заказчиков из сделок по лотам БИН лежит в ORIGIN_ID компании, а не в полях сделки. */
export interface DealCompany {
  id: number;
  title: string;
  bin: string | null;
}

/** Контакт из CRM. Резюме соискателей (поле `UF_CRM_HHAPPLICANTID`) сюда не попадают. */
export interface CrmContact {
  id: number;
  name: string;
  post: string | null;
  phones: string[];
  emails: string[];
  assignedById: number | null;
}

export interface CrmCompanyDeal {
  id: number;
  title: string;
  stage: string;
  /** `won`: сделка успешна, `lost`: провалена, `open`: в работе. */
  outcome: "won" | "lost" | "open";
  amount: number | null;
  assignedById: number | null;
  created: string;
}

/** Звонок из карточки сделки или контакта. Телефонный номер лежит в теме звонка. */
export interface CrmCall {
  /** Время по Алматы, `YYYY-MM-DD HH:mm`. */
  date: string;
  direction: "in" | "out" | null;
  subject: string;
  responsibleId: number | null;
  /** Сделка, к которой привязан звонок; у звонка по контакту её нет. */
  dealId: number | null;
}

export interface CrmCustomerHistory {
  companies: Array<DealCompany & { phones: string[]; emails: string[] }>;
  contacts: CrmContact[];
  deals: { total: number; won: number; lost: number; open: number; recent: CrmCompanyDeal[] };
  calls: CrmCall[];
}

export interface DealSummary {
  id: number;
  title: string;
  stageId: string;
  /** Название стадии воронки; если справочник не прочитался, её код. */
  stage: string;
  /** Ответственный за сделку; имени нет (нужен другой доступ Bitrix), только номер сотрудника. */
  assignedById: number | null;
  amount: number | null;
  companyId: number | null;
  company: DealCompany | null;
  originId: string | null;
  /** План закупок (`gz-plan:`), лот (`gz-lot:`) или другое. */
  kind: "plan" | "lot" | "other";
  fields: Array<{ label: string; value: string }>;
}

export interface MyDeal {
  id: number;
  title: string;
  /** Название стадии воронки; если справочник не прочитался, её код. */
  stage: string;
  amount: number | null;
  kind: DealSummary["kind"];
  /** Номер лота у сделки по лоту. Настоящий срок приёма заявок нужно смотреть в реестре по нему: CLOSEDATE в Bitrix ему не равен. */
  lotNumber: string | null;
  modified: string;
}

export interface MyDealsRequest {
  userId: number;
  /** `lots`: только сделки по лотам; `all`: любые. */
  scope: "lots" | "all";
  /** `newest`: по номеру сделки, новые первыми; `recent`: по дате изменения. */
  order: "newest" | "recent";
  limit: number;
}

export interface CrmReaderOptions {
  webhookUrl: string;
  fetchFn?: typeof fetch;
}

interface FieldMeta {
  label: string;
  type: string;
}

export class CrmReader {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private fieldMeta: Map<string, FieldMeta> | null = null;
  private readonly stageNames = new Map<number, Map<string, string>>();

  constructor(options: CrmReaderOptions) {
    this.baseUrl = options.webhookUrl.endsWith("/") ? options.webhookUrl : `${options.webhookUrl}/`;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return (await this.request(method, params)).result;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<{ result: unknown; total: number | null; next: number | null }> {
    if (!ALLOWED_METHODS.has(method)) {
      throw new CrmReadError(`Метод ${method} не разрешён: помощник только читает CRM`, "METHOD_NOT_ALLOWED");
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      throw new CrmReadError(`${method}: Bitrix24 недоступен`, "NETWORK");
    }

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const code = typeof payload?.error === "string" && payload.error ? payload.error : null;
    if (!response.ok || code) {
      const description = typeof payload?.error_description === "string" ? payload.error_description : `HTTP ${response.status}`;
      throw new CrmReadError(`${method}: ${description}`, code ?? `HTTP_${response.status}`);
    }
    return { result: payload?.result, total: typeof payload?.total === "number" ? payload.total : null, next: typeof payload?.next === "number" ? payload.next : null };
  }

  async getDealSummary(id: number): Promise<DealSummary> {
    const raw = (await this.call("crm.deal.get", { id })) as Record<string, unknown> | null;
    if (!raw) throw new CrmReadError(`Сделка ${id} не найдена`, "NOT_FOUND");
    const meta = await this.loadFieldMeta();

    const fields: Array<{ label: string; value: string }> = [];
    for (const [name, value] of Object.entries(raw)) {
      if (!name.startsWith("UF_")) continue;
      const field = meta.get(name);
      if (field?.type === "enumeration" || field?.type === "employee") continue; // в значении только числовые id
      const text = formatValue(value, field?.type);
      if (text) fields.push({ label: field?.label ?? name, value: text });
    }

    const originId = typeof raw.ORIGIN_ID === "string" && raw.ORIGIN_ID ? raw.ORIGIN_ID : null;
    const companyId = toNumber(raw.COMPANY_ID);
    return {
      id: Number(raw.ID ?? id),
      title: String(raw.TITLE ?? ""),
      stageId: String(raw.STAGE_ID ?? ""),
      stage: await this.stageName(String(raw.STAGE_ID ?? ""), Number(raw.CATEGORY_ID) || 0),
      assignedById: toNumber(raw.ASSIGNED_BY_ID),
      amount: toNumber(raw.OPPORTUNITY),
      companyId,
      company: companyId ? await this.readCompany(companyId) : null,
      originId,
      kind: originId?.startsWith("gz-plan:") ? "plan" : originId?.startsWith("gz-lot:") ? "lot" : "other",
      fields
    };
  }

  /** Открытые сделки менеджера: всего и первые `limit` в выбранном порядке (страницы по 50). */
  async listMyDeals(request: MyDealsRequest): Promise<{ total: number; deals: MyDeal[] }> {
    const filter: Record<string, unknown> = { ASSIGNED_BY_ID: request.userId, STAGE_SEMANTIC_ID: "P" };
    if (request.scope === "lots") filter["%ORIGIN_ID"] = "gz-lot:";
    const order = request.order === "newest" ? { ID: "DESC" } : { DATE_MODIFY: "DESC" };

    const rows: Array<Record<string, unknown>> = [];
    let total: number | null = null;
    let start = 0;
    while (rows.length < request.limit) {
      const page = await this.request("crm.deal.list", {
        filter,
        select: ["ID", "TITLE", "STAGE_ID", "CATEGORY_ID", "OPPORTUNITY", "ORIGIN_ID", "DATE_MODIFY"],
        order,
        ...(start ? { start } : {})
      });
      total = page.total ?? total;
      rows.push(...(((page.result as Array<Record<string, unknown>> | null) ?? [])));
      if (page.next === null) break;
      start = page.next;
    }

    const deals: MyDeal[] = [];
    for (const row of rows.slice(0, request.limit)) {
      const originId = typeof row.ORIGIN_ID === "string" ? row.ORIGIN_ID : "";
      const kind = originId.startsWith("gz-plan:") ? "plan" : originId.startsWith("gz-lot:") ? "lot" : "other";
      deals.push({
        id: Number(row.ID),
        title: String(row.TITLE ?? ""),
        stage: await this.stageName(String(row.STAGE_ID ?? ""), Number(row.CATEGORY_ID) || 0),
        amount: toNumber(row.OPPORTUNITY),
        kind,
        lotNumber: kind === "lot" ? originId.slice("gz-lot:".length) || null : null,
        modified: String(row.DATE_MODIFY ?? "").slice(0, 10)
      });
    }
    return { total: total ?? deals.length, deals };
  }

  /** Названия стадий читаются по одному разу на воронку; сбой справочника не мешает показать код стадии. */
  private async stageName(stageId: string, category: number): Promise<string> {
    let names = this.stageNames.get(category);
    if (!names) {
      names = new Map();
      try {
        const entity = category ? `DEAL_STAGE_${category}` : "DEAL_STAGE";
        const list = ((await this.call("crm.status.list", { filter: { ENTITY_ID: entity } })) as Array<Record<string, unknown>> | null) ?? [];
        for (const item of list) names.set(String(item.STATUS_ID ?? ""), String(item.NAME ?? ""));
        this.stageNames.set(category, names);
      } catch (error) {
        if (!(error instanceof CrmReadError)) throw error;
      }
    }
    return names.get(stageId) || stageId;
  }

  /** Сбой чтения компании не должен ломать чтение самой сделки. */
  private async readCompany(id: number): Promise<DealCompany | null> {
    try {
      const raw = (await this.call("crm.company.get", { id })) as Record<string, unknown> | null;
      if (!raw) return null;
      return { id, title: String(raw.TITLE ?? "").trim(), bin: binFromOriginId(String(raw.ORIGIN_ID ?? "")) };
    } catch (error) {
      if (error instanceof CrmReadError) return null;
      throw error;
    }
  }

  /** Компании Bitrix по части названия: так находится БИН заказчика, которого реестр по неполному названию не отдаёт. */
  async findCompanies(name: string, limit = 5): Promise<DealCompany[]> {
    const rows = (await this.call("crm.company.list", {
      filter: { "%TITLE": name },
      select: ["ID", "TITLE", "ORIGIN_ID"],
      order: { ID: "DESC" },
      start: -1
    })) as Array<Record<string, unknown>> | null;
    return (rows ?? []).slice(0, limit).map((row) => ({ id: Number(row.ID), title: String(row.TITLE ?? "").trim(), bin: binFromOriginId(String(row.ORIGIN_ID ?? "")) }));
  }

  /**
   * Что про заказчика уже есть в нашем Bitrix: компания, контакты (своя и из сделок), прошлые сделки и звонки.
   * Заказчик находится по БИН (`ORIGIN_ID` компании) или по номеру компании. Только чтение; звонки читаются
   * по сделкам и контактам заказчика, поэтому чужие звонки сюда не попадают. Сбой чтения звонков не ломает ответ.
   */
  async customerInCrm(target: { bin?: string; companyId?: number; alsoCompanyIds?: number[] }): Promise<CrmCustomerHistory | null> {
    const companyRows = await this.readCompanyRows(target);
    if (!companyRows.length) return null;
    const companyIds = companyRows.map((row) => Number(row.ID));

    const dealPage = await this.request("crm.deal.list", {
      filter: { COMPANY_ID: companyIds },
      select: ["ID", "TITLE", "STAGE_ID", "STAGE_SEMANTIC_ID", "CATEGORY_ID", "ASSIGNED_BY_ID", "DATE_CREATE", "OPPORTUNITY", "CONTACT_ID"],
      order: { ID: "DESC" }
    });
    const dealRows = ((dealPage.result as Array<Record<string, unknown>> | null) ?? []).slice(0, COMPANY_DEALS_READ);
    const outcomeOf = (row: Record<string, unknown>): CrmCompanyDeal["outcome"] => (row.STAGE_SEMANTIC_ID === "S" ? "won" : row.STAGE_SEMANTIC_ID === "F" ? "lost" : "open");

    const recent: CrmCompanyDeal[] = [];
    for (const row of dealRows.slice(0, COMPANY_DEALS_SHOWN)) {
      recent.push({
        id: Number(row.ID),
        title: String(row.TITLE ?? ""),
        stage: await this.stageName(String(row.STAGE_ID ?? ""), Number(row.CATEGORY_ID) || 0),
        outcome: outcomeOf(row),
        amount: toNumber(row.OPPORTUNITY),
        assignedById: toNumber(row.ASSIGNED_BY_ID),
        created: String(row.DATE_CREATE ?? "").slice(0, 10)
      });
    }

    const contacts = await this.readContacts(companyIds, dealRows);
    const calls = await this.readCalls(dealRows.slice(0, CALL_OWNERS_READ).map((row) => Number(row.ID)), contacts.map((contact) => contact.id));

    return {
      companies: companyRows.map((row) => ({
        id: Number(row.ID),
        title: String(row.TITLE ?? "").trim(),
        bin: binFromOriginId(String(row.ORIGIN_ID ?? "")),
        phones: multiValues(row.PHONE),
        emails: multiValues(row.EMAIL)
      })),
      contacts,
      deals: {
        total: dealPage.total ?? dealRows.length,
        won: dealRows.filter((row) => outcomeOf(row) === "won").length,
        lost: dealRows.filter((row) => outcomeOf(row) === "lost").length,
        open: dealRows.filter((row) => outcomeOf(row) === "open").length,
        recent
      },
      calls
    };
  }

  /**
   * Компании заказчика. У компаний, заведённых роботом по лотам, БИН лежит в `ORIGIN_ID`; у компаний из пунктов плана и у старых
   * он остался только в комментарии («BIN: <БИН>») компании или её сделок, поэтому ищем по всем трём местам.
   */
  private async readCompanyRows(target: { bin?: string; companyId?: number; alsoCompanyIds?: number[] }): Promise<Array<Record<string, unknown>>> {
    if (target.companyId) {
      const row = (await this.call("crm.company.get", { id: target.companyId })) as Record<string, unknown> | null;
      return row ? [row] : [];
    }
    if (!target.bin) return [];
    const select = ["ID", "TITLE", "ORIGIN_ID", "PHONE", "EMAIL"];
    const list = async (filter: Record<string, unknown>) => ((await this.call("crm.company.list", { filter, select, order: { ID: "DESC" } })) as Array<Record<string, unknown>> | null) ?? [];
    const tag = `BIN: ${target.bin}`;

    const rows = new Map<number, Record<string, unknown>>();
    for (const row of [...(await list({ ORIGIN_ID: [`gz-company:${target.bin}`, target.bin] })), ...(await list({ "%COMMENTS": tag }))]) rows.set(Number(row.ID), row);

    const dealPage = await this.request("crm.deal.list", { filter: { "%COMMENTS": tag }, select: ["ID", "COMPANY_ID"], order: { ID: "DESC" } });
    const viaDeals = [...new Set(((dealPage.result as Array<Record<string, unknown>> | null) ?? []).map((row) => Number(row.COMPANY_ID)).filter((id) => id > 0 && !rows.has(id)))];
    if (viaDeals.length) for (const row of await list({ ID: viaDeals })) rows.set(Number(row.ID), row);
    // Двойники: та же организация, заведённая без БИН. Их назвал вызывающий, сверив название с реестром.
    const twins = [...new Set(target.alsoCompanyIds ?? [])].filter((id) => !rows.has(id));
    if (twins.length) for (const row of await list({ ID: twins })) rows.set(Number(row.ID), row);
    return [...rows.values()];
  }

  /** Контакты компании и контакты её сделок, без повторов. Резюме соискателей отбрасываются. */
  private async readContacts(companyIds: number[], dealRows: Array<Record<string, unknown>>): Promise<CrmContact[]> {
    const select = ["ID", "NAME", "SECOND_NAME", "LAST_NAME", "POST", "PHONE", "EMAIL", "ASSIGNED_BY_ID", "UF_CRM_HHAPPLICANTID"];
    const rows = (((await this.call("crm.contact.list", { filter: { COMPANY_ID: companyIds }, select })) as Array<Record<string, unknown>> | null) ?? []).slice();
    const known = new Set(rows.map((row) => Number(row.ID)));
    const dealContactIds = [...new Set(dealRows.map((row) => Number(row.CONTACT_ID)).filter((id) => id > 0 && !known.has(id)))];
    if (dealContactIds.length) {
      rows.push(...(((await this.call("crm.contact.list", { filter: { ID: dealContactIds }, select })) as Array<Record<string, unknown>> | null) ?? []));
    }
    return rows
      .filter((row) => !String(row.UF_CRM_HHAPPLICANTID ?? "").trim())
      .map((row) => ({
        id: Number(row.ID),
        // В нашем Bitrix ФИО набирают как попало: фамилия чаще в NAME, остальное в LAST_NAME. Порядок NAME, LAST_NAME, SECOND_NAME читается как ФИО.
        name: [row.NAME, row.LAST_NAME, row.SECOND_NAME].map((part) => String(part ?? "").trim()).filter(Boolean).join(" "),
        post: String(row.POST ?? "").trim() || null,
        phones: multiValues(row.PHONE),
        emails: multiValues(row.EMAIL),
        assignedById: toNumber(row.ASSIGNED_BY_ID)
      }))
      .filter((contact) => contact.phones.length > 0 || contact.emails.length > 0)
      .slice(0, CONTACTS_SHOWN);
  }

  private async readCalls(dealIds: number[], contactIds: number[]): Promise<CrmCall[]> {
    const select = ["ID", "SUBJECT", "DIRECTION", "START_TIME", "RESPONSIBLE_ID", "OWNER_ID"];
    const found: Array<{ call: CrmCall; time: number }> = [];
    const owners: Array<[number, number[]]> = [
      [CRM_OWNER_DEAL, dealIds],
      [CRM_OWNER_CONTACT, contactIds]
    ];
    for (const [ownerType, ids] of owners) {
      if (!ids.length) continue;
      let rows: Array<Record<string, unknown>>;
      try {
        rows = ((await this.call("crm.activity.list", { filter: { OWNER_TYPE_ID: ownerType, OWNER_ID: ids, TYPE_ID: ACTIVITY_CALL }, select, order: { ID: "DESC" } })) as Array<Record<string, unknown>> | null) ?? [];
      } catch (error) {
        if (error instanceof CrmReadError) continue;
        throw error;
      }
      for (const row of rows) {
        const time = Date.parse(String(row.START_TIME ?? ""));
        if (!Number.isFinite(time)) continue;
        found.push({
          time,
          call: {
            date: new Date(time + ALMATY_OFFSET_MS).toISOString().slice(0, 16).replace("T", " "),
            direction: row.DIRECTION === "1" ? "in" : row.DIRECTION === "2" ? "out" : null,
            subject: String(row.SUBJECT ?? "").trim(),
            responsibleId: toNumber(row.RESPONSIBLE_ID),
            dealId: ownerType === CRM_OWNER_DEAL ? toNumber(row.OWNER_ID) : null
          }
        });
      }
    }
    return found.sort((a, b) => b.time - a.time).slice(0, CALLS_SHOWN).map((entry) => entry.call);
  }

  /**
   * Поиск по подстроке в названии: номер лота, номер пункта плана, имя заказчика или товар.
   * `total` — сколько сделок подходит всего, а не сколько вернулось. С `userId` ищет только среди открытых сделок этого менеджера.
   */
  async findDeals(text: string, options: { limit?: number; userId?: number } = {}): Promise<{ total: number; deals: Array<{ id: number; title: string }> }> {
    const filter: Record<string, unknown> = { "%TITLE": text };
    if (options.userId !== undefined) {
      filter.ASSIGNED_BY_ID = options.userId;
      filter.STAGE_SEMANTIC_ID = "P";
    }
    const page = await this.request("crm.deal.list", { filter, select: ["ID", "TITLE"], order: { ID: "DESC" } });
    const rows = (page.result as Array<Record<string, unknown>> | null) ?? [];
    return {
      total: page.total ?? rows.length,
      deals: rows.slice(0, options.limit ?? 5).map((row) => ({ id: Number(row.ID), title: String(row.TITLE ?? "") }))
    };
  }

  /** Подписи пользовательских полей: crm.deal.userfield.list их не отдаёт, они лежат в crm.deal.fields (formLabel/listLabel). */
  private async loadFieldMeta(): Promise<Map<string, FieldMeta>> {
    if (this.fieldMeta) return this.fieldMeta;
    const catalog = ((await this.call("crm.deal.fields", {})) as Record<string, Record<string, unknown>> | null) ?? {};
    const meta = new Map<string, FieldMeta>();
    for (const [name, field] of Object.entries(catalog)) {
      if (!name.startsWith("UF_") || !field) continue;
      meta.set(name, { label: pickLabel(field.formLabel) ?? pickLabel(field.listLabel) ?? pickLabel(field.filterLabel) ?? name, type: String(field.type ?? "") });
    }
    this.fieldMeta = meta;
    return meta;
  }
}

function pickLabel(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object") {
    const labels = value as Record<string, unknown>;
    const preferred = typeof labels.ru === "string" ? labels.ru : Object.values(labels).find((v): v is string => typeof v === "string");
    return preferred?.trim() || null;
  }
  return null;
}

function formatValue(value: unknown, type: string | undefined): string | null {
  if (value === null || value === undefined || value === false) return null;
  if (type === "boolean") return value === true || value === "1" || value === "Y" ? "Да" : null;
  if (Array.isArray(value)) {
    const parts = value.map((item) => formatValue(item, undefined)).filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(", ") : null;
  }
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text || text === "0") return null;
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

/** Телефоны и почта в Bitrix приходят списком `[{ VALUE }]`. */
function multiValues(value: unknown): string[] {
  return (Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []).map((item) => String(item.VALUE ?? "").trim()).filter(Boolean);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number !== 0 ? number : null;
}
