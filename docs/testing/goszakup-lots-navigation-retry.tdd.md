# TDD evidence: Goszakup lot navigation retries

## Source and user journey

The journey was derived from failed GitHub Actions runs `32832337434` and
`32848545412`; no external plan file was used.

- As the daily GZ automation operator, I want transient DNS and page-load
  failures to be retried, so that a brief `goszakup.gov.kz` outage does not
  abort an otherwise complete plans-and-lots run.

## Task report

The lots exporter now gives each `page.goto` up to four attempts. Each attempt
has a 60-second timeout, with 2, 4, then 8-second waits between failures. After
the fourth failure, the original navigation error is rethrown so incomplete
data cannot be delivered as a successful run.

- RED: `npm test -- tests/kz/goszakupLotsNstruExporter.test.ts` — 2 failed,
  20 passed; both new tests failed because `gotoLotsPageWithRetry` did not
  exist.
- GREEN: the same command — 22 passed.
- Regression: `npm test` — 860 passed, 4 skipped across 95 files.
- Type check: `npm run lint` — passed.

## Test specification

| # | Guarantee | Test target | Type | Result |
|---|---|---|---|---|
| 1 | DNS/timeout failures are retried and a later successful navigation completes normally | `lots page navigation retries > retries a transient navigation failure and eventually succeeds` | unit | PASS |
| 2 | Retry delays back off from 2 to 4 seconds for consecutive failures | same test | unit | PASS |
| 3 | The configured 60-second navigation timeout is passed to Playwright | same test | unit | PASS |
| 4 | The final navigation error is rethrown after the attempt limit | `lots page navigation retries > throws the final error after the configured attempt limit` | unit | PASS |

## Coverage and known gaps

`npm run test:coverage -- --run tests/kz/goszakupLotsNstruExporter.test.ts`
passed all 22 targeted tests. The repository's coverage configuration includes
every source and script even for a single-file test invocation, so its global
1.67% result is not a meaningful target-level percentage. The changed retry
helper's success-after-retries and exhausted-retries branches are both executed.
No live portal write was performed by the tests.

## Merge evidence

- RED checkpoint: `c8d62d1`
- GREEN checkpoint: `51d90e7`
