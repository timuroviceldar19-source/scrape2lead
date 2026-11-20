# F3 B2B daily schedule restored — TDD evidence

## User journey

As the B2B sales lead, I want new plans and lots for `F3-В2В тендеры` (`CATEGORY_ID=1`) to arrive every
day without anyone running `f3:export` / `f3:push` by hand.

F3 was dropped from GitHub Actions and the Worker in `fecc609` (2026-10-09). On 2026-11-20 the filters were
narrowed (700 000 ₸, interactive panels, monoblocks, laptops) and the push now links the customer company with
its registry phone, so the daily run is turned back on.

## Key decisions

- **No new cron.** The Worker dispatches `f3-daily.yml` inside the existing hourly cron `30 4-11 * * *`, only at
  04:30 UTC (09:30 Almaty), next to PK and main. Cloudflare stays at 4 of 5 cron triggers.
- **Once a day.** F3 collection is heavy (~1 200 records with detail pages) and its data changes slowly; the old
  schedule was also daily (09:10).
- **Own queue and cache.** `f3-automation.yml` is restored as-is: concurrency group `f3-automation`, cache key
  `f3-db-`, `scripts/run-automation.sh`, no Playwright. GZ workflows are untouched.
- **GitHub cron only as backstop** at `30 5` UTC (10:30). Its guard skips the run when today's run — including the
  Worker's `workflow_dispatch` — already succeeded or is still going. The old primary `10 4` slot is gone.
- **Delivery gates unchanged:** `deliveryMode: push`, `executeEnabled: true`, seven committed manual runs in
  `data/procurement-manual-runs.json`, post-push assignment check now against `2403`/`2405`.

## RED and GREEN

- **RED:** `npx vitest run tests/cloudflare/githubDispatchWorker.test.ts tests/automation/f3GithubWorkflow.test.ts`
  — 5 failed: the 04:30 slot did not dispatch `f3-daily.yml`, the F3 workflow files were absent.
- **GREEN:** after adding `F3_WORKFLOW` / `F3_HOUR_UTC` to the Worker and restoring both workflows
  (backstop moved to `30 5`): `tests/cloudflare` + `tests/automation` — 186 passed. The logging test for PK + main
  moved from the 04:30 to the 05:30 slot, since 04:30 now dispatches three workflows.

## Rollout

Merging to `main` redeploys the Worker through `deploy-worker.yml` (secret `CLOUDFLARE_API_TOKEN`). The first
scheduled F3 run is the next 09:30 Almaty slot after the deploy; check the `f3-run-<id>` artifact and Step log.
