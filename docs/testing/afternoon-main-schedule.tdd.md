# Afternoon main schedule — TDD evidence

## Source and user journey

No source plan was provided. The journey was derived from the requested schedule change:
as the automation owner, I want the afternoon `gz-daily-main.yml` dispatch at 13:30 UTC+5
so that the second plans-and-lots collection starts one hour earlier without changing the
13:00 PK run or the 15:15 afternoon watchdog.

## Task report

- RED: `npm test -- --run tests/cloudflare/githubDispatchWorker.test.ts` failed with
  12 expected schedule/wiring failures while production still used `30 6,9 * * *` and
  the watchdog threshold still used `09:30:00Z`.
- GREEN: the same command passed all 27 tests after changing the grouped Cloudflare cron
  to `30 6,8 * * *`, routing the 08:30 UTC occurrence to `gz-daily-main.yml`, and moving
  the watchdog threshold to `08:30:00Z`.
- Validation: `npm run lint` passed.
- Validation: `npm run cloudflare:check` passed and preserved five Cloudflare cron triggers.
- Deployment: Cloudflare Worker version `b9be8964-b2d5-4792-b24a-e9076c8f5999` was deployed
  with the new 08:30 UTC / 13:30 UTC+5 trigger.

## Test specification

| # | Guarantee | Test or command | Type | Result |
|---|---|---|---|---|
| 1 | The 08:30 UTC grouped trigger dispatches `gz-daily-main.yml` | `githubDispatchWorker.test.ts` mapping table | Unit | PASS |
| 2 | Wrangler and the runtime cron map remain synchronized with five triggers | `keeps wrangler.jsonc and WORKFLOW_BY_CRON in sync` | Integration | PASS |
| 3 | The afternoon watchdog only accepts main runs created from 08:30 UTC | `runs an afternoon watchdog after both repeat collection slots` | Integration | PASS |
| 4 | The Worker bundle is valid for deployment | `npm run cloudflare:check` | Build | PASS |

## Coverage and known gaps

`npx vitest run tests/cloudflare/githubDispatchWorker.test.ts --coverage` passed with
96.66% statements/lines, 89.74% branches, and 100% functions for the Worker module.

The repository-wide coverage command encountered one unrelated pre-existing assertion in
`managerMonitorFormatting.test.ts` (`expected 100`, received `106`), so no new claim is
made about global coverage. The schedule target itself is green and exceeds 80% coverage.

## Merge evidence

- RED evidence: schedule tests rejected `30 6,8 * * *` as unknown and found the old
  `09:30:00Z` watchdog threshold.
- GREEN evidence: 27/27 focused tests passed with the new 13:30 UTC+5 behavior.
