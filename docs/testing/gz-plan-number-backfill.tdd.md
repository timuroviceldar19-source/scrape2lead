# GZ plan number backfill — step 1 of the lineage migration

## Source and user journey

Approved conversation plan, step 1 only. Steps 2-4 (resolving existing
duplicate pairs, switching origin to the lineage key, update semantics) are
explicitly out of scope.

As a Bitrix importer operator, I want every GZ plans deal to carry its
`№ пункта плана`, so the importer's `plan number` duplicate rule can see the
deals created before that field was populated.

## Why this is the first step

The `plan number` rule keys on `UF_CRM_PLAN_ID`. 85 GZ plans deals had it
empty, so the rule was blind to them: when goszakup amended their plan point,
the importer saw a new procurement and created a second deal. 20 of the 22
duplicate pairs in the CRM are exactly this — the older member lacks the field.
Backfilling it stops that class of duplication without touching origin, stages
or the pairs themselves. See
[gz-duplicate-bin-amount.tdd.md](gz-duplicate-bin-amount.tdd.md) for the
lineage semantics this rests on.

## Candidate set — deviation from the brief

The brief specified "deals of known GZ originators". Taken literally that
includes `scrape2lead-gz-lots`, whose 100 deals all have an empty
`UF_CRM_PLAN_ID` and no `show_plan` link at all — a lot has no plan number.
Including them yields 185 candidates of which 100 are permanently unresolvable,
and the brief's own "refuse execute while anything is unresolved" rule would
then block execute forever. `GZ_PLAN_ORIGINATOR_IDS` is therefore
`scrape2lead-gz-plans` only; the `*:DUPLICATE` stage exclusion is kept.

The brief's baseline of 86 candidates (75 local) did not reproduce. The live
set measured 85 candidates: 74 resolvable from local snapshots and 11 needing
Playwright. The Playwright figure matches; the other two are one lower.

## RED / GREEN report

- RED command: `npx vitest run tests/bitrix/gzPlanNumberBackfill.test.ts`
- RED evidence: 14 of 26 tests failed against a module skeleton whose exported
  signatures returned empty values, so each failure landed on behavior rather
  than on a missing import.
- GREEN command: same.
- GREEN evidence: 28 tests passed (26 plus 2 added for uncovered branches).
- Full regression command: `npm test`
- Full regression evidence: 36 files passed, 341 tests passed.
- Typecheck command: `npm run lint`
- Typecheck evidence: exit code 0.

## Test specification

| Guarantee | Test / validation | Type | Result |
|---|---|---|---|
| Canonical and legacy URL segments are told apart | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| The snapshot is keyed by the legacy segment | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| The number is read from a real `<h3>86795650: …</h3>` | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| A real goszakup snapshot parses end to end | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Integration | PASS |
| The site announcement heading is ignored | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| Empty, non-numeric and ambiguous headings are rejected | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| Filled, foreign and `*:DUPLICATE` deals are skipped | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| The update payload holds only `UF_CRM_PLAN_ID` | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| The local snapshot wins over a live fetch | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| Execute is refused on unresolved entries or an empty report | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| Drift in number, link or stage is refused | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| A re-run changes nothing | `tests/bitrix/gzPlanNumberBackfill.test.ts` + live re-run | Unit + live | PASS |

## Coverage

- Command: `npx vitest run tests/bitrix/gzPlanNumberBackfill.test.ts --coverage.enabled --coverage.include='src/bitrix/gzPlanNumberBackfill.ts'`
- `gzPlanNumberBackfill.ts`: 100% statements/functions/lines, 93.18% branches.
- Repository-wide coverage remains below 80% because many CLI entrypoints have
  no direct tests; the new module exceeds the required threshold.

## Dry-run, execute and post-audit evidence

- Dry-run command: `npm run bitrix:backfill-gz-plan-number`
- Dry-run result: 539 deals, 85 candidates, 74 resolved from local snapshots,
  11 fetched in a single Playwright session and cached into `data/debug`,
  0 unresolved. Report: `data/gz-plan-number-backfill-20260715-091207.json`.
- Report validation: 85 resolved == 85 candidates, every deal id / canonical id
  / plan number numeric, no `*:DUPLICATE` stage present, no repeated deal id,
  no plan number colliding inside the report. 53 of 85 are amended lineages
  (`planNumber != canonicalPlanPointId`).
- Execute command:
  `npx tsx scripts/bitrix-backfill-gz-plan-number.mts --execute --report data/gz-plan-number-backfill-20260715-091207.json`
- Execute result: `written=85 skipped_already_filled=0 drifted=0 failed=0`.
- Post-audit: all 85 deals re-read from Bitrix. 85/85 carry the plan number
  from the report. `TITLE`, `CATEGORY_ID`, `STAGE_ID`, `ORIGINATOR_ID`,
  `ORIGIN_ID`, `UF_CRM_PLAN_LINK` and `UF_CRM_6A436D5A3614C` were compared
  against their pre-execute values: 0 fields changed. GZ plans deals still
  missing a plan number: 0 of 539.
- Idempotency: re-running execute against the same report gave
  `written=0 skipped_already_filled=85 drifted=0 failed=0`, exit 0.
- A dry-run over the now-empty candidate set reports "nothing to backfill" and
  exits 0; only an unresolved candidate makes the dry-run exit non-zero.

## Follow-up, not done here

Filling the field does not remove the 22 existing duplicate pairs — it exposes
them and stops new ones. Resolving those pairs is step 2, switching origin to
the lineage key is step 3, and update semantics for amendments is step 4.
11 deals had no local snapshot and were resolved live; their pages are now
cached in `data/debug`.
