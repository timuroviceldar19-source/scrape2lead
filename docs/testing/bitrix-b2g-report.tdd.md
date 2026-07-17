# Bitrix24 B2G report — TDD evidence

## Source plan

The journeys and acceptance criteria were derived from the user-approved implementation plan in the Codex task. No standalone `*.plan.md` file was supplied.

## User journeys

- As a leader, I want comparable B2G metrics across changing Bitrix24 pipelines so that pipeline migrations do not distort conversion or trend decisions.
- As a sales operator, I want an offline filterable deal table so that I can move from aggregate signals to the relevant Bitrix24 cards.
- As an analyst, I want a reproducible read-only snapshot with checksums and explicit exclusions so that every published number can be audited.
- As a meeting owner, I want an aggregate nine-slide PowerPoint so that management can discuss conclusions without exposing deal, company, or employee names.

## RED and GREEN checkpoints

| Stage | Command | Evidence |
|---|---|---|
| Initial RED | `npm test -- tests/bitrix/reportingModel.test.ts tests/bitrix/reportingClient.test.ts tests/bitrix/reportingHtml.test.ts` | 3 suites failed because the planned model, read-only client, and dashboard modules did not exist. Commit `5ba5b62` preserves this compile-time RED. |
| Time-zone RED | `npm test -- tests/bitrix/reportingModel.test.ts` | 1 of 6 tests failed: a UTC timestamp that is 1 January in Bitrix `+03:00` was counted as 31 December. |
| Focused GREEN | `npm test -- tests/bitrix/reportingModel.test.ts tests/bitrix/reportingClient.test.ts tests/bitrix/reportingHtml.test.ts tests/bitrix/reportingArtifacts.test.ts` | 15 tests passed after implementing normalization, read-only enforcement, HTML escaping, time-zone conversion, and artifact privacy checks. |
| Browser GREEN | `$env:BITRIX_REPORT_E2E='1'; npm test -- tests/bitrix/reportingDashboard.e2e.test.ts` | Playwright passed the offline filtering/link/overflow journey at both 1280 and 1440 px. |
| Repository GREEN | `npm test; npm run build; npm audit --audit-level=high` | 462 tests passed, TypeScript built successfully, and no high-severity audit finding was reported. Three pre-existing low/moderate dependency findings remain documented by npm. |

## Test specification

| # | What is guaranteed | Test target | Type | Result |
|---|---|---|---|---|
| 1 | Pipeline 29 technical `WON`/`LOSE` stages are routes, not wins or business losses. | `reportingModel.test.ts` | unit | PASS |
| 2 | `TYPE_ID=5` migrations do not duplicate deals; the first logical B2G entry fixes cohort membership. | `reportingModel.test.ts` | unit | PASS |
| 3 | A `9 → 17` move is a service handoff and is excluded from business losses. | `reportingModel.test.ts` | unit | PASS |
| 4 | Recoverable legacy stages map exactly; ambiguous retired stages remain `legacy_unknown`. | `reportingModel.test.ts` | unit | PASS |
| 5 | Conversion, positive-amount coverage, age buckets, comparison periods, and Bitrix time-zone boundaries are deterministic. | `reportingModel.test.ts` | unit | PASS |
| 6 | Mutating methods and mutating batch subcommands are rejected before transport; batch pagination handles direct and nested responses. | `reportingClient.test.ts` | integration | PASS |
| 7 | The REST allowlist contains no contact, phone, email, add, update, or delete method. | `reportingClient.test.ts` | integration | PASS |
| 8 | HTML embeds no CDN or webhook, safely escapes executable user data, and retains operational Bitrix links. | `reportingHtml.test.ts` | unit | PASS |
| 9 | The actual PPTX contains no deal, company, or manager names and no webhook/deal URLs. | `reportingArtifacts.test.ts` | integration | PASS |
| 10 | The final dashboard works from `file://`, filters the KPI/table view, makes no external requests, and does not overflow 1280/1440 px. | `reportingDashboard.e2e.test.ts` | E2E / Playwright | PASS |
| 11 | The final nine-slide deck has no canvas overflow. | `slides_test.py bitrix-b2g-report-2026-07-17.pptx` | presentation QA | PASS |

## Coverage and known gaps

Focused coverage command:

`npx vitest run tests/bitrix/reportingModel.test.ts tests/bitrix/reportingClient.test.ts tests/bitrix/reportingHtml.test.ts --coverage --coverage.reporter=text --coverage.include=src/bitrix/reporting/model.ts --coverage.include=src/bitrix/reporting/readOnlyClient.ts --coverage.include=src/bitrix/reporting/dashboard.ts`

Result: **98.8% statements, 84.75% branches, 100% functions, 98.8% lines**.

The live extraction generator is verified by the final read-only run and artifact audit rather than coverage instrumentation. The configured webhook has CRM scope but no `user` scope, so the dashboard shows stable responsible IDs; no broader user profiles, email addresses, or phone numbers were fetched. The report is a one-time snapshot and intentionally does not forecast revenue.

## Merge evidence

- RED checkpoint: `5ba5b62 test: add Bitrix reporting RED coverage`.
- GREEN checkpoint: the implementation commit following this report contains the passing model, client, dashboard, extraction, artifact, privacy, E2E, build, coverage, and presentation QA evidence.
