/**
 * Инструменты помощника. Все только читают: сделки из Bitrix, карточки организаций и закупки из API портала,
 * страницы закупок и технические спецификации. Каждый возвращает короткий текст, который читает модель.
 */

import type { AgentTool } from "./agent.js";
import type { CrmCustomerHistory, DealCompany, DealSummary, MyDealsRequest, MyDeal } from "./crmReader.js";
import { summarizePrices, type CommissionSummary, type ContractContact, type ContractPrice, type CustomerCard, type CustomerHistory, type CustomerSuppliers, type LotDeadline, type LotInfo, type PlanStatus, type TenderSummary } from "./goszakupApi.js";
import type { AnnouncementContacts, SpecFile } from "./portalReaders.js";

export interface ToolDeps {
  crm: {
    getDealSummary(id: number): Promise<DealSummary>;
    findDeals(text: string, options?: { limit?: number; userId?: number }): Promise<{ total: number; deals: Array<{ id: number; title: string }> }>;
    findCompanies(name: string, limit?: number): Promise<DealCompany[]>;
    customerInCrm(target: { bin?: string; companyId?: number }): Promise<CrmCustomerHistory | null>;
    listMyDeals(request: MyDealsRequest): Promise<{ total: number; deals: MyDeal[] }>;
  };
  goszakup: {
    customerCard(bin: string): Promise<CustomerCard | null>;
    findCustomers(name: string, limit?: number): Promise<CustomerCard[]>;
    recentTenders(bin: string, limit?: number): Promise<TenderSummary[]>;
    contractContacts(bin: string, limit?: number): Promise<{ totalContracts: number; contacts: ContractContact[] }>;
    commissionMembers(bin: string): Promise<CommissionSummary>;
    contractPrices(input: { enstruCode: string; year: number; limit?: number }): Promise<{ totalContracts: number; prices: ContractPrice[] }>;
    customerHistory(bin: string, options?: { limit?: number; enstruCode?: string }): Promise<CustomerHistory>;
    customerSuppliers(bin: string, options?: { limit?: number; enstruCode?: string }): Promise<CustomerSuppliers>;
    enstruCodes(name: string, year?: number): Promise<{ totalPoints: number; codes: Array<{ code: string; points: number }> }>;
    planStatus(planId: number): Promise<PlanStatus>;
    lotInfo(lotNumber: string): Promise<LotInfo | null>;
    lotsInfo(lotNumbers: string[]): Promise<Array<LotInfo | null>>;
    lotDeadlines(lotNumbers: string[]): Promise<Array<LotDeadline | null>>;
  };
  portal: {
    fetchAnnouncementContacts(announceId: number): Promise<AnnouncementContacts>;
    loadSpecFile(url: string): Promise<SpecFile>;
  };
  /** PDF уходит в Claude отдельным запросом, а в основной диалог возвращается только выжимка. */
  extractFromPdf(base64: string, question: string): Promise<string>;
}

/** Контакты из реестра подгружаем только первым поставщикам: каждая карточка — отдельный запрос. */
const SUPPLIER_CONTACTS = 5;

/** Все открытые лоты менеджера: срок надо смотреть у каждого, старые сделки тоже бывают живыми. Потолок нужен только от зацикливания. */
const SCAN_ALL = 2000;

const SPEC_QUESTION =
  "Из этой технической спецификации выпиши: 1) все контакты (ФИО, должность, телефон, e-mail, адрес); " +
  "2) что закупается (товар, марка или модель, ключевые характеристики); 3) количество и сроки поставки; " +
  "4) особые требования к поставщику. Если чего-то нет в документе, так и напиши, ничего не выдумывай.";

/** Кто спрашивает и который сейчас час: нужно для «моих сделок» и сроков; в тестах время подменяется. */
export interface ToolContext {
  userId?: number;
  now?: () => Date;
}

const ENSTRU_PATTERN = /^\d{6}\.\d{3}\.\d{6}$/;
const ALMATY_OFFSET_MS = 5 * 3_600_000;

export function buildTools(deps: ToolDeps, context: ToolContext = {}): AgentTool[] {
  const today = () => almatyDate((context.now ?? (() => new Date()))());

  /**
   * Одна и та же организация в Bitrix бывает заведена дважды: роботом с БИН и вручную без него (у второй часто выигранные сделки).
   * Карточка без БИН присоединяется, только если её название от первой кавычки и до конца совпадает с названием в реестре.
   * Остальные похожие по названию возвращаются списком: выбирает модель.
   */
  const crmTwins = async (binValue: string): Promise<{ twinIds: number[]; similar: DealCompany[] }> => {
    const card = await deps.goszakup.customerCard(binValue).catch(() => null);
    if (!card?.name) return { twinIds: [], similar: [] };
    const core = /[«"“]([^«»"”]{5,}?)[»"”]/.exec(card.name)?.[1]?.trim() ?? card.name;
    const withoutBin = (await deps.crm.findCompanies(core, 8).catch(() => [])).filter((company) => company.bin === null);
    const key = orgKey(card.name);
    const twinIds = key ? withoutBin.filter((company) => orgKey(company.title) === key).map((company) => company.id) : [];
    return { twinIds, similar: withoutBin.filter((company) => !twinIds.includes(company.id)) };
  };

  return [
    {
      name: "get_deal",
      description: "Карточка сделки Bitrix24 по номеру: название, стадия, сумма и заполненные поля (товар, количество, цена, заказчик, БИН и т.д.). Начинай с него, когда спрашивают про сделку.",
      input_schema: { type: "object", properties: { deal_id: { type: "integer", description: "Номер сделки в Bitrix24" } }, required: ["deal_id"] },
      run: async (input) => formatDeal(await deps.crm.getDealSummary(positiveInt(input, "deal_id")), context.userId)
    },
    {
      name: "find_deals",
      description:
        "Поиск сделок по части названия: номер лота (например 83132229-ЗЦП1), номер пункта плана, название заказчика или товара. Возвращает общее число найденных и первые сделки. Для вопросов «мои сделки по …» ставь mine=true: тогда ищет только среди открытых сделок спрашивающего; без mine ищет среди сделок всех менеджеров.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Часть названия сделки" },
          mine: { type: "boolean", description: "Только открытые сделки того, кто спрашивает" },
          limit: { type: "integer", description: "Сколько сделок показать, от 1 до 20, по умолчанию 10" }
        },
        required: ["query"]
      },
      run: async (input) => {
        const mine = record(input).mine === true;
        if (mine && !context.userId) throw new Error("Не знаю, кто спрашивает, поэтому не могу показать чьи сделки");
        const limit = Math.min(20, Math.max(1, optionalInt(input, "limit") ?? 10));
        const found = await deps.crm.findDeals(text(input, "query"), { limit, ...(mine ? { userId: context.userId } : {}) });
        if (!found.deals.length) return mine ? "У вас нет открытых сделок с таким названием" : "Сделок с таким названием не найдено";
        const scope = mine ? " (ваши открытые)" : "";
        const shown = found.deals.length < found.total ? `, показаны первые ${found.deals.length}` : "";
        return [`Найдено сделок: ${found.total}${scope}${shown}:`, ...found.deals.map((row) => `#${row.id} ${row.title}`)].join("\n");
      }
    },
    {
      name: "customer_card",
      description: "Карточка организации-заказчика из реестра госзакупок по БИН (12 цифр): название, e-mail, телефон, сайт. Это официальные контакты организации.",
      input_schema: { type: "object", properties: { bin: { type: "string", description: "БИН, 12 цифр" } }, required: ["bin"] },
      run: async (input) => {
        const card = await deps.goszakup.customerCard(bin(input));
        return card ? formatCard(card) : "Организация с таким БИН в реестре не найдена";
      }
    },
    {
      name: "find_customer",
      description:
        "Находит БИН организации по названию. Сначала смотрит реестр госзакупок (там нужно почти полное название), если не нашлось, то компании в Bitrix (хватит части названия, например «Жасыл даму»). Нужен, когда в сделке нет БИН.",
      input_schema: { type: "object", properties: { name: { type: "string", description: "Название организации или его часть" } }, required: ["name"] },
      run: async (input) => {
        const name = text(input, "name");
        const cards = await deps.goszakup.findCustomers(name, 5);
        if (cards.length) return cards.map(formatCard).join("\n---\n");
        const companies = await deps.crm.findCompanies(name, 5);
        if (!companies.length) return "Организации с таким названием не найдено ни в реестре, ни в Bitrix";
        return [
          "В реестре по такому названию не нашлось, но в Bitrix есть компании:",
          ...companies.map((company) => `- ${company.title}: ${company.bin ? `БИН ${company.bin}` : "БИН в карточке не указан"} (компания Bitrix ${company.id})`),
          "Реестр ищет по названию только буква в букву, поэтому пустой ответ не значит, что организации нет в реестре. Проверь её по БИН через customer_card."
        ].join("\n");
      }
    },
    {
      name: "recent_tenders",
      description: "Свежие закупки организации (по БИН организатора) с номерами объявлений и ссылками на файлы технической спецификации. Ссылки передавай в read_spec.",
      input_schema: {
        type: "object",
        properties: { bin: { type: "string", description: "БИН, 12 цифр" }, limit: { type: "integer", description: "Сколько закупок показать, от 1 до 20, по умолчанию 5" } },
        required: ["bin"]
      },
      run: async (input) => {
        const limit = Math.min(20, Math.max(1, optionalInt(input, "limit") ?? 5));
        const tenders = await deps.goszakup.recentTenders(bin(input), limit);
        return tenders.length ? tenders.map(formatTender).join("\n") : "Закупок у этой организации не найдено";
      }
    },
    {
      name: "announcement_contacts",
      description: "Страница закупки на портале: заказчик (БИН, адрес) и контактное лицо организатора (ФИО, должность, e-mail). Телефона на странице нет.",
      input_schema: { type: "object", properties: { announce_id: { type: "integer", description: "Номер объявления" } }, required: ["announce_id"] },
      run: async (input) => formatAnnouncement(await deps.portal.fetchAnnouncementContacts(positiveInt(input, "announce_id")))
    },
    {
      name: "contract_contacts",
      description:
        "ФИО и телефоны представителей заказчика из его последних договоров в реестре госзакупок (по БИН). Именно здесь бывают телефоны, которых нет в карточке организации и на страницах закупок.",
      input_schema: { type: "object", properties: { bin: { type: "string", description: "БИН, 12 цифр" } }, required: ["bin"] },
      run: async (input) => {
        const result = await deps.goszakup.contractContacts(bin(input), 50);
        if (!result.contacts.length) return "В договорах заказчика контактов не нашлось";
        const lines = result.contacts.map(
          (person) =>
            `- ${person.fullName ? properName(person.fullName) : "ФИО не указано"}: ${person.phones.length ? person.phones.join("; ") : "телефон не указан"}; в договорах ${person.contracts}, последний ${person.lastSignDate}`
        );
        return [`Всего договоров у заказчика: ${result.totalContracts} (разобраны последние 50). Представители заказчика в договорах:`, ...lines].join("\n");
      }
    },
    {
      name: "customer_in_crm",
      description:
        "Что про заказчика уже есть в нашем Bitrix: компания, контакты с телефонами и почтой, прошлые сделки (выиграны, проиграны, в работе, кто вёл) и недавние звонки с номерами. Вызывай первым, когда нужны контакты заказчика или история работы с ним. Параметр: БИН (12 цифр) или номер компании в Bitrix.",
      input_schema: {
        type: "object",
        properties: { bin: { type: "string", description: "БИН, 12 цифр" }, company_id: { type: "integer", description: "Номер компании в Bitrix, если БИН неизвестен" } }
      },
      run: async (input) => {
        const companyId = optionalInt(input, "company_id");
        const hasBin = record(input).bin !== undefined && record(input).bin !== null && record(input).bin !== "";
        if (!companyId && !hasBin) throw new Error("Нужен параметр bin (БИН, 12 цифр) или company_id");
        const binValue = companyId ? null : bin(input);
        const { twinIds, similar } = binValue ? await crmTwins(binValue) : { twinIds: [], similar: [] };
        const history = await deps.crm.customerInCrm(companyId ? { companyId } : { bin: binValue as string, ...(twinIds.length ? { alsoCompanyIds: twinIds } : {}) });
        if (history) return formatCrmHistory(history, context.userId);
        if (!similar.length) return "Компании с таким БИН в Bitrix нет: с этим заказчиком мы, скорее всего, ещё не работали.";
        return [
          "Компании с таким БИН в Bitrix нет, но есть компании без БИН с похожим названием. Если подходит по полному названию, вызови customer_in_crm с company_id:",
          ...similar.map((company) => `- ${company.title} (компания в Bitrix ${company.id}, БИН в карточке не указан)`)
        ].join("\n");
      }
    },
    {
      name: "commission_members",
      description:
        "Кто входит в закупочные комиссии заказчика по его последним закупкам (по БИН): председатель, секретарь, члены, сколько закупок. Это те, кто решает по закупке. В реестре только ФИО и роли, без телефонов: телефоны ищи в contract_contacts.",
      input_schema: { type: "object", properties: { bin: { type: "string", description: "БИН, 12 цифр" } }, required: ["bin"] },
      run: async (input) => {
        const result = await deps.goszakup.commissionMembers(bin(input));
        if (!result.members.length) return `Состав комиссии в реестре не указан (проверено закупок: ${result.tendersChecked}). У закупок через электронный магазин и у части прямых закупок комиссии нет.`;
        const lines = result.members.map((member) => `- ${properName(member.fullName)}: ${member.roles.join(", ") || "роль не указана"}, в ${member.tenders} ${plural(member.tenders)}`);
        return [
          `Проверено закупок: ${result.tendersChecked}, комиссия указана в ${result.tendersWithCommission}. В реестре только ФИО и роли (телефонов нет):`,
          ...lines
        ].join("\n");
      }
    },
    {
      name: "price_benchmark",
      description:
        "Цены за единицу в заключённых договорах по коду ЕНС ТРУ (например 262011.100.000001 для ноутбуков): минимум, медиана, максимум и последние договоры с заказчиком и победителем. Код берётся из сделки (поле «Код ЕНС ТРУ») или из plan_status. Для сравнения с ценой плана.",
      input_schema: {
        type: "object",
        properties: {
          enstru_code: { type: "string", description: "Код ЕНС ТРУ вида 262011.100.000001" },
          year: { type: "integer", description: "Год договоров, по умолчанию текущий" }
        },
        required: ["enstru_code"]
      },
      run: async (input) => {
        const code = enstruCode(input);
        const year = optionalInt(input, "year") ?? Number(today().slice(0, 4));
        const result = await deps.goszakup.contractPrices({ enstruCode: code, year, limit: 60 });
        const summary = summarizePrices(result.prices);
        if (!summary) return `Договоров с кодом ${code} за ${year} год не найдено`;
        const examples = result.prices.slice(0, 8).map(
          (price) =>
            `- ${price.signDate}: заказчик ${price.customerName || price.customerBin}; победитель ${price.supplierName || price.supplierBin}; ${money(price.unitPrice)} за единицу с НДС × ${price.quantity}`
        );
        return [
          `Код ЕНС ТРУ ${code}, договоры ${year} года: всего ${result.totalContracts}, в выборке последние ${result.prices.length} цен.`,
          `Цена за единицу с НДС: минимум ${money(summary.min)}, медиана ${money(summary.median)}, максимум ${money(summary.max)}.`,
          "Один код объединяет разные модели и комплектации, поэтому сверяй цену с характеристиками из ТЗ.",
          "Последние договоры:",
          ...examples
        ].join("\n");
      }
    },
    {
      name: "customer_history",
      description:
        "История закупок заказчика по реестру договоров (по БИН): сколько всего договоров, последние договоры с суммами и поставщиками, кто выигрывает чаще всего. С кодом ЕНС ТРУ покажет только договоры на такую технику.",
      input_schema: {
        type: "object",
        properties: {
          bin: { type: "string", description: "БИН, 12 цифр" },
          enstru_code: { type: "string", description: "Необязательно: код ЕНС ТРУ, чтобы видеть только такую технику" }
        },
        required: ["bin"]
      },
      run: async (input) => {
        const code = record(input).enstru_code === undefined ? undefined : enstruCode(input);
        const history = await deps.goszakup.customerHistory(bin(input), { limit: 30, enstruCode: code });
        if (!history.contracts.length) return code ? `Договоров заказчика с кодом ${code} не найдено` : "Договоров у заказчика не найдено";
        const lines = history.contracts
          .slice(0, 15)
          .map((contract) => `- ${contract.signDate}: ${contract.title || "без названия закупки"}; ${contract.sum === null ? "сумма не указана" : money(contract.sum)}; поставщик ${contract.supplierName || contract.supplierBin}`);
        const winners = history.topSuppliers.map((supplier) => `${supplier.name || supplier.bin} (${supplier.contracts})`).join("; ");
        return [
          `${code ? `Договоры с кодом ${code}` : "Договоры заказчика"}: всего ${history.totalContracts}, ниже последние ${Math.min(15, history.contracts.length)}.`,
          ...lines,
          `Чаще всего выигрывают в последних ${history.contracts.length}: ${winners || "нет данных"}`
        ].join("\n");
      }
    },
    {
      name: "customer_suppliers",
      description:
        "Кто поставляет заказчику (по БИН): поставщики из его последних 200 договоров по числу договоров и сумме, с БИН, тем, что поставляли, и контактами из реестра у первых пяти. Для вопросов «кто у них поставщики», «кого можно привлечь в агенты или партнёры». С кодом ЕНС ТРУ покажет поставщиков только такой техники.",
      input_schema: {
        type: "object",
        properties: {
          bin: { type: "string", description: "БИН заказчика, 12 цифр" },
          enstru_code: { type: "string", description: "Необязательно: код ЕНС ТРУ, чтобы видеть поставщиков только такой техники" },
          limit: { type: "integer", description: "Сколько поставщиков показать, от 1 до 20, по умолчанию 10" }
        },
        required: ["bin"]
      },
      run: async (input) => {
        const code = record(input).enstru_code === undefined ? undefined : enstruCode(input);
        const customerBin = bin(input);
        const limit = Math.min(optionalInt(input, "limit") ?? 10, 20);
        const result = await deps.goszakup.customerSuppliers(customerBin, { enstruCode: code });
        if (!result.suppliers.length) return code ? `Договоров заказчика с кодом ${code} не найдено` : "Договоров у заказчика не найдено";
        const shown = result.suppliers.slice(0, limit);
        const cards = await Promise.all(shown.slice(0, SUPPLIER_CONTACTS).map((supplier) => deps.goszakup.customerCard(supplier.bin).catch(() => undefined)));
        const lines = shown.map((supplier, index) => {
          const head = `${index + 1}. ${supplier.name || "название не указано"} (БИН ${supplier.bin}): договоров ${supplier.contracts}, на сумму ${money(supplier.totalSum)}, последний ${supplier.lastSignDate}${supplier.subjects.length ? `; поставляли: ${supplier.subjects.join("; ")}` : ""}`;
          if (index >= SUPPLIER_CONTACTS) return head;
          const card = cards[index];
          if (card === undefined) return `${head}\n   контакты не удалось прочитать`;
          if (card === null) return `${head}\n   карточки организации в реестре нет`;
          return `${head}\n   e-mail: ${card.email ?? "не указан"}; телефон: ${card.phone ?? "не указан"}; сайт: ${card.website ?? "не указан"}`;
        });
        return [
          `Поставщики заказчика (БИН ${customerBin})${code ? ` с кодом ${code}` : ""} по последним ${result.analyzed} договорам из ${result.totalContracts}; сначала те, у кого больше договоров, затем крупнее сумма:`,
          ...lines
        ].join("\n");
      }
    },
    {
      name: "enstru_codes",
      description:
        "Коды ЕНС ТРУ по названию товара, как его называют планы закупок: «Ноутбук», «Компьютер», «Монитор», «Принтер», «Сервер». Название нужно точное, в единственном числе. Нужен, когда спрашивают цену товара, а кода в сделке нет: дальше для самых частых кодов вызывай price_benchmark.",
      input_schema: { type: "object", properties: { name: { type: "string", description: "Название товара в единственном числе с заглавной буквы" } }, required: ["name"] },
      run: async (input) => {
        const name = text(input, "name");
        const year = Number(almatyDate((context.now ?? (() => new Date()))()).slice(0, 4));
        const result = await deps.goszakup.enstruCodes(name, year);
        if (!result.codes.length) return `Для названия «${name}» в планах ${year} года ничего не найдено. Назови товар так, как его пишут в плане закупок: в единственном числе, с заглавной буквы («Ноутбук», «Компьютер», «Монитор»).`;
        return [
          `Коды ЕНС ТРУ для «${name}» в планах ${year} года (пунктов плана с таким названием ${result.totalPoints}); чаще используемые первыми:`,
          ...result.codes.map((entry) => `- ${entry.code}: пунктов плана ${entry.points}`),
          "Один код означает один вид товара. Для цены бери самые частые и вызывай price_benchmark по каждому, назвав в ответе, какие коды использовал."
        ].join("\n");
      }
    },
    {
      name: "lot_info",
      description:
        "Лот по его номеру (например 83132229-ЗЦП1): заказчик с БИН, статус, настоящий срок приёма заявок, объявление, ссылки на ТЗ и актуальные пункты плана с кодом ЕНС ТРУ. Начинай с него для сделки по лоту: из него берётся БИН заказчика для customer_card, contract_contacts, customer_history.",
      input_schema: { type: "object", properties: { lot_number: { type: "string", description: "Номер лота вида 83132229-ЗЦП1" } }, required: ["lot_number"] },
      run: async (input) => {
        const number = text(input, "lot_number");
        const lot = await deps.goszakup.lotInfo(number);
        if (!lot) return `Лот ${number} в реестре не найден`;
        const specs = lot.specFiles.length ? lot.specFiles.map((file) => `${file.name} ${file.url}`).join("; ") : "файла ТЗ нет";
        const lines = [
          `Лот ${lot.lotNumber}: ${lot.name}${lot.description ? `, ${lot.description}` : ""}; количество ${lot.count ?? "?"}, сумма ${lot.amount === null ? "?" : money(lot.amount)}`,
          `Заказчик: ${lot.customerName || "?"}, БИН ${lot.customerBin || "не указан"}`,
          `Статус лота: ${lot.lotStatus ?? "?"}; закупка ${lot.announceNumber} (объявление ${lot.announceId}): ${lot.buyStatus ?? "?"}; приём заявок ${lot.applicationsFrom ?? "?"} — ${lot.applicationsUntil ?? "?"} (время Алматы)${lot.applicationsUntil ? `; ${timeLeft(almatyDateTime((context.now ?? (() => new Date()))()), lot.applicationsUntil)}` : ""}`,
          `ТЗ: ${specs}`
        ];
        if (lot.plans.length) {
          lines.push("Пункты плана лота (номер лота может начинаться с номера старого пункта, верить нужно этому списку):");
          for (const plan of lot.plans) {
            lines.push(`- пункт ${plan.id}: ${plan.name}; статус ${plan.status ?? "?"}; ${plan.month ?? "?"} ${plan.year ?? ""}; цена за единицу ${plan.unitPrice === null ? "?" : money(plan.unitPrice)}; код ЕНС ТРУ ${plan.enstruCode ?? "?"}`);
          }
        } else {
          lines.push("Пункты плана лота в реестре не указаны");
        }
        return lines.join("\n");
      }
    },
    {
      name: "plan_status",
      description:
        "Что стало с пунктом плана закупок: статус плана, месяц, способ закупки и все закупки, объявленные по нему (в том числе несостоявшиеся и повторные) с датами приёма заявок и ссылками на ТЗ. Принимает только номер пункта плана (поле «ID Плана» у сделки плана). Для сделки по лоту используй lot_info: номер лота не равен номеру пункта плана.",
      input_schema: {
        type: "object",
        properties: { plan_id: { type: "string", description: "Номер пункта плана, только цифры" } },
        required: ["plan_id"]
      },
      run: async (input) => {
        const raw = String(record(input).plan_id ?? "").trim();
        if (!/^\d+$/.test(raw)) throw new Error("plan_id должен состоять только из цифр. Если это номер лота (например 88029122-ЗЦП1), вызови lot_info");
        const planId = Number(raw);
        const status = await deps.goszakup.planStatus(planId);
        if (!status.plan) return `Пункт плана ${planId} в реестре не найден`;
        const plan = status.plan;
        const head = [
          `Пункт плана ${plan.id}: ${plan.name}; статус: ${plan.status ?? "?"}; ${plan.year ?? "?"} год, месяц: ${plan.month ?? "?"}; способ: ${plan.tradeMethod ?? "?"}`,
          `Количество ${plan.count ?? "?"}, цена за единицу ${plan.unitPrice === null ? "?" : money(plan.unitPrice)}, сумма ${plan.amount === null ? "?" : money(plan.amount)}; код ЕНС ТРУ ${plan.enstruCode ?? "?"}`
        ];
        if (!status.lots.length) return [...head, "По этому пункту закупка пока не объявлена."].join("\n");
        const lots = status.lots.map((lot) => {
          const specs = lot.specFiles.length ? lot.specFiles.map((file) => `${file.name} ${file.url}`).join("; ") : "файла ТЗ нет";
          const others = lot.otherFiles.length ? ` Другие файлы: ${lot.otherFiles.join(", ")}.` : "";
          return `- лот ${lot.lotNumber}, объявление ${lot.announceNumber}: ${lot.lotStatus ?? "?"} (закупка: ${lot.buyStatus ?? "?"}); приём заявок ${lot.applicationsFrom ?? "?"} — ${lot.applicationsUntil ?? "?"}. ТЗ: ${specs}.${others}`;
        });
        return [...head, `Закупки по пункту (новые первыми): ${status.lots.length}`, ...lots].join("\n");
      }
    },
    {
      name: "my_deals",
      description:
        "Открытые сделки менеджера, который сейчас пишет в чат. sort=deadline (по умолчанию) показывает лоты, по которым приём заявок ещё идёт, с настоящим сроком из реестра госзакупок, ближайшие первыми: для вопросов «что горит», «какие сроки». sort=recent показывает недавно изменённые сделки со статусом закупки из реестра: для «что у меня в работе». Срок в самой сделке Bitrix не используется: он не отражает реальный срок закупки.",
      input_schema: {
        type: "object",
        properties: {
          sort: { type: "string", enum: ["deadline", "recent"], description: "По умолчанию deadline" },
          limit: { type: "integer", description: "Сколько сделок показать, от 1 до 20, по умолчанию 10" }
        }
      },
      run: async (input) => {
        if (!context.userId) throw new Error("Не знаю, кто спрашивает, поэтому не могу показать чьи сделки");
        const sort = record(input).sort === "recent" ? "recent" : "deadline";
        const limit = Math.min(20, Math.max(1, optionalInt(input, "limit") ?? 10));
        const nowAlmaty = almatyDateTime((context.now ?? (() => new Date()))());
        const todayDate = nowAlmaty.slice(0, 10);

        if (sort === "recent") {
          const { total, deals } = await deps.crm.listMyDeals({ userId: context.userId, scope: "all", order: "recent", limit });
          const lots = await deps.goszakup.lotsInfo(deals.flatMap((deal) => (deal.lotNumber ? [deal.lotNumber] : [])));
          let next = 0;
          const lines = deals.map((deal) => {
            const info = deal.lotNumber ? lots[next++] : null;
            const tender = info ? `; закупка: ${info.lotStatus ?? "?"}, приём заявок до ${info.applicationsUntil ?? "?"}` : "";
            return `- #${deal.id} [${deal.stage}] ${deal.title}; ${deal.amount === null ? "сумма не указана" : money(deal.amount)}${tender}`;
          });
          return [`Открытых сделок у вас: ${total}. Недавно изменённые:`, ...lines].join("\n");
        }

        const { total, deals } = await deps.crm.listMyDeals({ userId: context.userId, scope: "lots", order: "newest", limit: SCAN_ALL });
        const infos = await deps.goszakup.lotDeadlines(deals.map((deal) => deal.lotNumber ?? ""));
        const live: Array<{ deal: (typeof deals)[number]; info: LotDeadline }> = [];
        let unchecked = 0;
        deals.forEach((deal, index) => {
          const info = infos[index];
          if (!info) unchecked += 1;
          else if ((info.lotStatus ?? "").startsWith("Опубликован") && info.applicationsUntil && info.applicationsUntil > nowAlmaty) live.push({ deal, info });
        });
        live.sort((a, b) => String(a.info.applicationsUntil).localeCompare(String(b.info.applicationsUntil)));
        const head = `Открытых сделок у вас: ${total}. Проверено в реестре ${deals.length} открытых лотов${unchecked ? `, не удалось проверить: ${unchecked}` : ""}. Приём заявок ещё идёт у ${live.length}${live.length > limit ? `, показаны ближайшие ${limit} из ${live.length}` : ""}:`;
        if (!live.length) return head.replace(/ещё идёт у 0:$/, "ещё идёт ни у одного.");
        const lines = live.slice(0, limit).map(({ deal, info }) => {
          const until = String(info.applicationsUntil);
          return `- #${deal.id} [${deal.stage}] ${deal.title}; ${deal.amount === null ? "сумма не указана" : money(deal.amount)}; приём заявок до ${until} (${daysLeft(todayDate, until.slice(0, 10))})`;
        });
        return [head, ...lines].join("\n");
      }
    },
    {
      name: "read_spec",
      description: "Читает файл технической спецификации по ссылке из recent_tenders (PDF или Word) и выписывает контакты, товар, количество, сроки и требования к поставщику.",
      input_schema: { type: "object", properties: { url: { type: "string", description: "Ссылка на файл из recent_tenders" } }, required: ["url"] },
      run: async (input) => {
        const file = await deps.portal.loadSpecFile(text(input, "url"));
        if (file.kind === "docx") return `Текст документа Word:\n${file.text}`;
        if (file.kind === "pdf") return `Выжимка из PDF:\n${await deps.extractFromPdf(file.base64, SPEC_QUESTION)}`;
        return `Файл не удалось прочитать: ${file.note}`;
      }
    }
  ];
}

function formatDeal(deal: DealSummary, askerId: number | undefined): string {
  const kind = deal.kind === "plan" ? "пункт плана закупок" : deal.kind === "lot" ? "лот" : "другое";
  const company = deal.company
    ? `Заказчик (компания в CRM #${deal.company.id}): ${deal.company.title || "без названия"}, БИН ${deal.company.bin ?? "в CRM не указан, ищи через find_customer по названию"}`
    : `компания в CRM: ${deal.companyId ?? "нет"}`;
  const owner =
    deal.assignedById === null
      ? "не назначен"
      : deal.assignedById === askerId
        ? "вы"
        : `сотрудник с номером ${deal.assignedById}, не вы`;
  const head = [`Сделка #${deal.id}: ${deal.title}`, `Тип: ${kind}; стадия: ${deal.stage || deal.stageId}; сумма: ${deal.amount ?? "не указана"}`, `Ответственный: ${owner}`, company];
  return [...head, "Поля:", ...deal.fields.map((field) => `- ${field.label}: ${field.value}`)].join("\n");
}

/** Реестр пишет ФИО заглавными; в таком виде модель переписывает буквы по-своему, поэтому отдаём обычное написание. */
function properName(name: string): string {
  const trimmed = name.trim();
  if (trimmed !== trimmed.toUpperCase() || trimmed === trimmed.toLowerCase()) return trimmed;
  return trimmed.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_match, separator: string, letter: string) => separator + letter.toUpperCase());
}

/** Сколько осталось до срока; обе даты по Алматы, `YYYY-MM-DD HH:mm`. Считает код, а не модель. */
function timeLeft(nowAlmaty: string, until: string): string {
  const minutes = Math.round((Date.parse(`${until.replace(" ", "T")}:00Z`) - Date.parse(`${nowAlmaty.replace(" ", "T")}:00Z`)) / 60_000);
  if (!(minutes > 0)) return "срок приёма заявок вышел";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts = days > 0 ? [`${days} дн.`, ...(hours ? [`${hours} ч`] : [])] : [...(hours ? [`${hours} ч`] : []), ...(rest ? [`${rest} мин`] : [])];
  return `до конца приёма осталось ${parts.join(" ")}`;
}

function formatCard(card: CustomerCard): string {
  const admins = card.administrators.map((admin) => {
    const details = [admin.budget, admin.since ? `запись с ${admin.since}` : null].filter(Boolean).join(", ");
    return `администратор бюджета: ${admin.name}${admin.bin ? `, БИН ${admin.bin}` : ""}${details ? ` (${details})` : ""}`;
  });
  return [
    `${card.name} (БИН ${card.bin})`,
    `e-mail: ${card.email ?? "не указан"}`,
    `телефон: ${card.phone ?? "не указан"}`,
    ...(card.extraPhones.length ? [`другие телефоны из адресов: ${card.extraPhones.join("; ")}`] : []),
    `сайт: ${card.website ?? "не указан"}`,
    ...(card.head ? [`руководитель по кабинету организации на портале: ${properName(card.head)}`] : []),
    `вышестоящая организация: ${card.parentOrg ?? "в реестре не указана"}`,
    ...admins
  ].join("\n");
}

/** Название организации от первой кавычки: «КГУ «Школа №1» отдела…» и «Коммунальное государственное учреждение "Школа №1" отдела…» дают один ключ. */
function orgKey(name: string): string | null {
  const quote = name.search(/[«"“]/);
  if (quote < 0) return null;
  return name.slice(quote).toLowerCase().replace(/[^\p{L}\p{N}№ ]/gu, " ").replace(/\s+/g, " ").trim() || null;
}

function ownerLabel(id: number | null, askerId: number | undefined): string {
  return id === null ? "не назначен" : id === askerId ? "вы" : `сотрудник с номером ${id}`;
}

function formatCrmHistory(history: CrmCustomerHistory, askerId: number | undefined): string {
  const outcome = { open: "в работе", won: "успешная", lost: "проваленная" } as const;
  const lines: string[] = [];
  for (const company of history.companies) {
    const details = [company.phones.length ? `телефон: ${company.phones.join("; ")}` : null, company.emails.length ? `e-mail: ${company.emails.join("; ")}` : null].filter(Boolean);
    lines.push(`${company.title} (компания в Bitrix ${company.id})${details.length ? `, ${details.join(", ")}` : ""}`);
  }

  lines.push(history.contacts.length ? "Контакты в Bitrix:" : "Контактов с телефоном или почтой в Bitrix нет");
  for (const contact of history.contacts) {
    const parts = [
      contact.name || "без имени",
      contact.post,
      contact.phones.length ? `тел. ${contact.phones.join("; ")}` : null,
      contact.emails.length ? `e-mail ${contact.emails.join("; ")}` : null,
      `ответственный: ${ownerLabel(contact.assignedById, askerId)}`
    ].filter(Boolean);
    lines.push(`- ${parts.join(", ")}`);
  }

  const { deals } = history;
  if (deals.total === 0) {
    lines.push("Сделок с этим заказчиком нет");
  } else {
    lines.push(`Сделок с этим заказчиком: ${deals.total} (успешных ${deals.won}, проваленных ${deals.lost}, в работе ${deals.open}). Последние:`);
    for (const deal of deals.recent) {
      lines.push(`- #${deal.id} ${deal.title}: ${deal.stage}, ${outcome[deal.outcome]}, ответственный: ${ownerLabel(deal.assignedById, askerId)}, создана ${deal.created}${deal.amount ? `, сумма ${deal.amount}` : ""}`);
    }
  }

  if (history.calls.length === 0) {
    lines.push("Звонков по сделкам и контактам заказчика нет");
  } else {
    lines.push("Недавние звонки по сделкам и контактам заказчика:");
    for (const call of history.calls) {
      const who = call.direction === "in" ? "принимал" : "звонил";
      const direction = call.direction === "in" ? "входящий" : call.direction === "out" ? "исходящий" : "звонок";
      lines.push(`- ${call.date} ${direction}: ${call.subject}, ${who} ${ownerLabel(call.responsibleId, askerId)}${call.dealId ? ` (сделка ${call.dealId})` : ""}`);
    }
  }
  return lines.join("\n");
}

/** «в 1 закупке», «в 3 закупках». */
function plural(count: number): string {
  return count % 10 === 1 && count % 100 !== 11 ? "закупке" : "закупках";
}

function formatTender(tender: TenderSummary): string {
  const specs = tender.specFiles.length ? tender.specFiles.map((file) => `${file.name} ${file.url}`).join("; ") : "файла ТЗ нет";
  return `- объявление ${tender.announceId} (№ ${tender.number}), ${tender.publishDate}, сумма ${tender.totalSum ?? "?"}: ${tender.title}. ТЗ: ${specs}. Других файлов: ${tender.otherFiles}`;
}

function formatAnnouncement(contacts: AnnouncementContacts): string {
  const lines = [`Объявление ${contacts.announceId}`];
  if (contacts.customer) lines.push(`Заказчик: ${contacts.customer.name ?? "?"} (БИН ${contacts.customer.bin}), адрес: ${contacts.customer.legalAddress ?? "не указан"}`);
  const person = contacts.representative;
  lines.push(person ? `Контактное лицо: ${person.fullName ? properName(person.fullName) : "не указано"}, ${person.position ?? "должность не указана"}, e-mail: ${person.email ?? "не указан"}` : "Контактное лицо на странице не указано");
  return lines.join("\n");
}

/** Время по Алматы (UTC+5), `YYYY-MM-DD HH:mm`: в таком виде даты отдаёт реестр. */
export function almatyDateTime(now: Date): string {
  return new Date(now.getTime() + ALMATY_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}

function almatyDate(now: Date): string {
  return almatyDateTime(now).slice(0, 10);
}

function daysLeft(today: string, date: string): string {
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return `срок прошёл ${-days} дн. назад`;
  return days === 0 ? "сегодня" : `через ${days} дн.`;
}

function money(value: number): string {
  return `${Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₸`;
}

function enstruCode(input: unknown): string {
  const value = text(input, "enstru_code");
  if (!ENSTRU_PATTERN.test(value)) throw new Error("Код ЕНС ТРУ должен быть вида 262011.100.000001");
  return value;
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function positiveInt(input: unknown, key: string): number {
  const value = Number(record(input)[key]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Параметр ${key} должен быть целым положительным числом`);
  return value;
}

function optionalInt(input: unknown, key: string): number | null {
  const value = record(input)[key];
  return value === undefined || value === null ? null : positiveInt(input, key);
}

function text(input: unknown, key: string): string {
  const value = record(input)[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Параметр ${key} обязателен`);
  return value.trim();
}

function bin(input: unknown): string {
  const value = text(input, "bin");
  if (!/^\d{12}$/.test(value)) throw new Error("БИН должен состоять из 12 цифр");
  return value;
}
