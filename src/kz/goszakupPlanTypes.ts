export interface GoszakupPlanListItem {
  plan_point_id: string;
  plan_list_number: string | null;
  customer_name: string | null;
  customer_url: string | null;
  item_name: string | null;
  method: string | null;
  unit: string | null;
  quantity: string | null;
  unit_price: string | null;
  planned_amount: string | null;
  planned_month: string | null;
  status: string | null;
  detail_url: string | null;
  keyword: string;
}

export interface GoszakupPlanDetail {
  plan_point_id: string;
  customer_bin: string | null;
  customer_name: string | null;
  name_ru: string | null;
  ref_enstru_code: string | null;
  desc_ru: string | null;
  extra_desc_ru: string | null;
  date_approved: string | null;
  ref_abp_code: string | null;
  abp_name: string | null;
  delivery_address: string | null;
  plan_act_number: string | null;
}

export interface GzPlanExportRow {
  customer_bin: string;
  customer_name: string;
  website: string;
  email: string;
  phone: string;
  reporting_administrator: string;
  full_address: string;
  director_name: string;
  plan_act_date: string;
  stru_code: string;
  stru_name: string;
  item_link: string;
  unit: string;
  quantity: string;
  unit_price: string;
  extra_characteristics: string;
  keyword: string;
  plan_list_number: string;
  plan_point_id: string;
  planned_month: string;
  status: string;
  planned_amount: string;
  method: string;
  customer_link: string;
  plan_link: string;
  short_characteristics: string;
  extra_description: string;
  delivery_address: string;
}

export interface GzPlanCollectOptions {
  keywords?: string[];
  year?: number;
  months?: number[];
  /** Plan status names (e.g. "Утвержден") or numeric IDs as strings. Empty = no filter. */
  statuses?: string[];
  maxPages?: number;
  delayMs?: number;
  headless?: boolean;
  debugDir?: string;
  pageLoadTimeoutMs?: number;
  keepDuplicates?: boolean;
  token?: string | null;
  onProgress?: (message: string) => void;
}

export interface GzPlanCollectResult {
  items: Array<GoszakupPlanListItem & { detail: GoszakupPlanDetail | null }>;
}

export interface GzPlanExportOptions extends GzPlanCollectOptions {
  outPath?: string;
  databasePath?: string;
  skipRegistry?: boolean;
  forceRegistryRefresh?: boolean;
}

export interface GzPlanExportResult {
  xlsxPath: string;
  rows: number;
  customers: number;
  registryHits: number;
}

export const DEFAULT_GZ_PLAN_KEYWORDS = [
  "Доска специальная",
  "Панель интерактивная",
  "Панель жидкокристаллическая"
] as const;

export const DEFAULT_GZ_PLAN_STATUSES = ["Утвержден"] as const;

/** Status IDs from goszakup plan search form filter[status][] */
export const GZ_PLAN_STATUS_BY_NAME: Record<string, number> = {
  "Договор действует": 16,
  "Договор изменен": 320,
  "Договор не заключен": 18,
  "Договор не заключен, отказ от первого победителя": 400,
  "Договор не заключен. Изменен.": 350,
  "Договор не исполнен. Нет платежей": 340,
  "Договор частично исполнен": 410,
  "Закупка не состоялась": 10,
  "Закупка не состоялась. Изменен": 11,
  "Закупка состоялась": 9,
  "Заявка": 3,
  "Заявка возвращена организатором": 13,
  "Заявка отклонена": 27,
  "Заявка подтверждена": 26,
  "Исполнен": 19,
  "На обжаловании": 22,
  "Опубликован": 5,
  "Отменен": 7,
  "Отменен. Изменен": 21,
  "Пересмотр итогов": 23,
  "Принятие решение о пересмотре итогов": 550,
  "Принятие решение об исполнении уведомления": 540,
  "Приостановлен": 12,
  "Проект договора": 310,
  "Проект заявки": 25,
  "Утвержден": 2
};

export const MONTH_NAMES_RU: Record<string, number> = {
  "январь": 1,
  "февраль": 2,
  "март": 3,
  "апрель": 4,
  "май": 5,
  "июнь": 6,
  "июль": 7,
  "август": 8,
  "сентябрь": 9,
  "октябрь": 10,
  "ноябрь": 11,
  "декабрь": 12
};
