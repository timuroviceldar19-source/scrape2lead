# F3 procurement config propagation — TDD evidence

## Source and user journey

The journey was derived from the failed `F3 daily B2B collection` GitHub Actions runs on 2026-08-08.

As the F3 automation operator, I want the selected F3 procurement configuration to reach both the dry-run and production Bitrix push, so that an enabled F3 run is not rejected by the disabled default procurement configuration.

## Task report

- RED: `npm test -- tests/automation/orchestrator.test.ts` ran 34 tests; 2 failed because `procurement.json` was absent from the `dryRun` and `apply` calls.
- GREEN: `npm test -- tests/automation/orchestrator.test.ts tests/automation/procurementDependencies.test.ts` ran 40 tests; all passed after propagating the config path and testing the generated CLI arguments.
- Full verification: `npm run build` and `npm run lint` passed. `npm run test:coverage` passed with 790 tests, 4 skipped.

## Test specification

| # | What is guaranteed | Test target | Type | Result |
|---|---|---|---|---|
| 1 | F3 preparation passes its procurement config to the Bitrix dry-run adapter | `f3-b2b workflow > collects, dry-runs and reports without touching any GZ stage` | integration | PASS |
| 2 | F3 production delivery passes the same config to the Bitrix apply adapter | `f3-b2b workflow > pushes from the verified report once delivery mode is push` | integration | PASS |
| 3 | Production adapter CLI arguments include `--config` for dry-run and execute modes while preserving `--limit` | `procurement push arguments > passes the selected procurement config to dry-run and production push` | unit | PASS |

## Coverage and known gaps

- Repository coverage: 52.46% statements/lines, 76.51% branches, 81.89% functions.
- `src/automation/orchestrator.ts`: 96.72% statements/lines and 100% functions.
- The repository-wide line threshold is below 80% because many operational scripts are not executed by the unit suite; this change does not reduce that baseline.
- `npm audit --audit-level=high` reports existing transitive dependency advisories (8 high, 2 moderate, 1 low). Dependency upgrades were not included in this focused F3 fix.

## Merge evidence

- RED checkpoint: `9ecebd1 test: reproduce missing F3 procurement config propagation`
- GREEN checkpoint: `aadd8e6 fix: propagate F3 procurement config to Bitrix push`
