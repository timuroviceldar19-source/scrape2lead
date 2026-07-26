# Daily GZ automation — TDD evidence

## Journeys

- An operator receives a complete plans/lots package without any CRM or AI mutation.
- A scheduled run prepares a package and, only when the dry-run is clean, pushes plans then lots to Bitrix without any AI.
- A partially pushed run (lots failed after plans) resumes from lots without re-pushing plans.
- An operator approves an immutable package by run ID and can safely resume after an AI failure; a already-pushed package runs AI-only.
- A scheduled prepare cannot overlap another run and stale locks are recoverable.
- A second daily task collects PK plans only and pushes them to Bitrix without ever touching lots or AI.
- A run prepared before the plans-only mode existed (manifest v1/v2) still pushes as a full plans-and-lots run.

## RED/GREEN record

- RED `94d890e`: automation core/orchestrator modules were absent; both test suites failed to load.
- GREEN `75b6855`: manifest, hashes, locks, retention, prepare and resumable approval passed 12 tests.
- RED `5575ab4`: collector config validation module was absent.
- GREEN `f5c9da9`: config validation, real adapters, CLI and scheduler integration passed.
- RED (push automation): `pushAutomationRun`/`runScheduledAutomation` were absent; 8 new scheduled-push tests failed to resolve the functions.
- GREEN (push automation): manifest v2 (`pushing`/`pushed`), scheduled prepare→push, partial-push resume and AI-only approval passed 14/14 orchestrator tests.
- RED (plans-only workflow): `AutomationWorkflow`, `manifestWorkflow` and `config/automation.pk.json` were absent; 10 new tests failed across the orchestrator, core, config and scheduler-runner suites.
- GREEN (plans-only workflow): manifest v3 with a stored `workflow`, plans-only prepare/push, approval refusal, v1/v2 compatibility and the parameterized runner passed 42/42 automation tests.

## Guarantees

| Guarantee | Test/command | Result |
|---|---|---|
| Prepare never calls CRM apply or AI | `tests/automation/orchestrator.test.ts` | PASS |
| Failed collector or critical dry-run blocks approval | `tests/automation/orchestrator.test.ts` | PASS |
| Changed artifacts are rejected by SHA-256 | `tests/automation/orchestrator.test.ts` | PASS |
| Approval is idempotent and AI-only retry is supported | `tests/automation/orchestrator.test.ts` | PASS |
| Scheduled run pushes plans then lots without AI | `tests/automation/orchestrator.test.ts` | PASS |
| A failed prepare never pushes to Bitrix | `tests/automation/orchestrator.test.ts` | PASS |
| A plans push failure never starts lots | `tests/automation/orchestrator.test.ts` | PASS |
| A partial push resumes from lots without re-pushing plans | `tests/automation/orchestrator.test.ts` | PASS |
| A pushed run is not re-pushed and approves AI-only | `tests/automation/orchestrator.test.ts` | PASS |
| Run IDs, rolling cross-year periods, atomic manifests, locks and retention work | `tests/automation/core.test.ts` | PASS |
| Mojibake and blank collector values are rejected | `tests/automation/config.test.ts` | PASS |
| Daily Windows task runs the full prepare+push workflow at 10:00 | `Get-ScheduledTask` / `Get-ScheduledTaskInfo` | PASS |
| A plans-only run never calls the lots collector, lots push or AI | `tests/automation/orchestrator.test.ts` | PASS |
| A plans-only run rejects tampered plans and dry-run artifacts by SHA-256 | `tests/automation/orchestrator.test.ts` | PASS |
| A failed plans-only push resumes without re-collecting | `tests/automation/orchestrator.test.ts` | PASS |
| Approval/AI is refused for a plans-only run with a clear error | `tests/automation/orchestrator.test.ts` | PASS |
| Manifests v1/v2 without a workflow still push as plans-and-lots | `tests/automation/orchestrator.test.ts`, `tests/automation/core.test.ts` | PASS |
| The PK config is plans-only and shares one prepare lock with the daily config | `tests/automation/config.test.ts` | PASS |
| Retention of `runs/` never deletes the nested `runs/pk/` tree | `tests/automation/core.test.ts` | PASS |
| A successful push returns exit code 0 even though npm writes to stderr | `tests/automation/schedulerRunner.test.ts` | PASS |
| A failed push propagates its exit code to Task Scheduler | `tests/automation/schedulerRunner.test.ts` | PASS |
| Every PK collector keyword routes to Bitrix category 9 / stage `C9:NEW` | `tests/bitrix/gzDealRouting.test.ts` | PASS |
| Daily PK Windows task runs the plans-only workflow at 08:40 | `Get-ScheduledTask` | PASS |
| The POSIX runner returns 0 when npm exits 0 after writing to stderr | `tests/automation/runAutomationShell.test.ts` | PASS (skipped on Windows) |
| The POSIX runner propagates a failed npm exit code to cron | `tests/automation/runAutomationShell.test.ts` | PASS (skipped on Windows) |
| The POSIX runner resolves a relative log path against the repo root, not cwd | `tests/automation/runAutomationShell.test.ts` | PASS (skipped on Windows) |

## Verification

- `npm run build`: PASS.
- `npm run lint`: PASS.
- `npm test`: PASS, 607 passed / 4 skipped of 611 tests. The three POSIX-runner cases skip on
  Windows (`describe.skipIf(process.platform === "win32")`) the same way the three PowerShell
  cases skip on Linux — each platform runs its own scheduler runner, and the GitHub Actions
  Ubuntu runner is where the POSIX ones execute.
- Targeted coverage of the changed modules (`src/automation/config.ts`, `core.ts`, `orchestrator.ts`): 96.93% statements, 89.28% branches, 100% functions — above the 80% floor.
- The scheduled push path is exercised through the injected `AutomationDependencies`; live network adapters (`realDependencies.ts`) remain the main coverage gap.

### Scheduler exit-code defect

`run-automation.ps1` ran `& npm.cmd run automation:run *>> $log` under
`$ErrorActionPreference = 'Stop'`. In Windows PowerShell 5.1 a native command's
stderr is wrapped in an ErrorRecord, so npm's ordinary warnings raised a
terminating `NativeCommandError` and the task reported `failed` with exit 1 for
a run that had actually pushed. The log was also written as UTF-16 and unusable
for Cyrillic output.

Reproduced with a fake `npm.cmd` that writes to stderr and exits 0: the script
exited 1 and never reached its trailing `Add-Content` status line.

The defect was live, not theoretical. Confirmed on 2026-07-17 from production
state before the fix:

- `runs/scheduler.log` contained **no** `scheduler automation:run status=` line
  anywhere in its history — the `Add-Content` call was never once reached.
- The scheduled 10:50 run `runs/20260717-105001/manifest.json` was
  `status: pushed` with `applyPlans: succeeded` and `applyLots: succeeded`, so
  the work completed and reached Bitrix while Task Scheduler was told it failed.

The runner now collects stderr as plain text under
`$ErrorActionPreference = 'Continue'` and appends UTF-8;
`tests/automation/schedulerRunner.test.ts` locks in both the success (exit 0
despite stderr) and failure (exit code propagated) paths.

`manifestWorkflow` was also checked against the nine real manifests on disk
(eight v1, one v2, none carrying a `workflow` field): all resolve to
`plans-and-lots`, so an existing `ready` run still pushes lots if the operator
pushes it by run ID.

Real Goszakup collection, Bitrix writes and AI calls were intentionally not executed during tests; the scheduler-runner tests drive `run-automation.ps1` against a fake `npm.cmd` on `PATH` and never reach the network. Both Windows tasks must be re-registered with `npm run automation:install-task` and `npm run automation:install-pk-task` after these changes; neither was run live during the test pass.

## Move to GitHub Actions

The two Windows tasks were registered without `-User`/`-RunLevel`, so they only fired
while that account stayed logged on, and the action hard-coded `F:\scrape2lead-main`.
Both now run as scheduled workflows instead.

`scripts/run-automation.sh` is the POSIX counterpart of `run-automation.ps1` and keeps
the same log line and exit-code contract, so `runs/scheduler.log` reads identically on
either platform. It resolves a relative log path against the repo root rather than the
caller's cwd — cron and systemd invoke it from an arbitrary directory. Verified against a
fake `npm` on `PATH` for the success, failure and foreign-cwd cases.

Two invariants needed a different mechanism on ephemeral runners:

- **Mutual exclusion.** `runs/prepare.lock` never exists on a clean runner, so
  `acquireRunLock` always succeeds and cannot serialize the two jobs. The shared
  `concurrency: group: gz-automation` (`cancel-in-progress: false`) does it instead.
- **Run IDs.** `createRunId` in `src/automation/core.ts` uses local time, so the
  workflows set `TZ: Asia/Almaty`. Kazakhstan is UTC+5 with no DST, so the cron
  offset (03:40 and 05:00 UTC) is constant year-round.

The geo risk was gated by `.github/workflows/gz-probe.yml` rather than assumed away, and
it cleared: goszakup.gov.kz serves GitHub's runner IPs (71 rows on 2026-07-25, run
30161923368). The first live PK run followed at ~50 minutes with counters matching the
Windows baseline exactly — 345 rows, 299 existing, 46 duplicate, 0 create.

### Unreliable scheduled events

The first scheduled trigger, 2026-07-26 03:40 UTC, produced no run at its slot. Verified
rather than inferred: the repository held zero runs with `event=schedule`, while the
workflow was `active` and present on the default branch at `66198c8` since
2026-07-25T14:34:50Z — 13 hours before the fire time, so registration was not the cause.

The initial reading was that GitHub had dropped the event. Later the same day that turned
out to be the wrong failure model, and the correction matters because it invalidates the
first mitigation. Run 30190963247 arrived with `event=schedule` at 06:23:15Z for the
04:40 slot — **103 minutes late**, not lost. The 05:00 slot for `gz-daily-main.yml` was
still absent 2.5 hours later. Meanwhile `workflow_dispatch` was delivered instantly on
every one of four attempts across two days.

Ruled out by inspection, not assumption: the repository is not a fork (scheduled
workflows are disabled in forks — the leading hypothesis), not archived, public, default
branch `main`, and githubstatus.com reported all systems operational throughout.

So the failure mode is severe delay in `schedule` delivery specifically, while
`workflow_dispatch` is unaffected. A backstop cron inside Actions cannot fix that: it
rides the same delayed queue as the primary and slips by the same amount. The scheduling
authority therefore moves outside GitHub — an external cron calling the
`workflow_dispatch` API, documented in the README. The in-repo crons stay as a free
second path, and the guard makes their late arrival a no-op.

That behaviour was confirmed in production rather than reasoned about: when the delayed
04:40 event landed at 06:23, the guard found the already-successful run from 04:52,
logged `Сегодня уже есть успешный или активный прогон (1) — backstop пропускаем`, and
the `pk-plans` job was skipped. Total run time 8 seconds, no collection, no CRM traffic.

The watchdog moved from 07:30 to 08:00 UTC as a consequence: at 07:30 it would have
alarmed while a legitimately delayed run was still in flight. It remains cron-driven and
so shares the same unreliability, which is why it is listed as the second line and should
also be triggered externally.

### Watchdog counted the wrong thing

Its first version asserted that each daily workflow had a *run* with
`conclusion == success` today. That is not the same as the work having happened: a run
whose `guard` skipped the collection also completes as `success`, and both delayed events
on 2026-07-26 were exactly that shape. The failure it would have missed: the primary
starts at 05:00 and is still active at 06:00, so the backstop's guard skips and records
`success`; the primary then fails at 06:30; the watchdog sees a successful run and
reports healthy while nothing was collected.

The check now descends to the job that does the work. Real collection produces a job
named `<name> / run` — the nested `gz-automation.yml` call — with `conclusion: success`,
while a guard skip produces `<name>` with `conclusion: skipped`. Matching the name by
prefix catches both and filtering on `success` keeps only genuine work.

Verified against live data containing both shapes on the same day: for `gz-daily-pk.yml`
the delayed guard-skip run 30190963247 scored 0 and the real run 30188460475 scored 1;
for `gz-daily-main.yml`, 30193028083 scored 0 and 30192768614 scored 1. The failure path
was exercised separately with a job name that matches nothing, confirming the non-zero
exit propagates through `|| failed=1` under `set -e`.

The same day's `plans-and-lots` run also settled the remaining question about the shared
plan-detail cache. It reported `cache_hit: 0, cache_miss: 110` despite `gz-daily-pk.yml`
having populated the cache hours earlier — not a restore failure, but a different plan
set: this workflow collects interactive panels, PK collects personal computers. The two
workflows share one `gz-db-` cache and append to the same SQLite file, and the
`gz-automation` concurrency group is what keeps their writes from racing.

Two mitigations, both in `.github/workflows/`:

- **Backstop cron.** Each daily workflow gained a second trigger an hour after the
  first (`40 4` and `0 6` UTC). A `guard` job queries the Actions API and skips the
  backstop when the same workflow already has a run that is either successful today or
  still active, so the collector still hits goszakup once per day in the normal case.
  `workflow_dispatch` bypasses the guard entirely.

  Counting successes alone was not enough. The guard sits in the *calling* workflow,
  which carries no concurrency group — only the called `gz-automation.yml` does — so the
  guard is never queued and evaluates at its scheduled minute regardless of what is
  running. A cold primary run (~65 min) is therefore still in flight when the backstop
  fires 60 minutes later: a success-only guard would see zero, let the backstop through,
  and the called workflow would queue behind the primary and repeat the whole collection
  — duplicating portal load in exactly the slow scenario where it costs most. The
  predicate now treats any non-`completed` run as blocking.

  Two asymmetries in that predicate are deliberate. An active run blocks regardless of
  when it started, since a job begun before midnight UTC and still going is the same
  reason not to launch a second; a *success* only counts when it is today's, so
  yesterday's does not suppress this morning's schedule. The workflow's own run is
  excluded by `github.run_id` — it is itself `in_progress` while querying, and would
  otherwise block every backstop unconditionally.

  A failed or cancelled run does not block: that is precisely what the backstop is for.
  The residual gap is a primary that fails *after* the guard has already checked — the
  backstop will not pick it up, and `gz-watchdog.yml` is what catches that.

  Verified before shipping: the `gh run list --jq` expression against live repository
  data, and the decision table across nine cases (own run only, primary in progress,
  primary queued, primary failed, primary cancelled, primary succeeded, success from
  yesterday, overnight run still going, and yesterday's success alongside today's active
  run).
- **Watchdog.** `gz-watchdog.yml` runs at 07:30 UTC (12:30 Almaty, after both backstops
  plus cold-run headroom) and exits non-zero if either daily workflow has no success
  today, converting a silent miss into a failure email. It is itself cron-driven and so
  subject to the same unreliability — the gain is that two independent schedules are
  less likely to be dropped together than one, not that delivery is guaranteed.

A run producing zero new deals is not evidence of a miss. The 6-month rolling window
re-collects the same plans daily, so `create: 0` with `existing: 299` is the expected
steady state; `status: pushed` with an empty `errors` array is the health signal.

The manual catch-up run for the missed slot (30188460475, run `20260726-095235`) settles
both questions. Its counters are identical to the previous day's — 345 rows, 299
existing, 46 duplicate, 0 create, 0 update, 0 issues — so the undelivered schedule cost
no CRM records: goszakup had published nothing new in the interval, and the 03:40 run
would have produced the same zero. It also confirms the cache design end to end:
`cache_hit: 376, cache_miss: 0, fetched: 0` means `actions/cache` restored
`data/scrape2lead.db` intact across runs, and the job finished in 6m54s against roughly
50 minutes for the cold first run.
