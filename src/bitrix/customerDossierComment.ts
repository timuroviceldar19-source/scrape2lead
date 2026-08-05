import { formatMoney as money, type CustomerDossier } from "../kz/goszakupCustomerDossier.js";

/**
 * Маркер в теле комментария: по нему повторный прогон узнаёт собственную запись и не плодит
 * дубликаты в ленте. Менеджерские комментарии его не содержат.
 */
export const DOSSIER_COMMENT_MARKER = "[scrape2lead:customer-dossier]";

export interface DossierCommentOptions {
  collectedAt: string;
}

export interface TimelineComment {
  COMMENT?: string | null;
}

export function hasDossierComment(comments: TimelineComment[]): boolean {
  return comments.some((comment) => (comment.COMMENT ?? "").includes(DOSSIER_COMMENT_MARKER));
}

export function renderDossierComment(dossier: CustomerDossier, options: DossierCommentOptions): string {
  const { summary } = dossier;
  const blocks = [
    `[B]Досье заказчика ${dossier.bin} — «${dossier.query}»[/B]`,
    `Источник: goszakup.gov.kz, собрано ${options.collectedAt}`,
    "",
    renderOfficers(dossier),
    "",
    renderHistory(summary),
    "",
    renderPrices(summary),
    "",
    renderSuppliers(summary),
    "",
    DOSSIER_COMMENT_MARKER
  ];
  return blocks.join("\n");
}

function renderOfficers(dossier: CustomerDossier): string {
  if (dossier.officers.length === 0) {
    return "[B]Закупщики[/B]\nв объявлениях заказчика не найдено";
  }
  const lines = dossier.officers.map((officer) => {
    const contacts = [officer.position, officer.email].filter(Boolean).join(", ");
    const seen = `объявлений: ${officer.announceIds.length}`;
    return `• ${officer.fullName}${contacts ? ` — ${contacts}` : ""} (${seen})`;
  });
  return ["[B]Закупщики[/B]", ...lines].join("\n");
}

function renderHistory(summary: CustomerDossier["summary"]): string {
  if (summary.lotsTotal === 0) {
    return "[B]История закупок[/B]\nпохожих закупок у этого заказчика не найдено";
  }
  const discount = summary.averageDiscountPercent === null
    ? "сброс цены неизвестен"
    : `сброс ${summary.averageDiscountPercent}%`;
  return [
    "[B]История закупок[/B]",
    `Лотов: ${summary.lotsTotal} · с договором: ${summary.lotsAwarded} · не состоялось: ${summary.lotsFailed}`,
    `План ${money(summary.plannedTotal)} → договоры ${money(summary.contractedTotal)} (${discount})`
  ].join("\n");
}

function renderPrices(summary: CustomerDossier["summary"]): string {
  if (summary.priceHistory.length === 0) {
    return "[B]Цены по лотам[/B]\nзакрытых лотов не найдено";
  }
  const lines = summary.priceHistory.map((entry) => {
    const discount = entry.discountPercent === null ? "" : ` (−${entry.discountPercent}%)`;
    const supplier = [entry.supplierName, entry.supplierBin].filter(Boolean).join(" ");
    return `• ${entry.lotNumber}, ${entry.quantity ?? "?"} шт: ` +
      `${money(entry.plannedUnitPrice)}/шт → ${money(entry.contractedUnitPrice)}/шт${discount}` +
      `${supplier ? ` — ${supplier}` : ""}`;
  });
  return ["[B]Цены по лотам[/B]", ...lines].join("\n");
}

function renderSuppliers(summary: CustomerDossier["summary"]): string {
  if (summary.suppliers.length === 0) {
    return "[B]Кто выигрывает[/B]\nпобедителей не найдено";
  }
  const lines = summary.suppliers.map(
    (supplier) => `• ${supplier.wins}× ${supplier.name}${supplier.bin ? ` (${supplier.bin})` : ""} — ${money(supplier.contractedTotal)}`
  );
  return ["[B]Кто выигрывает[/B]", ...lines].join("\n");
}
