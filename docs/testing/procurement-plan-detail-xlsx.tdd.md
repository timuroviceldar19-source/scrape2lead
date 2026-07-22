# TDD evidence: EPZ plan details and gz-style XLSX

## Source and journeys

The journeys were derived from the user-approved implementation plan in this Codex task.

- An analyst receives authoritative EPZ plan-card fields instead of incomplete search-list data.
- A manager opens a familiar gz-plans-style workbook with separate plans, tenders and control sheets.
- A Bitrix dry-run remains safe and completes duplicate checks even when many deals share one amount.

## RED / GREEN checkpoints

- RED commit: `829fe17` (`test: add red coverage for EPZ plan details`).
- RED command: `npm test -- --run tests/kz/procurementPlanDetail.test.ts tests/kz/procurementFilter.test.ts tests/kz/procurementStorage.test.ts tests/kz/procurementWorkbook.test.ts`.
- RED evidence: 4 suites failed because `planDetail` did not exist, new classification reasons were absent, plan details were not persisted and the workbook still had four legacy sheets.
- GREEN commit: `cf07974` (`feat: enrich EPZ plan details and export gz-style workbook`).
- GREEN command: the same targeted suite; result 5 files and 20 tests passed after adding the Goszakup contact test.

## Guarantees

| Guarantee | Test/evidence | Type | Result |
|---|---|---|---|
| Card `18121209` yields code `262030.100.000021`, BIN, quantities, prices, date and deliveries | `tests/kz/procurementPlanDetail.test.ts` | Unit/integration fixture | PASS |
| Detail requests are deduplicated, retried and identity-checked | `tests/kz/procurementPlanDetail.test.ts` | Unit | PASS |
| Failed or mismatched detail requests block completeness and remain in Review | `tests/kz/procurementPlanDetail.test.ts`, `tests/kz/procurementFilter.test.ts` | Unit | PASS |
| Plan-detail JSON survives SQLite upsert/read | `tests/kz/procurementStorage.test.ts` | Integration | PASS |
| Goszakup contacts are added only by confirmed BIN without replacing EPZ provenance | `tests/kz/procurementGoszakupEnrichment.test.ts` | Unit | PASS |
| Workbook contains `Планы`, `Тендеры`, `Review`, `Rejected`, `Summary`, joined deliveries, text IDs and readable row heights | `tests/kz/procurementWorkbook.test.ts` | XLSX integration | PASS |
| Duplicate checking falls back to narrow ID/BIN searches after an amount-page overflow | `tests/bitrix/procurementClient.test.ts` | Unit | PASS |

## Real control run

- Collection: 11,756 records, 152 pages, `complete=true`.
- Detail enrichment: 412 requested, 412 succeeded, 0 failed, 0 identity mismatches.
- Classification: Data 384, Review 32, Rejected 11,340; 384 rows promoted to Data after detail.
- Workbook: five sheets; `Планы` 383 rows, `Тендеры` 1 row, `Review` 32 rows, `Rejected` 11,340 rows.
- Card `18121209` was found on `Планы!R384` with the expected code, BIN, quantity, unit price, amount and two source delivery entries.
- Formula-error scan returned zero matches.
- Final Bitrix dry-run: 384 create, 0 update, 0 duplicate, 0 failed. `--execute` was not used; no deals were created.

## Final validation and coverage

- `npm run lint`: PASS.
- `npm test`: 70 files passed, 566 tests passed; one pre-existing optional dashboard E2E test remained skipped.
- `npm run test:coverage`: PASS.
- Changed procurement module line coverage: `planDetail.ts` 96.53%, `filter.ts` 98.7%, `workbookModel.ts` 94.59%, `workbookWriter.ts` 100%, `storage.ts` 100%, `goszakupEnrichment.ts` 100%.
- `procurementClient.ts` line coverage: 93.84%.

No production Bitrix writes, historical workbook rewrites or unrelated worktree changes were performed.
