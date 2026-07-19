import type { CounterpartyCheck, RiskColor } from "./kgdCounterpartyTypes.js";

export function evaluateCounterpartyRisk(check: CounterpartyCheck): { color: RiskColor; explanations: string[] } {
  const red: string[] = [], gray: string[] = [], yellow: string[] = [], info: string[] = [];
  if (!check.validBin) gray.push("Некорректный БИН");
  for (const [stage, status] of Object.entries(check.stages)) {
    if (status === "captcha_required") gray.push(`CAPTCHA не завершена: ${stage}`);
    else if (status === "unavailable") gray.push(`Источник недоступен: ${stage}`);
  }
  if (check.bankruptcy) red.push("Обнаружен признак банкротства");
  if (check.liquidation.active) red.push(`Налогоплательщик на стадии ликвидации${check.liquidation.startDate ? ` с ${formatDate(check.liquidation.startDate)}` : ""}`);
  if (check.esfRestricted) red.push("Ограничение выписки ЭСФ");
  if (check.unreliable) red.push(`Признак неблагонадёжности: ${check.unreliableReasons.join(", ")}`);
  if (check.vat.status === "removed" && check.vat.removedAt) red.push(`Снят с учёта по НДС ${formatDate(check.vat.removedAt)}`);
  else if (check.vat.status === "removed") yellow.push("Снят с учёта по НДС без даты или с неполными реквизитами");
  else if (check.vat.status === "contradictory") yellow.push("Противоречивые сведения об учёте по НДС");
  else if (check.vat.status === "never_registered") info.push("не плательщик НДС");
  for (const bulk of check.bulkChecks) {
    const label = bulk.source === "insolvent" ? "несостоятельных должников" : "принудительно ликвидированных лиц";
    if (bulk.matched && bulk.status !== "unavailable") red.push(`В списке ${label}${bulk.listDate ? ` по данным от ${formatDate(bulk.listDate)}` : ""}`);
    else if (bulk.status === "stale_negative") gray.push(`Отрицательный результат из устаревшего bulk-кэша (${label})`);
    else if (bulk.status === "unavailable") gray.push(`Bulk-источник недоступен: список ${label}`);
  }
  const color: RiskColor = red.length ? "red" : gray.length ? "gray" : yellow.length ? "yellow" : "green";
  return { color, explanations: [...red, ...gray, ...yellow, ...info] };
}
function formatDate(value: string): string { const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}.${m[2]}.${m[1]}` : value; }
