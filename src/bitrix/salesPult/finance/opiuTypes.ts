// Типы отчёта ОПиУ (Отчёт о прибылях и убытках) с 1- и 2-уровневой расшифровкой.
// Названия организаций, контрагентов и статей берутся только из файла; в коде и тестах их нет.

import type { FinanceFileInfo } from "./types.js";

/** Годовая колонка ОПиУ: например key="2023", label="2023" или key="2026", label="9 мес. 2026". */
export interface OpiuYearColumn {
  /** Четырёхзначный год ("2023", "2024", "2025", "2026"). */
  year: string;
  /** Подпись из шапки файла ("2023", "9 мес. 2026"). */
  label: string;
  /** Месяцы этого года, у которых есть ненулевые данные (ключи "YYYY-MM"). */
  months: string[];
}

/**
 * Элемент расшифровки (строка на листе «Расш. ОПиУ»).
 * Для 2-уровневых разделов (Расходы по реализации, Административные расходы)
 * жирная строка становится группой с заполненным массивом `children`.
 */
export interface OpiuBreakdownItem {
  label: string;
  /** Значения по годам в порядке `OpiuReport.years` (округлены до тенге). */
  years: number[];
  /** Ненулевые значения по месяцам (`"YYYY-MM"` -> сумма в тенге). */
  months: Record<string, number>;
  /** Дочерние строки (контрагенты / сотрудники) под жирной статьёй расхода. */
  children?: OpiuBreakdownItem[];
}

/** Раздел расшифровки для одной строки ОПиУ. */
export interface OpiuBreakdownSection {
  /** Ключ раздела (совпадает с `OpiuRow.breakdownKey`). */
  key: string;
  /** Заголовок раздела на листе «Расш. ОПиУ». */
  title: string;
  /** Итоги раздела по годам в порядке `OpiuReport.years`. */
  years: number[];
  /** Итоги раздела по месяцам (`"YYYY-MM"` -> сумма). */
  months: Record<string, number>;
  /** Есть ли 2-й уровень вложенности (жирные группы -> строки расшифровки). */
  hasGroups: boolean;
  items: OpiuBreakdownItem[];
}

/** Строка таблицы ОПиУ. */
export interface OpiuRow {
  /** Код строки из колонки «Код строки» ("010", "011", "013", "014", "020", …) или нормализованный ключ. */
  code: string;
  label: string;
  /** Жирная итоговая / расчётная строка (Валовая прибыль, Операционная прибыль, Чистая прибыль и т.д.). */
  isBold: boolean;
  /** Строка с процентами (Наценка, Маржа, Рентабельность, ROS): значения в долях (0.42 = 42%). */
  isPercent: boolean;
  /** Годовые значения в порядке `OpiuReport.years`. */
  years: Array<number | null>;
  /** Помесячные значения (`"YYYY-MM"` -> значение). */
  months: Record<string, number>;
  /** Ключ в `OpiuReport.breakdowns`, если у строки есть расшифровка. */
  breakdownKey?: string;
}

export interface OpiuReport {
  /** Наименование организации из шапки листа ОПиУ (если заполнено). */
  organization?: string;
  /** Единица измерения из шапки («тенге без НДС»). */
  unitLabel?: string;
  /** Период последнего столбца, например «9 мес. 2026». */
  periodLabel: string;
  /** Годовые столбцы по возрастанию. */
  years: OpiuYearColumn[];
  /** Все месяцы, по которым есть данные (по возрастанию, `"YYYY-MM"`). */
  months: string[];
  /** Строки отчёта ОПиУ в порядке следования в файле. */
  rows: OpiuRow[];
  /** Расшифровки строк, индексированные по `breakdownKey`. */
  breakdowns: Record<string, OpiuBreakdownSection>;
  /** Предупреждения сверки сумм расшифровки со строками ОПиУ. */
  warnings: string[];
}

export interface OpiuView {
  report?: OpiuReport;
  file?: FinanceFileInfo;
  error?: string;
  notice?: string;
}
