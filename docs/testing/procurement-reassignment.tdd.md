# Procurement deal reassignment TDD evidence

## Scope

Reassign existing integration-owned deals in Bitrix category `1` to Саматбек Нурматов (`2255`)
without changing their stages or touching manually created deals.

## RED / GREEN

- RED: `npx vitest run tests/bitrix/procurementReassignment.test.ts` failed because
  `procurementReassignment` did not exist.
- GREEN: the same target passed after implementing the strict category/originator filter and
  an update payload containing only `ASSIGNED_BY_ID`.
- Full suite: 573 tests passed, one optional E2E test skipped; `npm run lint` passed.
- `procurementReassignment.ts`: 100% statements, branches, functions and lines.

| Guarantee | Test | Result |
|---|---|---|
| Only category-1 deals owned by `scrape2lead-procurement` are selected | `tests/bitrix/procurementReassignment.test.ts` | PASS |
| Deals already assigned to `2255` are skipped | `tests/bitrix/procurementReassignment.test.ts` | PASS |
| The update contains only `ASSIGNED_BY_ID` and preserves the stage | `tests/bitrix/procurementReassignment.test.ts` | PASS |

## Live verification

- Dry-run matched 23 integration-owned deals and planned 23 updates.
- Execute updated all 23 deals to `2255`.
- Read-back reported zero invalid assignees and zero stage changes.
- A second dry-run matched the same 23 deals, with all 23 already assigned and zero planned
  updates.
- Execution report:
  `output/procurement/reassignment-2026-07-23T04-33-44-661Z.json`.
