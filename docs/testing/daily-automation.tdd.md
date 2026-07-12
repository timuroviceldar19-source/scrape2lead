# Daily GZ automation — TDD evidence

## Journeys

- An operator receives a complete plans/lots package without any CRM or AI mutation.
- An operator approves an immutable package by run ID and can safely resume after an AI failure.
- A scheduled prepare cannot overlap another run and stale locks are recoverable.

## RED/GREEN record

- RED `94d890e`: automation core/orchestrator modules were absent; both test suites failed to load.
- GREEN `75b6855`: manifest, hashes, locks, retention, prepare and resumable approval passed 12 tests.
- RED `5575ab4`: collector config validation module was absent.
- GREEN `f5c9da9`: config validation, real adapters, CLI and scheduler integration passed.

## Guarantees

| Guarantee | Test/command | Result |
|---|---|---|
| Prepare never calls CRM apply or AI | `tests/automation/orchestrator.test.ts` | PASS |
| Failed collector or critical dry-run blocks approval | `tests/automation/orchestrator.test.ts` | PASS |
| Changed artifacts are rejected by SHA-256 | `tests/automation/orchestrator.test.ts` | PASS |
| Approval is idempotent and AI-only retry is supported | `tests/automation/orchestrator.test.ts` | PASS |
| Run IDs, rolling cross-year periods, atomic manifests, locks and retention work | `tests/automation/core.test.ts` | PASS |
| Mojibake and blank collector values are rejected | `tests/automation/config.test.ts` | PASS |
| Daily Windows task points only to prepare and starts at 10:00 | `Get-ScheduledTask` / `Get-ScheduledTaskInfo` | PASS |

## Verification

- `npm run build`: PASS.
- `npm run lint`: PASS.
- `npm test`: PASS, 256/256 tests.
- Automation core targeted coverage: 89.90% statements, 90.21% branches, 88.88% functions.
- Full-repository coverage: 43.18% statements; legacy CLI and live network adapters remain the main gap.

Real Goszakup collection, Bitrix writes and AI calls were intentionally not executed during tests.
