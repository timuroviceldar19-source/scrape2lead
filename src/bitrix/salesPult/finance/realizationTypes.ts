// Типы «Отчёта о реализации товаров (услуг)» из 1С (два разреза: Клиент-ТМЦ и ТМЦ-Клиент).
// Названия организаций, контрагентов и товаров берутся из файла; в коде и тестах их нет.

import type { FinanceFileInfo } from "./types.js";

export type RealizationKind = "client-tmc" | "tmc-client";

export interface RealizationMetrics {
  /** Количество реализации. */
  qtySale: number;
  /** Количество возвратов (как в файле, обычно <= 0). */
  qtyReturn: number;
  /** Количество реализации (с возвратами). */
  qtyNet: number;
  /** Сумма реализации (с НДС). */
  sumSale: number;
  /** Сумма возвратов (обычно <= 0). */
  sumReturn: number;
  /** Сумма реализации (с возвратами, с НДС). */
  sumNet: number;
  /** Сумма акциза. */
  excise: number;
  /** Сумма НДС. */
  vat: number;
  /** Сумма без налогов (выручка без НДС). */
  sumNoTax: number;
  /** Стоимость (без НДС) — себестоимость, если колонка есть в файле. */
  cost?: number;
  /** Profit (сумма) — валовая прибыль, если колонка есть в файле. */
  profit?: number;
}

/** Узел 3-уровневого дерева реализации: Клиент -> Группа -> ТМЦ или Группа -> ТМЦ -> Клиент. */
export interface RealizationNode {
  name: string;
  metrics: RealizationMetrics;
  children?: RealizationNode[];
}

export interface RealizationReport {
  kind: RealizationKind;
  organization?: string;
  /** Подпись периода из шапки («за Ноябрь 2026 г.» -> «Ноябрь 2026»). */
  periodLabel?: string;
  /** Есть ли в файле колонки себестоимости и прибыли. */
  hasProfit: boolean;
  /** Названия уровней иерархии (3 шт.). */
  levels: [string, string, string];
  /** Узлы верхнего уровня (уровень 0). */
  nodes: RealizationNode[];
  /** Итоги по всему отчёту. */
  totals: RealizationMetrics;
  /** true, если этот разрез построен автоматически из другого файла. */
  derived?: boolean;
  warnings: string[];
}

export interface RealizationView {
  clientTmc?: RealizationReport;
  tmcClient?: RealizationReport;
  files: Partial<Record<RealizationKind, FinanceFileInfo>>;
  notice?: string;
}
