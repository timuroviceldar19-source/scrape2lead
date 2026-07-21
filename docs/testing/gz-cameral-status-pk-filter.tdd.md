# GZ cameral status and PK relevance filter — TDD evidence

## Source and user journeys

The implementation follows the plan agreed in the task conversation.

- As an export operator, I want both `Утвержден` and `На проверке камерального контроля` plans collected so that relevant pre-publication plans are not missed.
- As a PK pipeline owner, I want only computers, notebooks, monoblocks, workstations and computer monitors exported so that MFPs, printers and unrelated keyword matches never reach XLSX or Bitrix.
- As a publication monitor operator, I want either pre-publication status to transition to `Опубликован` without changing the Bitrix stage.

## RED / GREEN evidence

- RED: `npm test -- --run tests/kz/gzPlansConfig.test.ts tests/kz/gzPlanExporter.test.ts tests/kz/gzPlanExporterIntegration.test.ts tests/bitrix/gzPublishedDealStatus.test.ts` failed 7 intended tests and passed 54. Failures covered missing status 444, unchanged configs, absent TRU filtering, registry enrichment before filtering, and the monitor rejecting the new status.
- RED checkpoint: `2ae572d test: add reproducers for GZ status and PK filtering`.
- GREEN: the same focused suites passed 61/61 after the implementation. The broader focused run including routing passed 72/72.
- GREEN checkpoints: `f712251 fix: expand GZ statuses and filter PK plans by TRU code` and `d730332 fix: route notebook GZ plans to PK pipeline`.
- Regression: `npm test` passed 527 tests; one pre-existing opt-in dashboard E2E test was skipped.
- Typecheck: `npm run lint` passed.
- Coverage: `npm run test:coverage` passed 527 tests. Changed modules reached 90.19% lines for `gzPlanExporter.ts`, 89.28% for `gzPlansConfig.ts`, and 100% for `gzPublishedDealStatus.ts`.

## Test specification

| # | Guarantee | Evidence | Type | Result |
|---|---|---|---|---|
| 1 | Status 444 resolves to the canonical cameral-control label and both real configs collect it | `tests/kz/gzPlansConfig.test.ts` | Unit / integration | PASS |
| 2 | PK searches computers, monitors, monoblocks and notebooks, with no MFP search keyword | `tests/kz/gzPlansConfig.test.ts` | Integration | PASS |
| 3 | Only ESTRU families `262011.*`, `262013.*`, and `262017.100.*` survive the PK allow-list | `tests/kz/gzPlanExporter.test.ts` | Unit | PASS |
| 4 | Unrelated or missing ESTRU codes are dropped; MFPs, printers, medical monitors and transponders do not survive | `tests/kz/gzPlanExporter.test.ts` | Unit | PASS |
| 5 | An unrelated plan is removed before customer registry enrichment and is counted as `tru_code` junk | `tests/kz/gzPlanExporterIntegration.test.ts` | Integration | PASS |
| 6 | Notebook plans route to the PK Bitrix category | `tests/bitrix/gzDealRouting.test.ts` | Integration | PASS |
| 7 | Both allowed pre-publication statuses transition to `Опубликован` without writing `STAGE_ID` | `tests/bitrix/gzPublishedDealStatus.test.ts` | Unit | PASS |

## Known gaps and security audit

- The repository-wide line coverage is 46.97% because numerous unrelated CLI and network entrypoints have no tests; each changed behavior and each changed module exceeds 80% line coverage.
- No live Goszakup or Bitrix mutation was performed. Historical XLSX files and existing Bitrix deals were intentionally left unchanged.
- `npm audit --audit-level=high` reports four existing dependency findings: one low, two moderate, and one high (`brace-expansion`). Automatic dependency upgrades were not applied because they are outside this task and the full fix proposes a breaking ExcelJS downgrade.
