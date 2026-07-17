# GZ plan ID conflict — TDD evidence

## Source and user journey

The behavior was derived from the approved conversation plan.

As a Bitrix importer operator, I want each Goszakup plan point to use the first
numeric `show_plan` URL segment, so distinct goods that share the old second
segment cannot block one another while exact legacy deals remain recognizable.

## RED / GREEN report

- RED command:
  `npm test -- --run tests/kz/gzPlanIdentity.test.ts tests/bitrix/gzPlanDealIdentity.test.ts tests/kz/goszakupPlanParser.test.ts tests/bitrix/gzOriginBackfill.test.ts`
- RED evidence: 4 suites failed. The parser returned `4797958` instead of
  `87230655`, backfill returned `4714749` instead of `86446786`, and the two new
  identity modules did not yet exist.
- GREEN command:
  `npm test -- --run tests/kz/gzPlanIdentity.test.ts tests/bitrix/gzPlanDealIdentity.test.ts tests/kz/goszakupPlanParser.test.ts tests/bitrix/gzOriginBackfill.test.ts tests/bitrix/gzDuplicateHygiene.test.ts tests/bitrix/gzPlansPushFields.test.ts`
- GREEN evidence: 6 files passed, 45 tests passed.
- Full regression command: `npm test`
- Full regression evidence: 34 files passed, 307 tests passed.
- Typecheck command: `npm run lint`
- Typecheck evidence: exit code 0.

## Test specification

| Guarantee | Test / validation | Type | Result |
|---|---|---|---|
| The first `show_plan` segment is canonical | `tests/kz/gzPlanIdentity.test.ts` | Unit | PASS |
| One-segment and legacy two-segment links remain supported | `tests/kz/gzPlanIdentity.test.ts` | Unit | PASS |
| Two rows sharing the old second segment get distinct origins | `tests/bitrix/gzPlanDealIdentity.test.ts` | Unit | PASS |
| Exact legacy deals match by URL or, when URL is absent, plan number | `tests/bitrix/gzPlanDealIdentity.test.ts` | Unit | PASS |
| A sibling legacy deal cannot block a different canonical plan point | `tests/bitrix/gzPlanDealIdentity.test.ts` | Unit | PASS |
| Parser, backfill, duplicate hygiene and lead fields use canonical IDs | Existing focused suites | Integration/unit | PASS |
| Both current workbooks contain 296 unique canonical origins | Read-only XLSX validation | Data validation | PASS |

## Coverage and dry-run evidence

- Focused coverage command:
  `npx vitest run tests/kz/gzPlanIdentity.test.ts tests/bitrix/gzPlanDealIdentity.test.ts --coverage`
- `gzPlanIdentity.ts`: 100% statements/functions/lines, 95.45% branches.
- `gzPlanDealIdentity.ts`: 100% statements/functions/lines, 90% branches.
- Repository-wide coverage remains below 80% because many CLI entrypoints have
  no direct tests; the two new identity modules exceed the required threshold.
- Workbook check: 296 rows, 296 canonical origins, zero canonical duplicate
  keys; the old spreadsheet IDs had 275 unique values and 21 duplicate keys.
- Panels dry-run: 81 checked, create 1, existing 69, duplicate 11, skipped 0,
  issues 0, warnings 0.
- PC dry-run: 215 checked, create 177, existing 1, duplicate 36, skipped 1,
  issues 1, warnings 0. The sole issue is the previously known missing customer
  in row 205 (`gz-plan:87017072`).
- Both dry-runs omitted `--execute`; no Bitrix records were created or updated.

No checkpoint commits were created because the worktree already contained
unrelated user changes overlapping the importer; RED/GREEN evidence is retained
in this report without staging or committing those changes.
