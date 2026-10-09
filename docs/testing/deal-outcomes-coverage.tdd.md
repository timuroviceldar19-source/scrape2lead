# Deal outcomes: coverage report and higher limit — TDD evidence

## Source and user journey

Requested after the 2026-10-10 review. As the owner, I want the deal outcome check to say how
many deals the portal check covered out of how many needed it, and to look at more deals per
run now that the network works. Before this change the step stayed green while 255 of 936
deals could not be checked (the portal TLS problem), and a fixed cap of 200 HTML checks per run
left 144 of 344 waiting for a rotation.

## RED and GREEN

- RED: `npx vitest run tests/bitrix/gzOutcomeCoverage.test.ts` failed because
  `src/bitrix/gzOutcomeCoverage.ts` did not exist.
- GREEN: same command, 8 passed: full coverage, a limit that cut the check short, the time
  budget, a warning at 255 failed of 255 requests, no warning for 30 failures of 344 or for
  fewer than 10 requests, stable keys of the log line, and the no-need case.

## Decisions

- The pure part (text, line, warning threshold) lives in `src/bitrix/gzOutcomeCoverage.ts`;
  the 900-line script only passes counters to it.
- Default `--html-limit` 200 -> 500 (all 344 pending deals fit) with a time budget of 20 minutes
  (`--html-budget-min`): the check cannot run unbounded if the portal slows down. The rotation
  is kept for the case when pending deals exceed the cap.
- The warning fires when at least 10 portal requests were made and at least 20% of them failed.
  It is a `::warning::` annotation and a line in the Summary: the step stays `continue-on-error`
  so a bad portal day does not turn the whole run red.

## Known gaps

- The glue in `scripts/check-gz-deal-outcomes.mts` is covered by type checking only: the script
  needs the Bitrix webhook and the Goszakup token, so the first live morning run confirms the
  report line and the Summary text.
- A time budget stop is not resumed exactly: the next run starts from the hourly rotation offset.
