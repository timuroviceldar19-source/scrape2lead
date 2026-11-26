// Финансовый пульт: что достаётся из ежедневного отчёта финансиста (Excel из чата Битрикс24).
// Названия компаний, банков и контрагентов берутся из самого файла: репозиторий публичный,
// поэтому в коде их нет.

/** Значения по компаниям группы в порядке `FinanceReport.companies`, плюс итог. */
export interface FinanceCompanyValues {
  values: number[];
  total: number;
}

/** Прибыль и убыток за период по счетам бухгалтерии (6xxx доходы, 7000 себестоимость, прочие 7xxx–8xxx расходы). */
export interface FinancePnl {
  /** Конец периода (дата в шапке блока счетов). */
  date: string;
  revenue: FinanceCompanyValues;
  cost: FinanceCompanyValues;
  expenses: FinanceCompanyValues;
  profit: FinanceCompanyValues;
}

export interface FinanceBalanceLine {
  code: string;
  label: string;
  values: number[];
  total: number;
}

export interface FinanceCashRow {
  company: string;
  byBank: number[];
  total: number;
  inventory: number;
}

export interface FinanceCash {
  banks: string[];
  rows: FinanceCashRow[];
  /** Итог по банкам из строки «Итого». */
  byBank: number[];
  total: number;
  inventory: number;
}

/** Движение денег за день: остаток вчера, сегодня, без поступлений и потрачено. */
export interface FinanceCashFlow {
  prevDate?: string;
  prev: number;
  today: number;
  withoutIncoming?: number;
  spent?: number;
}

export interface FinanceIncoming {
  payer: string;
  company: string;
  amount: number;
}

export interface FinanceDebtor {
  name: string;
  company: string;
  amount: number;
  saleDate?: string;
  /** «Дата оплаты» — когда должны заплатить; дни до неё страница считает сама на дату сборки. */
  paymentDate?: string;
  /** «Дата подачи иска». */
  claimDate?: string;
  /** «Номер иска» — в файле там бывает и текст («иск подан в …»). */
  claimNumber?: string;
  note?: string;
}

/** Необязательные колонки шапки «Дебиторы» (между «Датой реализации» и «ИТОГО»). */
export type FinanceDebtorColumn = "paymentDate" | "daysToPay" | "claimDate" | "claimNumber";

export interface FinanceDebtors {
  /** Компании, по которым ведётся список (колонки блока «Дебиторы»). */
  companies: string[];
  /** Какие необязательные колонки есть в файле — их и показывает страница. */
  columns?: FinanceDebtorColumn[];
  rows: FinanceDebtor[];
  /** Суммы строк по компаниям. */
  totals: number[];
  total: number;
}

export interface FinanceLiability {
  label: string;
  values: number[];
  total: number;
}

export interface FinancePayment {
  /** Пометка слева от получателя: компания или срок («F3», «Группа», «20-е»). */
  tag?: string;
  payee: string;
  amount: number;
  basis?: string;
}

export interface FinancePaymentList {
  label: string;
  items: FinancePayment[];
  total: number;
}

export interface FinanceRate {
  label: string;
  value: number;
}

export interface FinanceTax {
  date: string;
  label: string;
  values: number[];
  total: number;
}

/** Суммы по складу: на начало, приход, расход, на конец. Приход и расход — если они есть в выгрузке. */
export interface FinanceStockSums {
  start: number;
  in?: number;
  out?: number;
  end: number;
}

/** Товар из материальной ведомости 1С. Суммы округлены до тенге, «шт» не хранится. */
export interface FinanceStockItem {
  name: string;
  unit?: string;
  startQty: number;
  startSum: number;
  inQty?: number;
  inSum?: number;
  outQty?: number;
  outSum?: number;
  endQty: number;
  endSum: number;
}

export interface FinanceStockWarehouse {
  name: string;
  sums: FinanceStockSums;
  items: FinanceStockItem[];
}

/** Материальная ведомость одной компании — отдельный лист файла. */
export interface FinanceStock {
  company: string;
  /** Период из заголовка ведомости, например «Ноябрь 2026». */
  period?: string;
  /** Есть ли колонки «Итого приход» и «Итого расход» (зависит от настроек выгрузки). */
  hasMoves: boolean;
  warehouses: FinanceStockWarehouse[];
  total: FinanceStockSums;
}

export interface FinanceReport {
  /** На какую дату данные: самая поздняя дата в шапках блоков счетов. */
  dataDate: string;
  /** Подпись периода из файла, например «01.11. - 16.11.2026». */
  periodLabel?: string;
  companies: string[];
  pnl: { current?: FinancePnl; previous?: FinancePnl };
  balances: FinanceBalanceLine[];
  tax?: FinanceTax;
  cash: FinanceCash;
  cashFlow?: FinanceCashFlow;
  incoming: FinanceIncoming[];
  incomingTotal: number;
  debtors: FinanceDebtors;
  problemDebts?: FinanceDebtors;
  liabilities: FinanceLiability[];
  /** Платёжный календарь: первый список — блок «Календарь» с итогом в файле, дальше прочие платежи. */
  payments: FinancePaymentList[];
  rates: FinanceRate[];
  /** Материальные ведомости с отдельных листов (по компаниям); нет листов — нет поля. */
  stock?: FinanceStock[];
  /** Расхождения, найденные при сверке итогов: страница их показывает, разбор не останавливают. */
  warnings: string[];
}

/** Период ОПиУ: месяц или итог года — как в шапке листа. */
export interface FinanceStatementPeriod {
  /** «2026-03» у месяца, «2026» у итога года. */
  key: string;
  kind: "month" | "year";
  year: number;
  /** Подпись итога года из файла («2025», «9 мес. 2026»). */
  label?: string;
}

/** item — статья из файла, subtotal — промежуточный итог (прибыль), ratio — доля (наценка, маржа). */
export type FinanceStatementLineKind = "item" | "subtotal" | "ratio";

export interface FinanceStatementBreakdownRow {
  label: string;
  /** Суммы по месяцам («2026-03» → тенге, округлены), только ненулевые; итог года страница складывает сама. */
  months: Record<string, number>;
}

/** Строки статьи с листа «Расш. ОПиУ». */
export interface FinanceStatementBreakdown {
  /** Заголовок статьи на листе расшифровки. */
  title: string;
  rows: FinanceStatementBreakdownRow[];
}

export interface FinanceStatementLine {
  label: string;
  /** «Код строки» формы (010, 011…), если есть. */
  code?: string;
  kind: FinanceStatementLineKind;
  /** По `periods`; null — в файле пусто. У долей — доля как в файле (0,15 = 15%). */
  values: Array<number | null>;
  breakdown?: FinanceStatementBreakdown;
}

/** ОПиУ из книги ФО (листы «ОПиУ» и «Расш. ОПиУ»). */
export interface FinanceIncomeStatement {
  company?: string;
  /** Подпись единиц с листа расшифровки («тенге без НДС»). */
  unit?: string;
  periods: FinanceStatementPeriod[];
  lines: FinanceStatementLine[];
  /** Расхождения сверки строк расшифровки с ОПиУ: показываются на странице. */
  warnings: string[];
}

/** Короткая запись дня для графиков: из каждого файла за свою дату. */
export interface FinanceSnapshot {
  dataDate: string;
  cash: number;
  inventory: number;
  debtors: number;
  problemDebts: number;
  payables?: number;
  loans: number;
  paymentsDue: number;
  revenue?: number;
  profit?: number;
}

export interface FinanceFileInfo {
  id: string;
  name: string;
  /** Когда файл положили в чат (ISO из Битрикса). */
  uploadedAt: string;
}

export interface FinanceView {
  report?: FinanceReport;
  file?: FinanceFileInfo;
  /** По датам данных, по возрастанию. */
  snapshots: FinanceSnapshot[];
  /** Нет ни одного разобранного отчёта. */
  error?: string;
  /** Отчёт есть, но с последним файлом что-то не так — показывается над страницей. */
  notice?: string;
  /** ОПиУ из книги ФО, присланной в тот же чат (самая свежая разобранная). */
  statement?: FinanceIncomeStatement;
  statementFile?: FinanceFileInfo;
  /** С последней книгой ФО что-то не так — показывается в разделе ОПиУ. */
  statementNotice?: string;
}
