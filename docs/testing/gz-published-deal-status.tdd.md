# GZ published deal status — TDD evidence

## Source and user journeys

The source plan was supplied in the implementation request in this Codex task. It supersedes the
earlier stage-moving design: no `S2L_PUBLISHED` stages are created and `STAGE_ID` is never written.

- As an operator, I want a GZ deal that moved from «Утвержден» to «Опубликован» on Goszakup to have
  only its status fields refreshed in Bitrix.
- As a manager, I want every Bitrix stage and pipeline left untouched by the monitor.
- As a manager, I want deals with a different, empty, or already published status left alone.
- As an auditor, I want the first publication timestamp and the skip reason preserved in reports.
- As an operator, I want to inspect large result sets in non-overlapping batches without rechecking earlier deals.

## RED / GREEN report

| Behavior | RED evidence | GREEN evidence |
|---|---|---|
| Утвержден → Опубликован without `STAGE_ID` | `npx vitest run tests/bitrix/gzPublishedDealStatus.test.ts` failed: `Cannot find module '../../src/bitrix/gzPublishedDealStatus.js'` | Same targeted run: 14 passed |
| Skips for other, empty, and already published statuses | Covered by the same failing run | Same targeted run passed |
| Dry-run plans an update without calling Bitrix | Covered by the same failing run | Same targeted run passed, `updateDeal` mock never called |
| Routing config without `publishedStageId` | N/A | `npx vitest run tests/bitrix/gzDealRouting.test.ts`: passed |
| Non-overlapping `--offset` / `--limit` batches | Targeted run: 2 failed with `selectPublishedDealBatch is not a function` | Same targeted run: 16 passed |
| Repository compatibility | N/A | `npm test`: 42 files and 444 tests passed; `npm run lint` and `npm run build`: passed |
| CLI type safety | N/A | Standalone `tsc --noEmit` for `scripts/check-gz-deals-published.mts`: passed |
| Live read-only dry-run | N/A | 67 reports covered all 662 deals in batches of 10; no Bitrix writes were requested |

## Test specification

| # | Guarantee | Test type | Result |
|---|---|---|---|
| 1 | An approved deal gets «Опубликован» in both status fields and no `STAGE_ID` | Unit | PASS |
| 2 | No `STAGE_ID` is planned regardless of the stage the deal currently sits in | Unit | PASS |
| 3 | The legacy status field is repaired and the primary field falls back to it when empty | Unit | PASS |
| 4 | The first-publication timestamp is written once and then preserved | Unit | PASS |
| 5 | Other, empty, and already published statuses are skipped with a reason and no fields | Unit | PASS |
| 6 | Execute sends the exact calculated fields; dry-run and skipped deals send nothing | Mocked integration | PASS |
| 7 | A retired `publishedStageId` left in an existing routing config is ignored | Unit | PASS |
| 8 | Offset and limit select a stable non-overlapping batch, including the final partial batch | Unit + live read-only | PASS |

## Coverage and known gaps

`npx vitest run tests/bitrix/gzPublishedDealStatus.test.ts --coverage --coverage.include=src/bitrix/gzPublishedDealStatus.ts`:

- Statements/lines: 100%
- Branches: 100%
- Functions: 100%

No browser E2E test applies to this CLI-only workflow. The mutating deal update was not executed;
rollout requires an explicit operator run with `--execute` after reviewing the dry-run report.
