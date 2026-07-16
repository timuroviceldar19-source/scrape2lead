# GZ published deal stage — TDD evidence

## Source and user journeys

The source plan was supplied in the implementation request in this Codex task.

- As an operator, I want a newly published GZ deal moved into the matching pipeline's published stage.
- As a manager, I want deals already progressed or closed to remain in their current stage.
- As an administrator, I want an explicit, idempotent setup command for the three Bitrix stages.
- As an auditor, I want the first publication timestamp and stage decision preserved in reports.

## RED / GREEN report

| Behavior | RED evidence | GREEN evidence |
|---|---|---|
| Required routing mapping and stage decisions | Targeted run failed because `publishedStageId` was accepted when missing and `gzPublishedDealStage` did not exist | `npm test -- --run tests/bitrix/gzDealRouting.test.ts tests/bitrix/gzPublishedDealStage.test.ts`: 23 passed |
| Exact Bitrix update/no-op behavior | Targeted run failed with `applyPublishedDealUpdate is not a function` | Same targeted run passed, including mocked execute, dry-run, and no-op calls |
| Repository compatibility | N/A | `npm test`: 39 files and 400 tests passed; `npm run lint`: passed |
| CLI type safety | N/A | Standalone `tsc --noEmit` for `scripts/check-gz-deals-published.mts`: passed |
| Live read-only setup preview | N/A | `npm run kz:check-gz-deals-published -- --ensure-published-stages`: all categories reported `planned`; no writes requested |

## Test specification

| # | Guarantee | Test type | Result |
|---|---|---|---|
| 1 | Every route has a published stage and duplicate category mappings cannot conflict | Unit | PASS |
| 2 | Only an initial-stage deal receives the target `STAGE_ID` | Unit | PASS |
| 3 | Advanced, won, and lost deals are never moved backwards | Unit | PASS |
| 4 | Existing first-publication timestamps are preserved and current deals become no-ops | Unit | PASS |
| 5 | Setup previews, creates, verifies, detects conflicts before writes, and is idempotent | Mocked integration | PASS |
| 6 | Execute sends the exact calculated fields; dry-run and no-op send nothing | Mocked integration | PASS |

## Coverage and known gaps

`npx vitest run tests/bitrix/gzPublishedDealStage.test.ts --coverage --coverage.include=src/bitrix/gzPublishedDealStage.ts`:

- Statements/lines: 90.69%
- Branches: 88.09%
- Functions: 88.88%

No browser E2E test applies to this CLI-only workflow. The mutating live setup and deal update were not executed; rollout requires an explicit operator run with `--execute` after reviewing the successful preview.

## Merge evidence

- RED checkpoint: `8312c2e test: add published deal stage RED coverage`
- GREEN checkpoint: recorded by the subsequent implementation commit for this task.
