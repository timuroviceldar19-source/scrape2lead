/**
 * Разбор выгрузки Tenderbot по площадкам и товарности.
 *
 * Зачем: общий счёт «272 лота» пугает, но 164 из них — госзакупки, 43 — площадки F3,
 * которые и так собираются. Реальный пробел считаем только по непокрытым площадкам
 * и только по нашим товарам.
 */

export type PlatformGroup = "collected_gz" | "collected_f3" | "gap" | "out_of_scope" | "other";

export type ProductKind = "core" | "adjacent" | "non_product" | "unknown";

export interface PlatformReportLot {
  id: number;
  name: string | null;
  amount: number | null;
  customer: string | null;
  link: string | null;
  platform: string;
  platformGroup: PlatformGroup;
  productKind: ProductKind;
  keyword: string | null;
}

export interface PlatformReportGroup {
  group: PlatformGroup;
  lots: number;
  productLots: number;
  sum: number;
  productSum: number;
}

export interface PlatformReport {
  totalLots: number;
  totalSum: number;
  gapLots: number;
  gapSum: number;
  groups: PlatformReportGroup[];
  rows: PlatformReportLot[];
}

const PLATFORM_DOMAINS: Record<string, PlatformGroup> = {
  "goszakup.gov.kz": "collected_gz",
  "old.goszakup.gov.kz": "collected_gz",
  "zakup.sk.kz": "collected_f3",
  "eep.mitwork.kz": "collected_f3",
  "tizilim.gov.kz": "collected_f3",
  "sell.omarket.kz": "gap",
  "td.ccx.kz": "gap",
  "eurasiantech-tender.kz": "gap",
  "med.ecc.kz": "out_of_scope",
  "zakup.nationalbank.kz": "out_of_scope",
  "tender.alina.kz": "out_of_scope"
};

const NON_PRODUCT_PATTERNS = [
  /стол/i,
  /лиценз/i,
  /мфу/i,
  /принтер/i,
  /проектор/i,
  /сетевое устройство/i,
  /вставка угловая/i,
  /расходомер/i,
  /спирометр/i,
  /ремонт/i
];

const CORE_PATTERNS = [
  /компьютер/i,
  /ноутбук/i,
  /панель интерактивная/i,
  /панель жидкокристаллическая/i,
  /накопитель/i,
  /жесткий диск/i,
  /системный блок/i,
  /\bssd\b/i,
  /\bhdd\b/i,
  /планшет/i,
  /станция рабочая/i,
  /модуль процессорный/i
];

const ADJACENT_PATTERNS = [
  /комплект учебного оборудования/i,
  /кабинет учебный/i,
  /оборудование учебно-лабораторное/i,
  /доска специальная/i
];

export function platformHost(link: string | null | undefined): string {
  if (!link) return "";
  try {
    return new URL(link).host.toLowerCase();
  } catch {
    return "";
  }
}

export function classifyPlatform(link: string | null | undefined): PlatformGroup {
  return PLATFORM_DOMAINS[platformHost(link)] ?? "other";
}

export function classifyProduct(name: string | null | undefined): ProductKind {
  const value = name ?? "";
  if (value.trim() === "") return "unknown";
  if (NON_PRODUCT_PATTERNS.some((pattern) => pattern.test(value))) return "non_product";
  if (CORE_PATTERNS.some((pattern) => pattern.test(value))) return "core";
  if (ADJACENT_PATTERNS.some((pattern) => pattern.test(value))) return "adjacent";
  return "unknown";
}

export function isProduct(kind: ProductKind): boolean {
  return kind === "core" || kind === "adjacent";
}

export function buildPlatformReport(
  lots: Array<{
    id: number;
    name?: string | null;
    amount?: number | null;
    customer?: string | null;
    goszakupLink?: string | null;
    keyword?: string | null;
  }>
): PlatformReport {
  const rows: PlatformReportLot[] = lots.map((lot) => {
    const platformGroup = classifyPlatform(lot.goszakupLink);
    return {
      id: lot.id,
      name: lot.name ?? null,
      amount: lot.amount ?? null,
      customer: lot.customer ?? null,
      link: lot.goszakupLink ?? null,
      platform: platformHost(lot.goszakupLink) || "без ссылки",
      platformGroup,
      productKind: classifyProduct(lot.name),
      keyword: lot.keyword ?? null
    };
  });

  const groups = new Map<PlatformGroup, PlatformReportGroup>();
  for (const row of rows) {
    const group = groups.get(row.platformGroup) ?? {
      group: row.platformGroup,
      lots: 0,
      productLots: 0,
      sum: 0,
      productSum: 0
    };
    group.lots++;
    group.sum += row.amount ?? 0;
    if (isProduct(row.productKind)) {
      group.productLots++;
      group.productSum += row.amount ?? 0;
    }
    groups.set(row.platformGroup, group);
  }

  const gapRows = rows.filter((row) => row.platformGroup === "gap" && isProduct(row.productKind));

  return {
    totalLots: rows.length,
    totalSum: rows.reduce((sum, row) => sum + (row.amount ?? 0), 0),
    gapLots: gapRows.length,
    gapSum: gapRows.reduce((sum, row) => sum + (row.amount ?? 0), 0),
    groups: [...groups.values()].sort((a, b) => b.lots - a.lots),
    rows
  };
}

export function renderMarkdown(report: PlatformReport): string {
  const title: Record<PlatformGroup, string> = {
    collected_gz: "Собираем (госзакупки)",
    collected_f3: "Собираем (F3)",
    gap: "Не собираем",
    out_of_scope: "Вне наших товаров",
    other: "Прочее"
  };
  const money = (value: number) => `${(value / 1_000_000).toFixed(1)} млн ₸`;
  const lines = [
    "# Пробел по площадкам Tenderbot",
    "",
    `Всего строк: ${report.totalLots} на ${money(report.totalSum)}.`,
    `Реальный пробел по нашим товарам: **${report.gapLots} лотов на ${money(report.gapSum)}** — только непокрытые площадки.`,
    "",
    "| Группа | Лотов | Из них наших | Сумма |",
    "|---|---|---|---|"
  ];
  for (const group of report.groups) {
    lines.push(`| ${title[group.group]} | ${group.lots} | ${group.productLots} | ${money(group.sum)} |`);
  }
  lines.push("", "## Лоты в пробеле", "");
  for (const row of report.rows.filter((r) => r.platformGroup === "gap" && isProduct(r.productKind))) {
    lines.push(`- ${row.id} — ${row.name ?? "?"} — ${row.amount ?? "?"} ₸ — ${row.platform} — ${row.link ?? ""}`);
  }
  return lines.join("\n") + "\n";
}
