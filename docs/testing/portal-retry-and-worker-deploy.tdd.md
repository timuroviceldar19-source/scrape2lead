# Portal outage retry and Cloudflare Worker auto-deploy — TDD evidence

## Source and user journeys

Requested after the 2026-10-10 review.

- As the owner, I want the Worker to be deployed automatically after a merge, because the
  manual deploy let the live schedule lag the code from 2026-09-16 (disabled F3 kept running,
  main fired at the wrong time) and nobody noticed.
- As the owner, I want a collection that failed because the portal did not answer to be tried
  again after 10–15 minutes. On 2026-10-09 two of 19 slots failed with `ERR_CONNECTION_TIMED_OUT`
  (08:40 PK, 16:30 main); the 16:30 failure stayed unfixed until the next morning.

## RED and GREEN

- RED: `npx vitest run tests/automation/runAutomationRetry.test.ts` failed 5/5 because
  `scripts/run-automation-with-retry.sh` did not exist.
- GREEN: same command, 5 passed. Cases: success on the first attempt runs once; a network
  failure is retried and then succeeds (one `status=failed` and one `status=pushed` in the log);
  a permanently unreachable portal stops after three attempts with exit 1; a non-network
  failure is not retried; only log lines written during the current attempt are inspected.
- Workflow tests: `gz-automation.yml` calls the retry wrapper; `deploy-worker.yml` triggers
  on pushes to main touching the Worker folder and manually, uses `npm run cloudflare:deploy`
  with `CLOUDFLARE_API_TOKEN`, fails loudly without the token, never cancels a running
  deploy, and its own file is not in `paths`.

## Decisions

- Retry only on network signatures in the log (`net::ERR_*`, `fetch failed`, `ETIMEDOUT`, ...).
  A code or data error fails at once so it is not hidden behind three attempts.
- Three attempts, 10 minutes apart: a slot that starts failing at 16:30 is retried until about
  16:55 and the failure email is sent only after the last attempt. A whole-run retry is safe
  because Bitrix deduplicates by `UF_CRM_PLAN_ID` and the run lock is released on failure.
- The deploy job fails when the secret is missing instead of skipping: a silent skip would
  bring back the drift this change removes.

## Known gaps

- `CLOUDFLARE_API_TOKEN` must be created by the owner and added as a repository secret; until
  then the deploy job fails on Worker-folder changes.
- The deploy is not gated on CI; branch protection requires the `test` check before merge.
- A long outage keeps a job running up to about 45 minutes; the next hourly slot waits in the
  concurrency queue (one pending run is kept).
