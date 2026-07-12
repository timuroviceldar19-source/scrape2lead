# GZ/Bitrix cleanup — TDD evidence

## Source and journey

The implementation follows the user-approved cleanup plan from the Codex task.

- As an operator, I can keep using the GZ export, Bitrix24, publication-monitoring, and specification-analysis workflows after legacy subsystems are removed.
- As a maintainer, I can install, build, typecheck, and test only the supported workflow without references to removed modules.

## Evidence

| Guarantee | Validation | Result |
|---|---|---|
| Pagination tests do not depend on mutable local debug captures | `npx vitest run tests/kz/goszakupPlanParser.test.ts` | PASS: 12/12 |
| Supported source tree compiles | `npm run build` | PASS |
| Retained unit/integration suite passes | `npm test` | PASS: 240/240 |
| Coverage command is available and completes | `npm run test:coverage` | PASS; 42.66% statements overall |

## RED/GREEN record

- RED baseline: the old debug-file-dependent pagination assertion failed because the local capture contained 29 records on one page while the test required at least two pages.
- GREEN: the test now uses deterministic HTML with 51 records at 50 records per page and verifies exactly two pages.
- Checkpoint: `a87209d test: make GZ pagination regression deterministic`.

## Coverage and known gaps

Core analysis and Bitrix modules have strong coverage, but overall statement coverage is 42.66%. Command orchestration and live browser/network collectors dominate the uncovered lines. No live Bitrix writes, paid AI calls, or remote collector runs were executed during verification.
