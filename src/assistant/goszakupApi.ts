/**
 * Запросы помощника к API портала госзакупок v3 (GraphQL, нужен GOSZAKUP_TOKEN):
 * карточка организации с контактами и прошлые закупки заказчика с файлами.
 */

import { goszakupGraphqlPage, type GoszakupGraphqlOptions } from "../kz/goszakupGraphql.js";

export interface CustomerCard {
  bin: string;
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  /** Вышестоящая организация из карточки реестра (у многих заказчиков не заполнена). */
  parentOrg: string | null;
  /** Администраторы бюджетных программ: кто стоит над заказчиком по бюджету. */
  administrators: CustomerAdministrator[];
  /** Другие телефоны организации из её адресов в реестре (без основного и без повторов). */
  extraPhones: string[];
  /** Пользователь с ролью «Руководитель» в кабинете организации на портале (ФИО как в реестре). */
  head: string | null;
}

export interface CustomerAdministrator {
  /** БИН администратора: по нему можно взять его карточку и контакты управления. */
  bin: string | null;
  name: string;
  budget: string | null;
  /** День, с которого запись действует. */
  since: string | null;
}

export interface CommissionMember {
  fullName: string;
  /** Роли в комиссиях, от важной к менее важной (председатель, секретарь, член). */
  roles: string[];
  /** В скольких из проверенных закупок состоит в комиссии. */
  tenders: number;
}

export interface CommissionSummary {
  tendersChecked: number;
  tendersWithCommission: number;
  members: CommissionMember[];
}

export interface TenderSummary {
  announceId: number;
  number: string;
  publishDate: string;
  title: string;
  totalSum: number | null;
  specFiles: Array<{ name: string; url: string }>;
  otherFiles: number;
}

export interface ContractContact {
  fullName: string;
  phones: string[];
  contracts: number;
  lastSignDate: string;
}

export interface ContractPrice {
  contractId: number;
  signDate: string;
  customerBin: string;
  customerName: string;
  supplierBin: string;
  supplierName: string;
  /** Цена за единицу с НДС: так же указаны суммы в плане, поэтому её удобно сравнивать. */
  unitPrice: number;
  unitPriceNoVat: number;
  quantity: number;
}

export interface PriceSummary {
  count: number;
  min: number;
  median: number;
  max: number;
}

export interface HistoryContract {
  id: number;
  signDate: string;
  sum: number | null;
  title: string;
  supplierBin: string;
  supplierName: string;
}

export interface CustomerHistory {
  totalContracts: number;
  contracts: HistoryContract[];
  topSuppliers: Array<{ bin: string; name: string; contracts: number }>;
}

export interface CustomerSupplier {
  bin: string;
  name: string;
  contracts: number;
  totalSum: number;
  lastSignDate: string;
  /** До трёх разных названий закупок: что именно этот поставщик поставлял заказчику. */
  subjects: string[];
}

export interface CustomerSuppliers {
  totalContracts: number;
  /** Сколько последних договоров разобрано (потолок запроса к реестру). */
  analyzed: number;
  suppliers: CustomerSupplier[];
}

/** Статус лота и срок приёма заявок: всё, что нужно, чтобы понять, горит ли закупка. */
export interface LotDeadline {
  lotNumber: string;
  lotStatus: string | null;
  applicationsFrom: string | null;
  applicationsUntil: string | null;
}

export interface PlanInfo {
  id: number;
  name: string;
  year: number | null;
  month: string | null;
  status: string | null;
  tradeMethod: string | null;
  amount: number | null;
  count: number | null;
  unitPrice: number | null;
  enstruCode: string | null;
}

export interface PlanLot {
  lotNumber: string;
  lotStatus: string | null;
  amount: number | null;
  count: number | null;
  announceId: number;
  announceNumber: string;
  buyStatus: string | null;
  applicationsFrom: string | null;
  applicationsUntil: string | null;
  specFiles: Array<{ name: string; url: string }>;
  otherFiles: string[];
}

/** Лот по его номеру: заказчик с БИН, реальный срок приёма заявок и актуальные пункты плана. */
export interface LotInfo extends PlanLot {
  name: string;
  description: string;
  customerBin: string;
  customerName: string;
  /** Пункты плана лота. Номер перед дефисом в номере лота может быть старым, поэтому верить нужно этому списку. */
  pointIds: number[];
  plans: PlanInfo[];
}

export interface PlanStatus {
  plan: PlanInfo | null;
  lots: PlanLot[];
}

const MAX_EXTRA_PHONES = 5;
const MIN_CONTRACT_PHONE_DIGITS = 5;
const MAX_CONTRACT_PHONES = 6;
const COMMISSION_TENDERS = 10;

const SUBJECT_FIELDS = "bin nameRu email phone website parentNameRu Admins { bin nameRu budgetRu startDate } Address { phone } Employees { fio role disabled }";

const CARD_BY_BIN = `query($bin: String) { Subjects(filter: { bin: $bin }, limit: 1) { ${SUBJECT_FIELDS} } }`;
const CARDS_BY_NAME = `query($name: String, $limit: Int) { Subjects(filter: { nameRu: $name }, limit: $limit) { ${SUBJECT_FIELDS} } }`;
const TENDERS_BY_BIN = `query($bin: String, $limit: Int) {
  TrdBuy(filter: { orgBin: $bin }, limit: $limit) {
    id numberAnno nameRu publishDate totalSum
    Files { nameRu originalName filePath }
  }
}`;

const TENDER_COMMISSIONS = `query($bin: String, $limit: Int) {
  TrdBuy(filter: { orgBin: $bin }, limit: $limit) { numberAnno Commission { fio active RefCommRoles { nameRu } } }
}`;

const CONTRACT_CONTACTS = `query($bin: String, $limit: Int) {
  Contract(filter: { customerBin: $bin }, limit: $limit) { customerFio customerPhone signDate }
}`;
const CONTRACT_PRICES = `query($code: [String], $year: Int, $limit: Int) {
  Contract(filter: { finYear: $year }, contractUnitsFilter: { refEnstruCode: $code }, limit: $limit) {
    id signDate customerBin Customer { nameRu } supplierBiin Supplier { nameRu }
    ContractUnits { itemPrice itemPriceWnds quantity refEnstruCode }
  }
}`;
const CUSTOMER_HISTORY = `query($bin: String, $limit: Int) {
  Contract(filter: { customerBin: $bin }, limit: $limit) { id signDate contractSum trdBuyNameRu supplierBiin Supplier { nameRu } }
}`;
const CUSTOMER_HISTORY_BY_CODE = `query($bin: String, $code: [String], $limit: Int) {
  Contract(filter: { customerBin: $bin }, contractUnitsFilter: { refEnstruCode: $code }, limit: $limit) { id signDate contractSum trdBuyNameRu supplierBiin Supplier { nameRu } }
}`;
const PLAN_BY_ID = `query($id: [Int]) {
  Plans(filter: { id: $id }, limit: 1) {
    id nameRu plnPointYear amount count price refEnstruCode
    RefMonths { nameRu } RefPlnPointStatus { nameRu } RefTradeMethods { nameRu }
  }
}`;
const LOTS_BY_POINT = `query($point: [Int]) {
  Lots(filter: { pointList: $point }, limit: 20) {
    lotNumber amount count trdBuyId trdBuyNumberAnno RefLotsStatus { nameRu }
    TrdBuy { id startDate endDate RefBuyStatus { nameRu } Files { nameRu originalName filePath } }
  }
}`;

const LOT_BY_NUMBER = `query($lot: String) {
  Lots(filter: { lotNumber: $lot }, limit: 1) {
    lotNumber nameRu descriptionRu amount count customerBin customerNameRu pointList trdBuyId trdBuyNumberAnno
    RefLotsStatus { nameRu }
    TrdBuy { id startDate endDate RefBuyStatus { nameRu } Files { nameRu originalName filePath } }
  }
}`;
const LOT_DEADLINE = `query($lot: String) {
  Lots(filter: { lotNumber: $lot }, limit: 1) { lotNumber RefLotsStatus { nameRu } TrdBuy { startDate endDate } }
}`;
const PLAN_CODES_BY_NAME = `query($n: String, $y: [Int]) {
  Plans(filter: { nameRu: $n, plnPointYear: $y }, limit: 200) { refEnstruCode }
}`;
const PLANS_BY_IDS = `query($id: [Int]) {
  Plans(filter: { id: $id }, limit: 20) {
    id nameRu plnPointYear amount count price refEnstruCode
    RefMonths { nameRu } RefPlnPointStatus { nameRu } RefTradeMethods { nameRu }
  }
}`;

type Row = Record<string, unknown>;

const ALMATY_OFFSET_MS = 5 * 3_600_000;
const DEADLINE_TTL_MS = 10 * 60_000;

export class GoszakupApi {
  private readonly options: GoszakupGraphqlOptions;
  private readonly now: () => number;
  private readonly deadlines = new Map<string, { value: LotDeadline; at: number; final: boolean }>();

  constructor(options: GoszakupGraphqlOptions, extra: { now?: () => number } = {}) {
    this.options = options;
    this.now = extra.now ?? Date.now;
  }

  async customerCard(bin: string): Promise<CustomerCard | null> {
    const page = await goszakupGraphqlPage<Row>(CARD_BY_BIN, { bin }, "Subjects", this.options);
    return page.items[0] ? toCard(page.items[0]) : null;
  }

  async findCustomers(name: string, limit = 5): Promise<CustomerCard[]> {
    const page = await goszakupGraphqlPage<Row>(CARDS_BY_NAME, { name, limit }, "Subjects", this.options);
    return page.items.map(toCard);
  }

  /** Свежие закупки, где организация выступает организатором; технические спецификации идут отдельным списком. */
  async recentTenders(bin: string, limit = 5): Promise<TenderSummary[]> {
    const page = await goszakupGraphqlPage<Row>(TENDERS_BY_BIN, { bin, limit }, "TrdBuy", this.options);
    return page.items.map((row) => {
      const files = Array.isArray(row.Files) ? (row.Files as Row[]) : [];
      const specFiles = files
        .filter((file) => /специф/i.test(`${file.nameRu ?? ""} ${file.originalName ?? ""}`) && typeof file.filePath === "string")
        .map((file) => ({ name: String(file.originalName ?? file.nameRu ?? "файл"), url: String(file.filePath) }));
      return {
        announceId: Number(row.id),
        number: String(row.numberAnno ?? ""),
        publishDate: String(row.publishDate ?? "").slice(0, 10),
        title: String(row.nameRu ?? ""),
        totalSum: typeof row.totalSum === "number" ? row.totalSum : row.totalSum ? Number(row.totalSum) : null,
        specFiles,
        otherFiles: files.length - specFiles.length
      };
    });
  }

  /** Кто входит в закупочные комиссии заказчика по его последним закупкам: ФИО, роль, число закупок. Телефонов реестр тут не даёт. */
  async commissionMembers(bin: string, limit = COMMISSION_TENDERS): Promise<CommissionSummary> {
    const page = await goszakupGraphqlPage<Row>(TENDER_COMMISSIONS, { bin, limit }, "TrdBuy", this.options);
    const people = new Map<string, { fullName: string; roles: Set<string>; tenders: number }>();
    let withCommission = 0;
    for (const tender of page.items) {
      const members = (Array.isArray(tender.Commission) ? (tender.Commission as Row[]) : []).filter((member) => Number(member.active) !== 0 && clean(member.fio));
      if (!members.length) continue;
      withCommission += 1;
      for (const member of members) {
        const fullName = clean(member.fio) as string;
        const key = fullName.toUpperCase();
        const person = people.get(key) ?? { fullName, roles: new Set<string>(), tenders: 0 };
        const role = nested(member.RefCommRoles);
        if (role) person.roles.add(role);
        person.tenders += 1;
        people.set(key, person);
      }
    }
    const members = [...people.values()]
      .map((person) => ({ fullName: person.fullName, roles: [...person.roles].sort((a, b) => roleRank(a) - roleRank(b)), tenders: person.tenders }))
      .sort((a, b) => roleRank(a.roles[0]) - roleRank(b.roles[0]) || b.tenders - a.tenders);
    return { tendersChecked: page.items.length, tendersWithCommission: withCommission, members };
  }

  /** ФИО и телефоны представителей заказчика из его последних договоров (реестр договоров публичный). */
  async contractContacts(bin: string, limit = 50): Promise<{ totalContracts: number; contacts: ContractContact[] }> {
    const page = await goszakupGraphqlPage<Row>(CONTRACT_CONTACTS, { bin, limit }, "Contract", this.options);
    const people = new Map<string, ContractContact & { phoneKeys: string[] }>();
    for (const row of page.items) {
      const fullName = clean(row.customerFio) ?? "";
      const signDate = String(row.signDate ?? "").slice(0, 10);
      const person = people.get(fullName.toLowerCase()) ?? { fullName, phones: [], contracts: 0, lastSignDate: "", phoneKeys: [] };
      person.contracts += 1;
      if (signDate > person.lastSignDate) person.lastSignDate = signDate;
      // В одном поле бывает несколько номеров через запятую; один номер пишут с кодом города и без него.
      for (const part of String(row.customerPhone ?? "").split(/[,;]/)) {
        const phone = part.trim();
        const key = phone.replace(/\D/g, "");
        if (key.length < MIN_CONTRACT_PHONE_DIGITS || person.phoneKeys.some((known) => samePhone(known, key))) continue;
        person.phoneKeys.push(key);
        person.phones.push(phone);
      }
      people.set(fullName.toLowerCase(), person);
    }
    const contacts = [...people.values()]
      .filter((person) => person.fullName || person.phones.length)
      .sort((a, b) => b.lastSignDate.localeCompare(a.lastSignDate) || b.contracts - a.contracts)
      .map(({ phoneKeys: _phoneKeys, ...person }) => ({ ...person, phones: person.phones.slice(0, MAX_CONTRACT_PHONES) }));
    return { totalContracts: page.totalCount ?? page.items.length, contacts };
  }

  /** Цены за единицу в договорах по коду ЕНС ТРУ: чем заказчики и поставщики закрывали похожие закупки. */
  async contractPrices(input: { enstruCode: string; year: number; limit?: number }): Promise<{ totalContracts: number; prices: ContractPrice[] }> {
    const page = await goszakupGraphqlPage<Row>(CONTRACT_PRICES, { code: input.enstruCode, year: input.year, limit: input.limit ?? 60 }, "Contract", this.options);
    const prices: ContractPrice[] = [];
    for (const row of page.items) {
      const units = Array.isArray(row.ContractUnits) ? (row.ContractUnits as Row[]) : [];
      for (const unit of units) {
        const codes = Array.isArray(unit.refEnstruCode) ? unit.refEnstruCode : [unit.refEnstruCode];
        const unitPriceNoVat = Number(unit.itemPrice);
        const withVat = Number(unit.itemPriceWnds);
        const unitPrice = Number.isFinite(withVat) && withVat > 0 ? withVat : unitPriceNoVat;
        if (!codes.includes(input.enstruCode) || !Number.isFinite(unitPrice) || unitPrice <= 0) continue;
        prices.push({
          contractId: Number(row.id),
          signDate: String(row.signDate ?? "").slice(0, 10),
          customerBin: String(row.customerBin ?? ""),
          customerName: String((row.Customer as Row | null)?.nameRu ?? ""),
          supplierBin: String(row.supplierBiin ?? ""),
          supplierName: String((row.Supplier as Row | null)?.nameRu ?? ""),
          unitPrice,
          unitPriceNoVat: Number.isFinite(unitPriceNoVat) && unitPriceNoVat > 0 ? unitPriceNoVat : unitPrice,
          quantity: Number(unit.quantity) || 0
        });
      }
    }
    return { totalContracts: page.totalCount ?? page.items.length, prices };
  }

  /** Последние договоры заказчика (по желанию только с нужным кодом ЕНС ТРУ) и кто чаще всего выигрывает. */
  async customerHistory(bin: string, options: { limit?: number; enstruCode?: string } = {}): Promise<CustomerHistory> {
    const limit = options.limit ?? 30;
    const page = options.enstruCode
      ? await goszakupGraphqlPage<Row>(CUSTOMER_HISTORY_BY_CODE, { bin, code: options.enstruCode, limit }, "Contract", this.options)
      : await goszakupGraphqlPage<Row>(CUSTOMER_HISTORY, { bin, limit }, "Contract", this.options);
    const contracts = page.items.map((row): HistoryContract => ({
      id: Number(row.id),
      signDate: String(row.signDate ?? "").slice(0, 10),
      sum: row.contractSum === null || row.contractSum === undefined ? null : Number(row.contractSum),
      title: String(row.trdBuyNameRu ?? ""),
      supplierBin: String(row.supplierBiin ?? ""),
      supplierName: String((row.Supplier as Row | null)?.nameRu ?? "")
    }));
    const suppliers = new Map<string, { bin: string; name: string; contracts: number }>();
    for (const contract of contracts) {
      if (!contract.supplierBin) continue;
      const entry = suppliers.get(contract.supplierBin) ?? { bin: contract.supplierBin, name: contract.supplierName, contracts: 0 };
      entry.contracts += 1;
      suppliers.set(contract.supplierBin, entry);
    }
    const topSuppliers = [...suppliers.values()].sort((a, b) => b.contracts - a.contracts).slice(0, 5);
    return { totalContracts: page.totalCount ?? contracts.length, contracts, topSuppliers };
  }

  /**
   * Коды ЕНС ТРУ, под которыми планы года называют товар (название берётся точно, как в плане: «Ноутбук»).
   * У одного товара бывает несколько кодов, чаще используемые идут первыми.
   */
  async enstruCodes(name: string, year?: number): Promise<{ totalPoints: number; codes: Array<{ code: string; points: number }> }> {
    const y = year ?? new Date(this.now() + ALMATY_OFFSET_MS).getUTCFullYear();
    const page = await goszakupGraphqlPage<Row>(PLAN_CODES_BY_NAME, { n: name, y: [y] }, "Plans", this.options);
    const counts = new Map<string, number>();
    for (const row of page.items) {
      const code = String(row.refEnstruCode ?? "").trim();
      if (/^\d{6}\.\d{3}\.\d{6}$/.test(code)) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return {
      totalPoints: page.totalCount ?? page.items.length,
      codes: [...counts].map(([code, points]) => ({ code, points })).sort((a, b) => b.points - a.points || a.code.localeCompare(b.code))
    };
  }

  /** Кто поставляет заказчику: поставщики последних договоров, больше всего договоров и крупнее сумма — выше. */
  async customerSuppliers(bin: string, options: { limit?: number; enstruCode?: string } = {}): Promise<CustomerSuppliers> {
    const limit = options.limit ?? 200;
    const page = options.enstruCode
      ? await goszakupGraphqlPage<Row>(CUSTOMER_HISTORY_BY_CODE, { bin, code: options.enstruCode, limit }, "Contract", this.options)
      : await goszakupGraphqlPage<Row>(CUSTOMER_HISTORY, { bin, limit }, "Contract", this.options);
    const suppliers = new Map<string, CustomerSupplier>();
    for (const row of page.items) {
      const supplierBin = String(row.supplierBiin ?? "").trim();
      if (!supplierBin) continue;
      const entry = suppliers.get(supplierBin) ?? { bin: supplierBin, name: String((row.Supplier as Row | null)?.nameRu ?? ""), contracts: 0, totalSum: 0, lastSignDate: "", subjects: [] };
      entry.contracts += 1;
      entry.totalSum += toNumberOrNull(row.contractSum) ?? 0;
      const signDate = String(row.signDate ?? "").slice(0, 10);
      if (signDate > entry.lastSignDate) entry.lastSignDate = signDate;
      const subject = String(row.trdBuyNameRu ?? "").trim();
      if (subject && entry.subjects.length < 3 && !entry.subjects.includes(subject)) entry.subjects.push(subject);
      suppliers.set(supplierBin, entry);
    }
    return {
      totalContracts: page.totalCount ?? page.items.length,
      analyzed: page.items.length,
      suppliers: [...suppliers.values()].sort((a, b) => b.contracts - a.contracts || b.totalSum - a.totalSum)
    };
  }

  /** Лот по номеру: из него берутся БИН заказчика, настоящие сроки и пункты плана (не из префикса номера). */
  async lotInfo(lotNumber: string): Promise<LotInfo | null> {
    const page = await goszakupGraphqlPage<Row>(LOT_BY_NUMBER, { lot: lotNumber }, "Lots", this.options);
    const row = page.items[0];
    if (!row) return null;
    const pointIds = (Array.isArray(row.pointList) ? row.pointList : []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
    const plans = pointIds.length ? await this.planPoints(pointIds) : [];
    return { ...toPlanLot(row), name: String(row.nameRu ?? ""), description: String(row.descriptionRu ?? ""), customerBin: String(row.customerBin ?? ""), customerName: String(row.customerNameRu ?? ""), pointIds, plans };
  }

  /** Много лотов сразу, не больше нескольких запросов параллельно; не прочитавшийся лот даёт null. Порядок как на входе. */
  async lotsInfo(lotNumbers: string[], concurrency = 6): Promise<Array<LotInfo | null>> {
    const results: Array<LotInfo | null> = new Array(lotNumbers.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < lotNumbers.length) {
        const index = next++;
        results[index] = await this.lotInfo(lotNumbers[index]).catch(() => null);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, lotNumbers.length) }, worker));
    return results;
  }

  /**
   * Статус и срок приёма заявок для списка лотов: один лёгкий запрос на лот, не больше нескольких сразу.
   * Лот, у которого срок уже вышел, больше не перепроверяется; идущий перечитывается не чаще раза в 10 минут.
   * Не прочитавшийся лот даёт null и в память не попадает. Порядок как на входе.
   */
  async lotDeadlines(lotNumbers: string[], concurrency = 8): Promise<Array<LotDeadline | null>> {
    const results: Array<LotDeadline | null> = new Array(lotNumbers.length).fill(null);
    const now = this.now();
    const almatyNow = new Date(now + ALMATY_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
    const pending: number[] = [];
    lotNumbers.forEach((lotNumber, index) => {
      const cached = this.deadlines.get(lotNumber);
      if (cached && (cached.final || now - cached.at < DEADLINE_TTL_MS)) results[index] = cached.value;
      else pending.push(index);
    });
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const index = pending[next++];
        const lotNumber = lotNumbers[index];
        try {
          const page = await goszakupGraphqlPage<Row>(LOT_DEADLINE, { lot: lotNumber }, "Lots", this.options);
          const row = page.items[0];
          if (!row) continue;
          const buy = (row.TrdBuy ?? {}) as Row;
          const value: LotDeadline = {
            lotNumber,
            lotStatus: nested(row.RefLotsStatus),
            applicationsFrom: dateTime(buy.startDate),
            applicationsUntil: dateTime(buy.endDate)
          };
          results[index] = value;
          this.deadlines.set(lotNumber, { value, at: now, final: value.applicationsUntil !== null && value.applicationsUntil < almatyNow });
        } catch {
          // не прочитался: остаётся null, в следующий раз спросим снова
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    return results;
  }

  private async planPoints(ids: number[]): Promise<PlanInfo[]> {
    const page = await goszakupGraphqlPage<Row>(PLANS_BY_IDS, { id: ids }, "Plans", this.options);
    return page.items.map(toPlanInfo);
  }

  /** Пункт плана и все закупки, объявленные по нему (повторные тоже), новые первыми. */
  async planStatus(planId: number): Promise<PlanStatus> {
    const planPage = await goszakupGraphqlPage<Row>(PLAN_BY_ID, { id: planId }, "Plans", this.options);
    const row = planPage.items[0];
    if (!row) return { plan: null, lots: [] };

    const lotPage = await goszakupGraphqlPage<Row>(LOTS_BY_POINT, { point: planId }, "Lots", this.options);
    const lots = lotPage.items.map(toPlanLot).sort((a, b) => b.announceId - a.announceId);
    return { plan: toPlanInfo(row), lots };
  }
}

function toCard(row: Row): CustomerCard {
  return {
    bin: String(row.bin ?? ""),
    name: String(row.nameRu ?? ""),
    email: clean(row.email),
    phone: clean(row.phone),
    website: clean(row.website),
    parentOrg: clean(row.parentNameRu),
    administrators: toAdministrators(row.Admins),
    extraPhones: toExtraPhones(row),
    head: toHead(row.Employees)
  };
}

const MIN_PHONE_DIGITS = 6;

/** Один и тот же номер пишут с кодом города и без него: совпадают цифры или хвост одного номера равен другому. */
function samePhone(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_PHONE_DIGITS && long.endsWith(short);
}

function toExtraPhones(row: Row): string[] {
  const seen: string[] = [];
  const mainDigits = String(row.phone ?? "").replace(/\D/g, "");
  if (mainDigits) seen.push(mainDigits);
  const extra: string[] = [];
  for (const address of Array.isArray(row.Address) ? (row.Address as Row[]) : []) {
    for (const part of String(address.phone ?? "").split(/[,;]/)) {
      const phone = part.trim();
      const digits = phone.replace(/\D/g, "");
      if (digits.length < MIN_PHONE_DIGITS || seen.some((known) => samePhone(known, digits))) continue;
      seen.push(digits);
      extra.push(phone);
    }
  }
  return extra.slice(0, MAX_EXTRA_PHONES);
}

function toHead(value: unknown): string | null {
  const heads = (Array.isArray(value) ? (value as Row[]) : []).filter((user) => Number(user.role) === 1 && Number(user.disabled) !== 1);
  return clean(heads[0]?.fio);
}

function toAdministrators(value: unknown): CustomerAdministrator[] {
  if (!Array.isArray(value)) return [];
  return (value as Row[]).flatMap((admin) => {
    const name = clean(admin.nameRu);
    return name ? [{ bin: clean(admin.bin), name, budget: clean(admin.budgetRu), since: clean(admin.startDate)?.slice(0, 10) ?? null }] : [];
  });
}

function roleRank(role: string | undefined): number {
  if (/председатель/i.test(role ?? "") && !/заместитель/i.test(role ?? "")) return 0;
  if (/заместитель/i.test(role ?? "")) return 1;
  if (/секретарь/i.test(role ?? "")) return 2;
  return 3;
}

function clean(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Название из вложенного справочника `{ nameRu }`. */
function nested(value: unknown): string | null {
  return clean((value as Row | null | undefined)?.nameRu);
}

/** `2026-10-15 17:01:48` → `2026-10-15 17:01`. */
function dateTime(value: unknown): string | null {
  const text = clean(value);
  return text ? text.slice(0, 16) : null;
}

/** Разброс цен за единицу по выборке договоров. */
export function summarizePrices(prices: ContractPrice[]): PriceSummary | null {
  if (!prices.length) return null;
  const sorted = prices.map((price) => price.unitPrice).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { count: sorted.length, min: sorted[0], median, max: sorted[sorted.length - 1] };
}

function toPlanInfo(row: Row): PlanInfo {
  return {
    id: Number(row.id),
    name: String(row.nameRu ?? ""),
    year: toNumberOrNull(row.plnPointYear),
    month: nested(row.RefMonths),
    status: nested(row.RefPlnPointStatus),
    tradeMethod: nested(row.RefTradeMethods),
    amount: toNumberOrNull(row.amount),
    count: toNumberOrNull(row.count),
    unitPrice: toNumberOrNull(row.price),
    enstruCode: clean(row.refEnstruCode)
  };
}

function toPlanLot(lot: Row): PlanLot {
  const buy = (lot.TrdBuy ?? {}) as Row;
  const files = Array.isArray(buy.Files) ? (buy.Files as Row[]) : [];
  const isSpec = (file: Row) => /специф/i.test(`${file.nameRu ?? ""} ${file.originalName ?? ""}`) && typeof file.filePath === "string";
  return {
    lotNumber: String(lot.lotNumber ?? ""),
    lotStatus: nested(lot.RefLotsStatus),
    amount: toNumberOrNull(lot.amount),
    count: toNumberOrNull(lot.count),
    announceId: Number(lot.trdBuyId ?? buy.id),
    announceNumber: String(lot.trdBuyNumberAnno ?? ""),
    buyStatus: nested(buy.RefBuyStatus),
    applicationsFrom: dateTime(buy.startDate),
    applicationsUntil: dateTime(buy.endDate),
    specFiles: files.filter(isSpec).map((file) => ({ name: String(file.originalName ?? file.nameRu ?? "файл"), url: String(file.filePath) })),
    otherFiles: files.filter((file) => !isSpec(file)).map((file) => String(file.nameRu ?? file.originalName ?? "файл"))
  };
}
