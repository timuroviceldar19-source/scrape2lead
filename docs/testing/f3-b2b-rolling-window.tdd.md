# TDD evidence: F3 B2B rolling window and daily automation

## Source and journeys

Derived from the user-approved plan for the daily F3 B2B collection.

- Collect the current month plus the next six from the external sources (Samruk, MITWORK, Tizilim); goszakup stays out of F3 and keeps its own B2G pipelines.
- Take the plan year from the plan item itself, never from a technical load timestamp.
- Keep records whose month the source never publishes, and count them rather than dropping them.
- Distinguish "the source has no such record" from "the request failed".
- Give a plan its approval date in a dedicated field and reserve `BEGINDATE`/`CLOSEDATE` for a published tender's offer window.
- Run F3 on its own schedule and its own lock, so a stuck GZ collection cannot block it, and keep sending switched off until a separate change enables it.
- Audit the existing category-1 cards read-only; never delete or close anything automatically.

## The defect this work fixes

`parseEpzPlanDetail` derived both the plan year and the approval date from `row.timestamp`
(`src/kz/procurement/planDetail.ts:101-103,117` before the fix). Measured against the live EPZ API:

| Probe | Result |
|---|---|
| `plan_year_id=9` — the value in `config/procurement-sources.json` | `year.year = 2024` |
| `plan_year_id=12` | `year.year = 2026` |
| `plan_year_id=13` | no rows — 2027 is not open yet |
| `plan_year_id=11` | unused — the dictionary is **not** contiguous, so `year = id + 2015` must never be hardcoded |
| plan item `19354222` (2024) and `20920336` (2026) | identical `timestamp: 1776236804` |

So the pipeline was collecting the **2024** plan year while labelling every record 2026, and every
card carried a `BEGINDATE` derived from the batch load stamp. `tests/fixtures/kz/procurement/plan-item-18121209.json`
is itself a 2024 record, and the previous test asserted `financialYear: 2026` — the defect was
encoded in the test suite.

Also measured, and shaping the design:

- `decree_date` is `null` in every sampled record: EPZ does not currently publish an approval date.
- `month` is `null` in 7 of 7 sampled approved 2026 items, and can arrive as an object rather than a scalar, so it is parsed as `month?.id ?? month_id ?? null` and treated as normally unknown.
- Plan-item statuses on system 2/3 are: 1 Черновик, 2 Утвержден, 3 Заявка, 4 Проект лота, 5 Опубликован, 7 Отменен, 11 Приостановлен. There is no cameral-control status; `status_id__in=444` (the goszakup id) returns 0 rows. Cameral control is a state-budget concept living on goszakup, which F3 excludes.
- List rows carry `plan_year_id` as an **array** (`[12]`), and lot rows expose only `plan_items[].id` — no `external_id`.

## RED/GREEN evidence

| Guarantee | Test target | RED evidence | GREEN evidence |
|---|---|---|---|
| Two records sharing one load timestamp yield different plan years | `tests/kz/procurementPlanDetail.test.ts` | 4 intended failures, incl. `expected '2026-04-15' to be null` | 11/11 passed |
| The approval date comes from `decree_date` and is null when absent | `tests/kz/procurementPlanDetail.test.ts` | Same run | 11/11 passed |
| The month is read from an object, a scalar id, or neither | `tests/kz/procurementPlanDetail.test.ts` | `expected undefined to be 2` | 11/11 passed |
| 404 means "absent" — one attempt, no incomplete collection; 5xx retries then fails the run | `tests/kz/procurementPlanDetail.test.ts` | Errors were indistinguishable before `ProcurementHttpError` | 11/11 passed |
| A detail contradicting the year it was collected under blocks production | `tests/kz/procurementPlanDetail.test.ts`, `tests/kz/procurementReleaseGate.test.ts` | Modules missing | 11/11 and 4/4 passed |
| The window covers the current month plus six, across a year boundary | `tests/kz/procurementPlanPeriod.test.ts` | Module missing | 8/8 passed |
| An unknown month is admitted and counted; a known month outside the window is rejected | `tests/kz/procurementPlanPeriod.test.ts`, `tests/kz/procurementFilter.test.ts` | Module missing | 8/8 and 15/15 passed |
| `plan_year_id` is resolved by probing the source; a contradicted override blocks, a 5xx blocks, an unopened future year only warns | `tests/kz/procurementPlanYears.test.ts` | Module missing | 7/7 passed |
| Plan statuses come from config as an allow-list | `tests/kz/procurementFilter.test.ts`, `tests/kz/procurementConfig.test.ts` | Literal `"утвержден"` was hardcoded | 15/15 and 3/3 passed |
| A new plan sends no `BEGINDATE`; a legacy update requests clearing it; a tender uses the offer window | `tests/bitrix/procurementDealPlan.test.ts` | 4 intended failures, incl. `expected { … } to not have property "BEGINDATE"` | 11/11 passed |
| `UF_CRM_PLAN_APPROVED_AT` is provisioned idempotently, outside the daily run | `tests/bitrix/procurementUserFields.test.ts`, `tests/bitrix/procurementDealLayout.test.ts` | Module missing | 3/3 and 2/2 passed |
| `f3-b2b` runs collect → dry-run → report and touches no GZ stage; old workflows still run without the adapter | `tests/automation/orchestrator.test.ts` | Workflow value did not exist | 34/34 passed |
| A scheduled run stops at `ready` while delivery mode is `prepare` | `tests/automation/orchestrator.test.ts` | Would have reached apply and failed on `executeEnabled: false` | 34/34 passed |
| Paths and counts come from one machine-readable line, not a regex over pretty JSON | `tests/automation/procurementDependencies.test.ts` | `parseCounts` matched `word=digits` anywhere | 5/5 passed |
| F3 has its own lock and its own delivery mode; PK/main keep sharing theirs | `tests/automation/config.test.ts` | Config did not exist | 12/12 passed |
| Worker cron map and `wrangler.jsonc` agree both ways; the backstop slot is absent from the Worker | `tests/cloudflare/githubDispatchWorker.test.ts` | New slot unmapped | 18/18 passed |
| The card audit reports several independent findings and issues no writes | `tests/bitrix/procurementCardAudit.test.ts` | Module missing; first draft collapsed a plan and its tender onto one lookup key | 10/10 passed |
| Remediation never sends `STAGE_ID`/`ASSIGNED_BY_ID` and executes only against the audit it was built from | `tests/bitrix/procurementRemediation.test.ts` | Module missing; the first wiring verified a plan against its own body, making the check vacuous | 7/7 passed |
| Migration v23 adds the plan period columns without dropping rows | `tests/kz/migrations.test.ts` | Schema head was 22 | 7/7 passed |

## Validation

- `npm test` — PASS: 704 passed, 4 skipped, 84 files.
- `npm run lint` (`tsc --noEmit`) — PASS.
- `npm run build` — PASS.
- `npm run cloudflare:check` — PASS.
- Live collection (`Ноутбук`, full page limit) — PASS: resolved `plan_year:2026 → 12`, `year_conflicts=0`, 53 collected / 41 accepted / 8 review / 4 rejected, `month_unknown=51`.
- Two consecutive orchestrator dry-runs on the same upstream — PASS: identical composition (53/41), `failed=0`, `new=41` both times. A dry-run creates nothing, so `create=0` is impossible here by construction; it becomes the real dedup check only after the first approved execute.
- Live read-only card audit — PASS: **43 deals, all 43 `wrong_plan_year`, all 43 carrying a stale `BEGINDATE`**, 0 status changes, 0 missing upstream, 0 unparsable origins. Every card is a 2024 Samruk plan still `Утвержден` upstream, sitting at `C1:NEW`.
- Remediation dry-run against that audit — PASS: `update=0, skip=43`; every card needs a human decision, so nothing is rewritten.
- Remediation guard — PASS: `--execute` without `--plan` is refused; `--execute` against a modified audit file is refused with a hash mismatch.

## Known constraints

- `plan_year_id` is resolved by probing the live dictionary each run, with `planYearIds` in config as a validated hint. 2027 is not yet open; that is reported as a warning, not a failure.
- EPZ publishes no approval date (`decree_date` is always null so far), so `UF_CRM_PLAN_APPROVED_AT` will stay empty until the source starts filling it. It is created anyway so the field is correct by construction on the day it does.
- The plan month is normally unknown, so the window is enforced at year granularity and refined by month only when the source supplies one.
- Cameral control is declared in config with `id: null` and reported in every run summary as unavailable; it does not block collection.
- The tender→plan link relies on `plan_items[0].id`, since EPZ exposes no `external_id` there. If that changes, tenders would fork new cards instead of updating their plan.
- Switching from `plan_year_id=9` to the resolved 2026 id changes the record population wholesale — for a single keyword, 132 rows against 51. The first F3 run looks like a collapse in volume; it is the fix, not a regression.

## Cutover evidence

- Seven corrected-config runs completed with identical accepted sets: 7,639 collected, 156 data,
  22 review, 7,461 rejected, `yearConflicts=0`, `duplicate=0`, and `failed=0` in every run.
- `UF_CRM_PLAN_APPROVED_AT` was created and the category-1 layout was applied.
- A controlled deal verified the robot assignment `1 → 2255`; the test deal was then deleted.
- The 43 legacy cards were preserved and refreshed from their real 2024 records without changing
  stage or assignee. Bitrix accepted all updates but did not clear its system `BEGINDATE`, even when
  retested through the recommended `crm.item.update` with `begindate: null`; this is a confirmed
  portal/API limitation, not an unreported remediation success.
- Production sending is enabled (`executeEnabled: true`, `deliveryMode: "push"`). The first execute
  created 133 deals, classified 23 as duplicates, failed 0, and passed assignment verification.
  The immediate follow-up dry-run proved idempotency with `create=0`.
- Final verification: 707 tests passed / 4 skipped across 84 files; lint, build, and
  `cloudflare:check` passed.
- Coverage run passed, but repository-wide statement/line coverage is 52.4% because CLI scripts,
  generated compatibility fixtures, and temporary utilities are included. The changed procurement
  modules are covered materially above the project aggregate (`src/kz/procurement`: 95.79% lines;
  `src/bitrix/procurementRemediation.ts`: 98.5% lines). Raising the global repository baseline to
  80% is a separate test-infrastructure task.
- `npm audit --audit-level=high` reports 17 high transitive findings in the existing
  `exceljs`/`wrangler`/coverage dependency trees. The complete suggested repair requires
  `npm audit fix --force` with breaking dependency changes, so it was not folded into the
  production cutover.
