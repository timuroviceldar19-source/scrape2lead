# F3-B2B procurement rollout

## Collect and review

```powershell
npx tsx scripts/kz-export-procurement.mts --config config/procurement-sources.json
```

Open the generated workbook under `output/procurement`. Only `Data` is CRM-eligible. `Review`
contains missing BIN/code/status and ambiguous panel matches; `Rejected` contains minimum-sum,
stop-list, code/product and inactive-status removals.

## Read-only Bitrix dry-run

```powershell
npx tsx scripts/bitrix-push-procurement.mts --report output/procurement/<run>.json
```

This checks existing origins and cross-source duplicate candidates but does not write deals.

## Category-1 card and robot

Apply and verify the common procurement card layout:

```powershell
npm run bitrix:apply-procurement-layout
npm run bitrix:apply-procurement-layout -- --execute
```

In Bitrix automation for pipeline `F3-B2B тендеры` (`CATEGORY_ID=1`), stage `C1:NEW`, configure
the “Изменить ответственного” robot with the concrete user `2255` (Саматбек Нурматов). Both
absence and completed-workday skipping must be disabled so every new deal is assigned to him.
The integration does not set `ASSIGNED_BY_ID`; `OPENED=Y` is set on every new or updated deal.

Create a controlled test deal and verify that:

1. the responsible user changes from the webhook user to `2255`;
2. the deal appears under Саматбек Нурматов’s “Мои” filter;
3. “№ пункта плана” and “Ссылка на План” are visible in the card.

Record each clean manual run in `data/procurement-manual-runs.json`:

```json
[
  {
    "runId": "2026-07-22-run-1",
    "irrelevantProducts": 0,
    "automaticDuplicates": 0,
    "assignmentVerified": true
  }
]
```

After seven clean unique runs, explicitly set `bitrix.executeEnabled` to `true` in
`config/procurement-sources.json` and invoke the push with `--execute`. Only after that gate is
proven should a daily scheduled task be installed.

## Current public-source limitations

Tizilim publicly exposes tender search, but the tested public plan endpoints return HTTP 404.
Therefore Tizilim tenders are collected; Tizilim plan data remains unavailable without a
documented public endpoint or authorized account. EPZ supplies both plans and tenders for
MITWORK and Samruk while excluding Goszakup (`system_id=1`).

**The plan-year dictionary is not contiguous and must never be computed from the id.**
Measured: `plan_year_id=9 → 2024`, `10 → 2025`, `11` unused, `12 → 2026`, `13` not yet open.
The year is resolved at run time by `resolveEpzPlanYearIds` (`src/kz/procurement/planYears.ts`),
which probes the source and treats `planYearIds` in config as a hint to validate, not to trust.
A contradicted hint or a transport failure blocks the run; a future year that is not open yet
is only a warning. Re-pin `planYearIds` when a new year opens.

**EPZ publishes no approval date.** `decree_date` is null in every sampled record, so
`UF_CRM_PLAN_APPROVED_AT` stays empty for now. The plan year comes from `year.year` and never
from `row.timestamp`, which is a shared batch stamp: records from different years carry the
same value.

**The plan month is normally absent.** `month`/`month_id` are null in practice and `month` can
arrive as an object. The rolling window is therefore enforced at year granularity and refined by
month only when the source supplies one; unknown months are counted as `month_unknown`.

**Cameral control does not exist on EPZ.** Plan-item statuses on system 2/3 are Черновик,
Утвержден, Заявка, Проект лота, Опубликован, Отменен, Приостановлен. The status is declared in
config with `id: null`, is reported in every run summary as unavailable, and does not block collection.

## Daily F3 automation

The daily run is `config/automation.f3.json` (`workflow: f3-b2b`), scheduled by
`.github/workflows/f3-daily.yml` at 09:10 Almaty with a 10:10 backstop, and dispatched externally by
the Cloudflare Worker on the primary slot only — the backstop must stay out of the Worker, because a
`workflow_dispatch` bypasses the guard that skips an already-collected day.

F3 has its own concurrency group (`f3-automation`) and its own lock (`runs/f3/prepare.lock`), so a
stuck or failing GZ collection cannot block it, and it never touches a GZ stage.

F3 production delivery was enabled on 2026-07-27: `deliveryMode` is `push` and
`bitrix.executeEnabled` is `true`. The cutover used seven clean dry-runs on the corrected config,
provisioned `UF_CRM_PLAN_APPROVED_AT`, verified the assignment robot with a controlled deal, and
completed the first production execute. Runs before the plan-year fix did not count — they
collected 2024.

```bash
npm run automation:f3     # collect -> dry-run -> f3-report.txt
npm run f3:export         # collection only
npm run f3:push           # Bitrix dry-run; --execute is gated
npm run f3:audit          # read-only audit of the existing category-1 cards
npm run f3:remediate      # dry-run; --execute needs --plan from a previous dry-run
```

## Existing category-1 cards

A read-only audit on 2026-07-27 found **43 deals, all 43 with the wrong plan year** — every one is a
2024 Samruk plan, still `Утвержден` upstream, sitting at `C1:NEW`, and carrying a `BEGINDATE`
derived from the load timestamp. None were superseded by a tender; none had a changed status or a
missing upstream record.

They are **not** repaired by the daily run: a 2026/2027 window never collects their keys. Deciding
what to do with them is a separate, human call. `npm run f3:remediate` currently skips all 43 for
exactly that reason, and its `--execute` path refuses to run except against the audit file its plan
was built from, never sends `STAGE_ID` or `ASSIGNED_BY_ID`, and never deletes or closes anything.

The cutover decision was to preserve the 43 still-approved plans, refresh their fields from the
2024 upstream records, and leave stage/assignee untouched. The hash-bound execute updated all 43
without API failures. Bitrix nevertheless retains the old system `BEGINDATE`: both the legacy
`crm.deal.update` with an empty string and the recommended `crm.item.update` with `begindate: null`
returned success but a subsequent read returned the original date. New plan cards do not send a
begin date, so this limitation is confined to these legacy cards; the dedicated approval-date field
remains the authoritative field.

## Cutover evidence (2026-07-27)

- Seven runs (`20260727-165629` through `20260727-173214`) were `ready`, with
  `yearConflicts=0`, `duplicate=0`, `failed=0`, and an identical accepted-set SHA-256.
- The controlled assignment deal changed from user `1` to `2255` and was deleted after verification.
- The first execute processed 156 inputs: 133 created, 23 duplicates, 0 failed; assignment passed.
- The immediate post-push dry-run returned `create=0`, `update=133`, `duplicate=23`, `failed=0`.
