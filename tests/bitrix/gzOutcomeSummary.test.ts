import { expect, it } from 'vitest';
import { formatPortalConflicts } from '../../src/bitrix/gzOutcomeSummary.js';

it('показывает только номера и статусы неподтверждённых планов', () => {
  expect(formatPortalConflicts([{ planNumber: 100, zakupStatus: 'Не состоялась', verification: { reason: 'source_conflict', portalStatus: 'Опубликован' } },
    { planNumber: 101, zakupStatus: 'Утвержден', verification: { reason: 'portal_unavailable' } }])).toContain('| 100 | source_conflict | Не состоялась | Опубликован |');
  expect(formatPortalConflicts([{ planNumber: 101, zakupStatus: null, verification: { reason: 'portal_unavailable' } }])).toContain('| 101 | portal_unavailable | — | — |');
});
