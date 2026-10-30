import type { PortalVerification } from '../kz/goszakupPlanRegistry.js';

export function formatPortalConflicts(entries: Array<{ planNumber: number | null; zakupStatus: string | null; verification: PortalVerification | null }>): string {
  const rows = entries.filter(entry => entry.planNumber && (entry.verification?.reason === 'source_conflict' || entry.verification?.reason === 'portal_unavailable'));
  if (!rows.length) return '';
  const escape = (value: string | null | undefined) => (value || '—').replace(/[\r\n|]/g, ' ');
  const lines = rows.map(entry => `| ${entry.planNumber} | ${entry.verification!.reason} | ${escape(entry.zakupStatus)} | ${escape(entry.verification!.portalStatus)} |`);
  return ['### Сверка с порталом', '', '| План | Причина | zakup | Портал |', '| --- | --- | --- | --- |', ...new Set(lines)].join('\n');
}
