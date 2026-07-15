# GZ plan number backfill — incident and correction

## What this file is

The 20260715 backfill (`c737286`) wrote `UF_CRM_PLAN_ID` to 85 GZ plans deals.
74 of those values were read from a cache that could not tell one plan point
from another, and **24 of the 74 were wrong**. This file records the defect, the
correction, and what of the original reasoning survives.

The original intent stands: the `plan number` duplicate rule keys on
`UF_CRM_PLAN_ID`, deals with it empty were invisible to the rule, and filling it
stops that class of duplication. Only the *resolution* was defective.

## The defect

A plan link is `show_plan/{canonical point id}/{legacy segment}`. The backfill
resolved the number like this:

```ts
// src/bitrix/gzPlanNumberBackfill.ts, as shipped in c737286
snapshotId: identity.legacyPlanId
```

and read `data/debug/goszakup-plan-detail-{legacyPlanId}.html`.

**The legacy segment is not an identity.** Several canonical plan points share
one, and the cache file is named after it alone — nothing in the file records
which point it was fetched for. So the value read under that key is evidence
about *neither* point. The original test suite asserted this keying as a
guarantee ("the snapshot is keyed by the legacy segment"), which is why the
defect passed review with 28 green tests.

Measured in the live CRM on 2026-07-15: **26 legacy segments are each shared by
two different canonical plan points**. In 15 of those pairs both deals ended up
carrying an identical `UF_CRM_PLAN_ID` — the twin's. That is the worst possible
failure for this field: the duplicate rule keys on it, so the backfill fused two
distinct plan points into one apparent lineage, manufacturing exactly the false
duplicates it was meant to expose.

The report's own validation ("no plan number colliding inside the report") could
not see this: in each pair only one deal was a candidate, so the collision was
between a candidate and a deal outside the report.

## The correction

- `snapshotId` is gone. `resolveGzPlanNumberSource` now returns the canonical
  point and the legacy segment for provenance only, and offers no cache key at
  all. The legacy cache is never read again.
- `planGzPlanNumberBackfill` no longer resolves anything from disk; it emits one
  fetch target per candidate, so two deals can never share a page load.
- `src/kz/gzCanonicalPlanPage.ts` holds the canonical-page primitives: pages are
  cached at `data/canonical/gz-plan-point/gz-plan-point-{canonical id}.html`,
  and a page is only accepted after the browser's **final** URL is confirmed to
  carry the requested point — a redirect to a sibling is rejected, not cached.
- `src/bitrix/gzPlanNumberCorrection.ts` + `scripts/bitrix-correct-gz-plan-number.mts`
  re-verify the 74 suspect deals against their own pages, and write only
  `UF_CRM_PLAN_ID` after a second, independent load agrees with the report.
- The legacy cache is kept intact as forensic evidence and marked untrusted in
  [gz-legacy-plan-snapshot-cache.md](gz-legacy-plan-snapshot-cache.md).

## RED / GREEN report

- RED command:
  `npx vitest run tests/kz/gzCanonicalPlanPage.test.ts tests/bitrix/gzPlanNumberCorrection.test.ts tests/bitrix/gzPlanNumberBackfill.test.ts`
- RED evidence: 33 of 62 tests failed against module skeletons whose exported
  signatures returned empty values, so each failure landed on behavior rather
  than on a missing import.
- GREEN command: same. GREEN evidence: 62 tests passed.
- Full regression command: `npm test`
- Full regression evidence: 38 files passed, 375 tests passed (was 36 / 341).
- Typecheck command: `npm run lint`. Evidence: exit code 0.

## Test specification

| Guarantee | Test / validation | Type | Result |
|---|---|---|---|
| Two canonical points sharing a legacy segment never share a page | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| The module exposes no legacy-derived cache key at all | `tests/bitrix/gzPlanNumberBackfill.test.ts` | Unit | PASS |
| The cache key is the canonical point, in its own namespace | `tests/kz/gzCanonicalPlanPage.test.ts` | Unit | PASS |
| A redirect to a sibling point is rejected, not read | `tests/kz/gzCanonicalPlanPage.test.ts` | Unit | PASS |
| A page that left the registry is rejected | `tests/kz/gzCanonicalPlanPage.test.ts` | Unit | PASS |
| The number is read from a real `<h3>86795650: …</h3>` | `tests/kz/gzCanonicalPlanPage.test.ts` | Unit | PASS |
| Announcement, empty, non-numeric and ambiguous headings are rejected | `tests/kz/gzCanonicalPlanPage.test.ts` | Unit | PASS |
| A maintenance page answering 200 yields nothing | `tests/kz/gzCanonicalPlanPage.test.ts` | Unit | PASS |
| Old and live values are both recorded per deal | `tests/bitrix/gzPlanNumberCorrection.test.ts` | Unit | PASS |
| Execute is blocked while anything is unresolved | `tests/bitrix/gzPlanNumberCorrection.test.ts` | Unit | PASS |
| Drift in any control field blocks the write | `tests/bitrix/gzPlanNumberCorrection.test.ts` | Unit | PASS |
| A write needs a fresh load agreeing with the report | `tests/bitrix/gzPlanNumberCorrection.test.ts` | Unit | PASS |
| The update payload holds only `UF_CRM_PLAN_ID` | both module tests | Unit | PASS |
| A repeated execute only skips | `tests/bitrix/gzPlanNumberCorrection.test.ts` | Unit | PASS |

## Coverage

- Command:
  `npx vitest run tests/bitrix/gzPlanNumberCorrection.test.ts tests/kz/gzCanonicalPlanPage.test.ts --coverage.enabled --coverage.include='src/bitrix/gzPlanNumberCorrection.ts' --coverage.include='src/kz/gzCanonicalPlanPage.ts'`
- `gzPlanNumberCorrection.ts`: 100% statements/functions/lines, 87.75% branches.
- `gzCanonicalPlanPage.ts`: 100% statements/branches/functions/lines.
- Repository-wide coverage remains below 80% because many CLI entrypoints have
  no direct tests; both new modules exceed the required threshold.

## Live correction report — 74 deals, read-only

- Command:
  `npx tsx scripts/bitrix-correct-gz-plan-number.mts --source data/gz-plan-number-backfill-20260715-091207.json`
- Result: `verified=74 wrong=24 unchanged=50 unresolved=0`.
- Report: `data/gz-plan-number-correction-20260715-095006.json`.
- Every deal's own `UF_CRM_PLAN_LINK` was opened in one Playwright session; all
  74 final URLs carried the requested canonical id; 74 pages were cached under
  `data/canonical/gz-plan-point/`; the 1419 legacy files were not touched.
- Report validation: no two verified deals resolve to the same live number, and
  no two canonical points produced the same page hash — the pages are genuinely
  point-specific, which the legacy cache could never demonstrate.
- All 15 twin pairs that shared a number are separated by the correction. The
  other 9 wrong values came from legacy segments shared with plan points that
  have no deal in the CRM.
- Wrong values were off by between 3 and 211368, so the defect was invisible to
  any eyeball check of "looks like a plan number".

**Not executed.** Writing the 24 replacements to Bitrix requires separate
explicit confirmation. The execute path, its post-audit and the re-run
idempotency claim are unproven against live data until then.

## What the original file claimed and this one does not

The superseded revision reported "85 written, 0 drifted, 0 failed; post-audit
confirms no other field changed and a re-run writes nothing". Those statements
were true as written — the writes did land and nothing else moved — but they
measured the *mechanics* of the write, never whether the value was right. A
post-audit that re-reads what you just wrote confirms only that you wrote it.
The audit added here re-derives the value from the deal's own canonical page
instead.

## Follow-up, not done here

Resolving the 22 existing duplicate pairs is step 2, switching origin to the
lineage key is step 3, and update semantics for amendments is step 4. Whether
the false lineages created by this defect produced additional duplicate pairs
has not been re-counted; that count is only meaningful after the correction is
executed.
