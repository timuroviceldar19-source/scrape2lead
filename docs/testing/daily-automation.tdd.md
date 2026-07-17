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
| Daily PK Windows task runs the plans-only workflow at 11:00 | `Get-ScheduledTask` | PASS |

## Verification

- `npm run build`: PASS.
- `npm run lint`: PASS.
- `npm test`: PASS, 441/441 tests (automation suites 43/43, including 10 plans-only cases and 3 scheduler-runner cases).
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
