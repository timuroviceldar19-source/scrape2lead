# CI on pull requests and run summary — TDD evidence

## Source and user journeys

Requested after the 2026-10-10 review of the pipeline.

- As the owner, I want every change checked automatically before it is merged, so that a
  mistake in a schedule, workflow or config does not reach production unnoticed. Before this
  change no workflow ran `npm test` or `npm run lint`, and PR #57, #58, #59 had no checks.
- As the operator, I want each GZ run to say how many deals it created, updated or found
  already present, so the value of an hourly slot can be judged from numbers. The runner log
  had none of them: the push output is captured by the orchestrator and only parsed into
  `manifest.json` stage counts.

## RED and GREEN

- RED: `npx vitest run tests/automation/runSummary.test.ts` failed because
  `src/automation/runSummary.ts` did not exist (no tests collected).
- GREEN: same command, 9 passed, after `renderRunSummary` and `findLatestManifestPath`.
- Workflow tests added to `tests/automation/gzGithubWorkflow.test.ts`: summary step runs
  `if: always()` with `continue-on-error`, `ci.yml` triggers, runs `lint` and `npm test`,
  installs Python reportlab and Chromium, and has no secrets.

## Decisions

- The summary is rendered from `manifest.json`, not from the log: counts are already stored
  there per stage. The deal counts are the `preflight:` numbers of the push script; a failed
  write makes the push script exit non-zero and the stage `failed`, so on a succeeded stage
  they equal what was written.
- The summary script never fails: it is a convenience and must not change a job result.
- CI installs Python 3.12 + reportlab and Chromium so the two KGD tests that failed locally
  (`kgdReport`, `kgdCaptchaAutomation`) run instead of being excluded.

## Known gaps

- Counts in a real manifest were not seen before the first live run; the first run after
  merge confirms the table.
- CI does not deploy the Cloudflare Worker; deployment stays manual.
