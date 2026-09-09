# GZ plan pagination and GitHub token wiring — TDD evidence

## Source and user journey

No source plan file was provided. The journey was derived from the production audit:

> As the owner of the daily GZ automations, I want every portal result page to be collected with authenticated plan details, so that qualifying plans are not silently omitted from Bitrix.

## Task report

### Portal pagination

- RED: `npx vitest run tests/kz/goszakupPlanParser.test.ts`
  - `1 failed | 12 passed`
  - Expected the second request to use `page=2`; the old collector sent `page=1`.
- GREEN: `npx vitest run tests/kz/goszakupPlanParser.test.ts tests/kz/goszakupHtmlCollector.test.ts tests/kz/goszakupLotsNstruExporter.test.ts`
  - `3 passed` files, `32 passed` tests.
- Guarantee: the first request has no `page` parameter and the next request uses the portal's one-based `page=2` convention.

### GitHub token wiring

- RED: `npx vitest run tests/automation/gzGithubWorkflow.test.ts`
  - `3 failed` tests because neither caller nor the reusable workflow declared or forwarded `GOSZAKUP_TOKEN`.
- GREEN: `npx vitest run tests/automation/gzGithubWorkflow.test.ts tests/kz/goszakupPlanParser.test.ts tests/kz/goszakupHtmlCollector.test.ts tests/kz/goszakupLotsNstruExporter.test.ts`
  - `4 passed` files, `35 passed` tests.
- Guarantee: both daily workflows forward the repository secret and the reusable workflow exposes it to the automation process.

## Test specification

| # | What is guaranteed | Test target | Type | Result | Evidence |
|---|---|---|---|---|---|
| 1 | The second plan-results request is `page=2`, not the first-page alias `page=1` | `tests/kz/goszakupPlanParser.test.ts` | Unit | PASS | Targeted GREEN run: 13/13 |
| 2 | Shared HTML URL building remains compatible with the portal | `tests/kz/goszakupHtmlCollector.test.ts` | Unit | PASS | Targeted GREEN run: 2/2 |
| 3 | Lots pagination retains the already-correct `page=2` behavior | `tests/kz/goszakupLotsNstruExporter.test.ts` | Regression | PASS | Targeted GREEN run: 17/17 |
| 4 | Main and PK workflows pass `GOSZAKUP_TOKEN` into the reusable workflow | `tests/automation/gzGithubWorkflow.test.ts` | Contract | PASS | Targeted GREEN run: 3/3 |
| 5 | The repository still builds and type-checks | `npm run build`; `npm run lint` | Integration | PASS | Both commands exited 0 |
| 6 | The full repository suite remains green | `npm test` | Regression | PASS | 732 passed, 4 skipped |

## Coverage and known gaps

`npm run test:coverage -- tests/automation/gzGithubWorkflow.test.ts tests/kz/goszakupPlanParser.test.ts tests/kz/goszakupHtmlCollector.test.ts tests/kz/goszakupLotsNstruExporter.test.ts` passed all 35 tests. The repository coverage configuration includes every source and script even during a targeted run, so its global result is 6.33% and does not meet an 80% project-wide threshold. The changed pagination branch is exercised for both the first and second page; `goszakupHtmlCollector.ts` reports 100% coverage. Raising unrelated repository-wide coverage is outside this fix.

`npm audit --audit-level=high` reports 14 existing dependency advisories (8 high). This change adds no package or lockfile updates; resolving breaking dependency upgrades is intentionally left to a separate change.

## Merge evidence

- RED checkpoint: `7dcb884` (`test: reproduce skipped GZ plan page`)
- GREEN checkpoint: `0d0c9ea` (`fix: request every GZ plan result page`)
- RED checkpoint: `481217b` (`test: require GZ token wiring in GitHub workflows`)
- GREEN checkpoint: `f9b31ed` (`ci: provide Goszakup token to daily plan runs`)
