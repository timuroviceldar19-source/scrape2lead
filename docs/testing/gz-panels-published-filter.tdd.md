# GZ panels publication filter — TDD evidence

## Source and user journey

The acceptance criteria were supplied in the implementation request.

As an operator, I want the publication checker to process only deals belonging to the
`config/gz-plans.json` keyword set, so that PK and unrelated GZ plans are not queried or updated.

## RED / GREEN evidence

| Stage | Command | Result |
|---|---|---|
| RED | `npx vitest run tests/bitrix/gzPublishedDealStatus.test.ts` | 7 intended failures: the new panels selection functions did not exist; 16 existing tests passed. |
| GREEN | `npx vitest run tests/bitrix/gzPublishedDealStatus.test.ts` | 23 passed. |
| Type safety | `npm run lint` | Passed. |
| Build | `npm run build` | Passed. |
| Regression | `npm test` | 520 passed; 1 pre-existing configured E2E test skipped. |

## Test specification

| # | What is guaranteed | Test type | Result |
|---|---|---|---|
| 1 | Item-name and keyword fields match every configured panels keyword case-insensitively, including `Доска специальная`. | Unit | PASS |
| 2 | `TITLE` is used only as a fallback when both explicit classification fields are empty. | Unit | PASS |
| 3 | PK plans are excluded, and `CATEGORY_ID` does not affect panels membership. | Unit | PASS |
| 4 | `offset` and `limit` are applied after non-panels deals are removed. | Unit | PASS |
| 5 | Existing publication status update and dry-run behavior remains unchanged. | Regression unit | PASS |

## Coverage and known gaps

`npx vitest run tests/bitrix/gzPublishedDealStatus.test.ts --coverage --coverage.include=src/bitrix/gzPublishedDealStatus.ts`
reported 100% statements, 96.77% branches, 100% functions, and 100% lines.

No live Bitrix or Goszakup request was issued. The existing skipped dashboard E2E test is unrelated to this change.

## Merge evidence

- RED checkpoint: `59f846c test: add panels publication filter coverage`
- GREEN checkpoint: the implementation commit containing this report; targeted tests, lint, build, coverage, and the full regression suite passed as recorded above.
