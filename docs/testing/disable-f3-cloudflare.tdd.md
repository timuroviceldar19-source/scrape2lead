# Disable F3 Cloudflare dispatch — TDD evidence

## User journey

As the automation owner, I want the F3 B2B cron removed from Cloudflare while keeping all GZ schedules, so Cloudflare no longer dispatches the disabled GitHub workflow.

## RED and GREEN

- RED: `npx vitest run tests/cloudflare/githubDispatchWorker.test.ts`
  - 24 passed, 2 failed.
  - The Wrangler trigger list still contained `10 4 * * *`, and the Worker still mapped it to `f3-daily.yml`.
- GREEN: the same command passed all 26 tests after removing the trigger and mapping.
- Wrangler validation: `npm run cloudflare:check` passed and produced a valid dry-run bundle.
- Repository validation: `npm run build`, `npm run lint`, and `npm test` passed; full suite result was 732 passed and 4 skipped.

## Guarantees

| Guarantee | Evidence | Result |
|---|---|---|
| Cloudflare has no F3 `09:10` cron in the deploy config | `Cloudflare cron wiring > does not dispatch the disabled F3 workflow` | PASS |
| A stale F3 cron event is rejected without contacting GitHub | Same test verifies `Unknown cron trigger` and zero fetches | PASS |
| PK, main, and watchdog mappings remain synchronized with Wrangler | `keeps wrangler.jsonc and WORKFLOW_BY_CRON in sync in both directions` | PASS |

## Merge evidence

- RED checkpoint: `23d20b4` (`test: require F3 Cloudflare schedule to stay disabled`)
- GREEN checkpoint: `2b3551c` (`chore: disable F3 dispatch in Cloudflare`)
