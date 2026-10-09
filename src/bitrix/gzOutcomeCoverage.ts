/** Сколько запросов к порталу сделано и сколько из них провалилось: чтобы шаг не молчал о пробелах. */
export interface OutcomeCoverageInput {
  /** Страницы планов сделок, у которых не хватает БИН или кода ТРУ. */
  planPages: { pending: number; failed: number };
  /** Статусы планов с портала: `pending` нуждались в проверке, `attempted` реально опрошены. */
  status: { pending: number; attempted: number; failed: number; budgetReached: boolean };
  registers: { failed: number };
}

export interface OutcomeCoverage {
  /** Ключи для строки `outcomes: ...` в логе. */
  line: string;
  markdown: string;
  /** Текст для аннотации GitHub `::warning::`; null, если всё в пределах нормы. */
  warning: string | null;
}

/** Доля неудач, с которой портал считается недоступным, и минимум запросов для такого вывода. */
const FAILURE_WARNING_RATIO = 0.2;
const MIN_ATTEMPTS_TO_JUDGE = 10;

export function describeOutcomeCoverage(input: OutcomeCoverageInput): OutcomeCoverage {
  const { planPages, status, registers } = input;
  const portalFailed = planPages.failed + status.failed + registers.failed;
  const line = `html_status_checked=${status.attempted} html_status_pending=${status.pending}`
    + ` plan_pages_pending=${planPages.pending} portal_failed=${portalFailed}`;

  const attempts = status.attempted + planPages.pending;
  const failures = status.failed + planPages.failed;
  const warning = attempts >= MIN_ATTEMPTS_TO_JUDGE && failures / attempts >= FAILURE_WARNING_RATIO
    ? `Портал не открылся в ${failures} из ${attempts} запросов: итоги по этим сделкам не определены`
    : null;

  const lines: string[] = [];
  if (status.pending === 0 && planPages.pending === 0) {
    lines.push("**Портал:** проверка по порталу не потребовалась.");
  } else {
    const parts = [`статус плана проверен у ${status.attempted} из ${status.pending} сделок`];
    if (status.failed > 0) parts.push(`не удалось ${status.failed}`);
    let text = `**Портал:** ${parts.join(", ")}.`;
    if (status.pending > status.attempted) {
      const reason = status.budgetReached ? "достигнут лимит времени" : "достигнут лимит за прогон";
      text += ` Не успели проверить: остальные ${status.pending - status.attempted} — в следующих прогонах (${reason}).`;
    }
    lines.push(text);
    if (planPages.pending > 0) {
      lines.push(`Страницы планов: загружено ${planPages.pending - planPages.failed} из ${planPages.pending}.`);
    }
  }
  if (warning) lines.push(`⚠️ ${warning}.`);
  return { line, markdown: lines.join("\n"), warning };
}
