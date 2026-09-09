# Move main GZ collection earlier — TDD evidence

## User journey

As the automation owner, I want `Plans and lots` to start at 09:20 Kazakhstan time, after the 08:40 PK collection, so the main results arrive earlier without allowing the two collectors to overlap.

## RED and GREEN

- RED: `npx vitest run tests/cloudflare/githubDispatchWorker.test.ts`
  - 16 passed, 11 failed.
  - The tests required the new Cloudflare `04:20 UTC` trigger and GitHub `04:20/05:20 UTC` primary/backstop slots while the configuration still used the old `05:00/06:00 UTC` slots.
- GREEN: the same command passed all 27 tests after updating Cloudflare, GitHub Actions, and the schedule documentation.
- Cloudflare validation: `npm run cloudflare:check` passed and produced a valid Wrangler dry-run bundle.
- Repository validation: `npm run build`, `npm run lint`, and `npm test` passed; the full suite result was 733 passed and 4 skipped.
- Diff validation: `git diff --check origin/main...HEAD` passed.
- Dependency audit: `npm audit --audit-level=high` reports 14 pre-existing dependency advisories (8 high). This schedule-only change does not modify dependencies; forced fixes would include breaking upgrades and are intentionally kept out of scope.

## Guarantees

| Guarantee | Evidence | Result |
|---|---|---|
| Cloudflare dispatches main at 09:20 Kazakhstan time | Worker cron mapping and Wrangler synchronization tests | PASS |
| GitHub's native main backstop is at 10:20 Kazakhstan time | Workflow schedule assertions for `20 4` and `20 5` UTC | PASS |
| PK remains at 08:40 and repeats at 13:00 | Exact Worker routing tests for `40 3` and `0 8` UTC | PASS |
| Afternoon main and both watchdog slots remain unchanged | Exact Worker routing tests for `30 6,9` and `15 10` UTC | PASS |
| PK and main cannot overlap | Both GitHub workflows retain their shared concurrency group | PASS |

## Merge evidence

- RED checkpoint: `7240089` (`test: require 09:20 main collection schedule`)
- GREEN checkpoint: `58bdce3` (`ci: move main collection to 09:20`)
