# GZ duplicate detection — BIN + amount false positives

## Source and user journey

Found while reviewing run `20260715-120949`, where 4 of 76 plan rows were
blocked as duplicates of a single deal.

As a Bitrix importer operator, I want BIN + amount collisions to be surfaced as
a warning instead of blocking creation, so that distinct plan points from one
customer at an identical price still become deals.

## The defect

Rows 10-13 of `runs/20260715-120949/plans.xlsx` are four separate interactive
panels planned by ГУ «Отдел образования по Алакольскому району» (BIN
101240006118), each at exactly 1 500 000 KZT, with distinct ENSTRU codes
(`279020.100.000002/3/5/7`) and distinct plan points (87359412, 87356923,
87356225, 87356141).

All four were blocked against deal 40687, which is a different plan point
entirely: `UF_CRM_PLAN_ID=87121624`, `UF_CRM_6A436D5A3614C=4801277`, plan link
`show_plan/87268408/4801277`. Deal 40687 was the only deal for that BIN, so the
sole reason for the collision was the last and weakest search rule — BIN +
amount. Every exact identity rule correctly declined to match.

Canonical plan IDs were not implicated: the four rows share legacy URL segment
`4813388` and are correctly separated by [[gz-plan-id-conflict]].

## RED / GREEN report

- RED command:
  `npx vitest run tests/bitrix/gzDuplicateSearch.test.ts`
- RED evidence: 3 of 6 tests failed against the current rule set extracted
  verbatim — `BIN + amount` reported `blocking: true`, the blocking rule list
  had 5 entries instead of 4, and deal 40687 matched row 10 through a blocking
  rule.
- GREEN command: same.
- GREEN evidence: 6 tests passed.
- Full regression command: `npm test`
- Full regression evidence: 35 files passed, 313 tests passed (was 34 / 307).
- Typecheck command: `npm run lint`
- Typecheck evidence: exit code 0.

## Test specification

| Guarantee | Test / validation | Type | Result |
|---|---|---|---|
| BIN + amount is advisory, never blocking | `tests/bitrix/gzDuplicateSearch.test.ts` | Unit | PASS |
| Every exact identity rule stays blocking | `tests/bitrix/gzDuplicateSearch.test.ts` | Unit | PASS |
| Exact rules are ordered before the fuzzy fallback | `tests/bitrix/gzDuplicateSearch.test.ts` | Unit | PASS |
| A sibling plan point matches only via the advisory rule | `tests/bitrix/gzDuplicateSearch.test.ts` | Unit | PASS |
| BIN + amount is omitted when BIN or amount is unusable | `tests/bitrix/gzDuplicateSearch.test.ts` | Unit | PASS |
| Identity rules are omitted when their source field is empty | `tests/bitrix/gzDuplicateSearch.test.ts` | Unit | PASS |

## Coverage and dry-run evidence

- Focused coverage command:
  `npx vitest run tests/bitrix/gzDuplicateSearch.test.ts --coverage.enabled --coverage.include='src/bitrix/gzDuplicateSearch.ts'`
- `gzDuplicateSearch.ts`: 100% statements/branches/functions/lines.
- Repository-wide coverage remains below 80% because many CLI entrypoints have
  no direct tests; the new module exceeds the required threshold.
- Dry-run command:
  `npx tsx scripts/bitrix-push-gz-deals.mts --input runs/20260715-120949/plans.xlsx`
- Dry-run before: create 4, existing 58, duplicate 14, warnings 0.
- Dry-run after: create 8, existing 58, duplicate 10, warnings 4. The four
  Alakol rows now create and each carries
  `possible duplicate of deal 40687 (BIN + amount)`.
- The dry-run omitted `--execute`; no Bitrix records were created or updated.

## Plan number is the lineage key — `plan number` duplicates are valid

Confirmed against goszakup snapshots in `data/debug`, so the earlier note
calling these duplicates false positives was wrong and is retracted.

`№ пункта плана` (`plan_list_number`) is the **stable identity of a plan point
across revisions**. The canonical plan point id (first `show_plan` segment)
identifies **one revision**: goszakup mints a new record on every amendment
while the displayed number stays put. Evidence:

- `show_plan/86795650/4751746` heads `86795650: Комплект учебного оборудования`;
  `show_plan/87173984/4753515` heads `86795650: Доска специальная`. Same BIN,
  same delivery address, same `Панель интерактивная 75 дюймов`; the customer
  reclassified the item (ENSTRU `329959.900.000019` → `262030.100.000043`).
- Lineage `82425225` spans three records: `82425225` → `86979823` → `87306836`,
  content identical throughout.
- 46 of 76 rows in run `20260715-120949` are amendments (`№ пункта плана` !=
  `ID пункта (API)`); in the older exports it is nearly every row.

A lineage match is therefore a **valid blocking match**: deal 39149 sits at
`C41:PREPAYMENT_INVOIC`, and creating a second deal for row 21 would duplicate
live work. It stays blocking until step 4 introduces update semantics, which is
the real gap — an amendment's new name, ENSTRU or amount never reaches the CRM
today. See [gz-plan-number-backfill.tdd.md](gz-plan-number-backfill.tdd.md) for
the first migration step.
