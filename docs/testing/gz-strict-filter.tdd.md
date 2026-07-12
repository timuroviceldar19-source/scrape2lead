# Strict GZ junk filter — TDD evidence

## Source and journey

The user-provided implementation plan was used directly. The export operator needs plans and lots to discard low-value and stop-listed junk, including Russian word forms, before XLSX/Bitrix output.

## RED / GREEN evidence

- RED: `npm test -- --run tests/kz/gzItemFilter.test.ts tests/kz/gzPlansConfig.test.ts` — 5 intended failures covering normalization, word forms, phrase forms, missing shared statistics, and missing PK configuration.
- GREEN: the focused four-file suite passed 49/49 tests after implementation.
- Regression: `npm test` passed 276/276 tests; `npm run lint` passed.
- Coverage: `npm run test:coverage` passed; `src/kz/gzItemFilter.ts` reached 100% statements, functions, and lines, with 96.77% branch coverage.

## Guarantees

| Guarantee | Evidence | Type |
|---|---|---|
| Names normalize Unicode, case, `ё/е`, punctuation, and whitespace | `tests/kz/gzItemFilter.test.ts` | Unit |
| Common Russian word and phrase forms match without matching `игра` inside `выиграл` | `tests/kz/gzItemFilter.test.ts` | Unit |
| Amount and stop-list drops have separate, non-overlapping counters | `tests/kz/gzItemFilter.test.ts` | Unit |
| Plan and lot exporters retain their filtering behavior through the shared engine | `tests/kz/gzPlanExporter.test.ts`, `tests/kz/goszakupLotsNstruExporter.test.ts` | Integration |
| The real PK config enables 500,000 KZT and all eight exclusions | `tests/kz/gzPlansConfig.test.ts` | Integration |

## Known gaps

No live Goszakup or Bitrix call was needed: filtering is deterministic and occurs before workbook creation and downstream import. Repository-wide coverage remains below 80% because unrelated CLI and network modules are not comprehensively tested; the changed filter module exceeds the requested threshold.
