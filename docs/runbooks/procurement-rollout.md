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

## Category-1 robot

In Bitrix automation for pipeline `F3-B2B тендеры` (`CATEGORY_ID=1`), stage `C1:NEW`, configure
a round-robin assignment action with users `2015`, `2209`, and `2255`. The integration does not
set `ASSIGNED_BY_ID`; `OPENED=Y` is set on every new or updated deal.

Create controlled test deals and verify that:

1. the responsible user changes away from the webhook user;
2. distribution covers all three configured managers;
3. every assigned deal appears under the respective manager's “Мои” filter.

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

## Current public-source limitation

Tizilim publicly exposes tender search, but the tested public plan endpoints return HTTP 404.
Therefore Tizilim tenders are collected; Tizilim plan data remains unavailable without a
documented public endpoint or authorized account. EPZ supplies both plans and tenders for
MITWORK and Samruk while excluding Goszakup (`system_id=1`).
