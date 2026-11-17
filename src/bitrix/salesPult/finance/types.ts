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
  note?: string;
}

export interface FinanceDebtors {
  /** Компании, по которым ведётся список (колонки блока «Дебиторы»). */
  companies: string[];
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
  /** Расхождения, найденные при сверке итогов: страница их показывает, разбор не останавливают. */
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
}
