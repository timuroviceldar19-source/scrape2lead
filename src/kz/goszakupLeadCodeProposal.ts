export interface LeadCodeInput { code: string; name: string; contracts: number; }
export interface LeadCodeRow extends LeadCodeInput { category: string; note: string; }
export interface LeadCodeProposal { nonZero: LeadCodeRow[]; zero: LeadCodeRow[]; }

const excluded: Array<[RegExp, string]> = [
  [/(?:лицензи|программ|по\b|software)/i, "похоже на ПО/лицензию"],
  [/(?:услуг|внедрен|сопровожд|настройк)/i, "похоже на услугу"],
  [/(?:картридж|тонер|чернил|расходн)/i, "похоже на расходник"],
  [/(?:телефон|телефони|связ[ьи]|сим-карт)/i, "похоже на телефонию/связь"],
  [/(?:видеонаблюден|камера виде|видеокамер)/i, "похоже на видеонаблюдение"]
];

export function buildLeadCodeProposal(rows: LeadCodeInput[]): LeadCodeProposal {
  const unique = new Map<string, LeadCodeRow>();
  for (const item of rows) {
    const existing = unique.get(item.code);
    if (existing) { existing.contracts += item.contracts; continue; }
    unique.set(item.code, { ...item, category: category(item.name), note: note(item.name) });
  }
  const sorted = [...unique.values()].sort((a, b) => b.contracts - a.contracts || a.code.localeCompare(b.code));
  return { nonZero: sorted.filter((row) => row.contracts > 0).slice(0, 80), zero: sorted.filter((row) => row.contracts === 0).slice(0, 15) };
}

export function validateContractSourceCoverage(stats: { rows: number; minDate: string | null; maxDate: string | null }, from: string, to: string): void {
  if (!stats.rows || !stats.minDate || !stats.maxDate || stats.minDate > from || stats.maxDate < to) {
    throw new Error(`Источник не покрывает период ${from}—${to}: строк=${stats.rows}, min=${stats.minDate ?? "-"}, max=${stats.maxDate ?? "-"}`);
  }
}

export function renderLeadCodeProposal(proposal: LeadCodeProposal, sample?: { cards: number; minDate: string | null; maxDate: string | null }): string {
  const header = sample ? `# Черновик ЕНС ТРУ — выборка\n\nВыборка: обработано карточек договоров: ${sample.cards}; диапазон дат: ${sample.minDate ?? "-"}—${sample.maxDate ?? "-"}. Это не полный рынок.` : "";
  return [header, renderTable("Коды с контрактами", proposal.nonZero), renderTable("Коды с 0 контрактов", proposal.zero)].filter(Boolean).join("\n\n");
}

function renderTable(title: string, rows: LeadCodeRow[]): string {
  const body = rows.map((row) => `| ${row.code} | ${row.name.replaceAll("|", "\\|")} | ${row.category} | ${row.contracts} | ${row.note} |`).join("\n") || "| — | — | — | 0 | — |";
  return `## ${title}\n\n| Код | Название | Категория | Контрактов за 3 месяца | Пометка |\n| --- | --- | --- | ---: | --- |\n${body}`;
}

function note(name: string): string { return excluded.find(([pattern]) => pattern.test(name))?.[1] ?? ""; }
function category(name: string): string {
  if (/(?:ноутбук|компьютер|моноблок)/i.test(name)) return "Компьютеры и ноутбуки";
  if (/монитор/i.test(name)) return "Мониторы";
  if (/(?:сервер|схд|хранилищ)/i.test(name)) return "Серверы и СХД";
  if (/(?:маршрутизатор|коммутатор|сетев|wifi|wi-fi)/i.test(name)) return "Сетевое оборудование";
  if (/(?:принтер|мфу|многофункцион)/i.test(name)) return "Печать";
  if (/(?:ибп|бесперебойн)/i.test(name)) return "ИБП";
  return "Комплектующие";
}
