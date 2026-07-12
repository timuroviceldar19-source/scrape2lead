# Hide GZ spec technical fields — TDD evidence

## Journey

Bitrix users should see the analysis verdict, summary, date, and PDF without seeing internal model and hash values in the deal card.

## RED / GREEN

- RED: the focused test failed because `writeAnalysis` still sent `UF_CRM_S2L_SPEC_MODEL`, `UF_CRM_S2L_SPEC_PDF_HASH`, and `UF_CRM_S2L_SPEC_RESULT_HASH`.
- GREEN: `tests/bitrix/analyzeGzSpecs.test.ts` passed 34/34 tests and `npm run lint` passed.
- Regression: `npm test` passed 277/277 tests.
- Focused coverage completed successfully. The monolithic CLI module remains at 49.55% line coverage overall; the newly asserted `writeAnalysis` behavior is executed directly.

## Guarantees and live verification

| Guarantee | Evidence |
|---|---|
| Future analysis updates omit all three technical fields | `SpecDealClient.writeAnalysis` unit test |
| Verdict and other user-facing analysis fields are still written | Same unit test and existing analyzer tests |
| Timeline hash marker still protects comments from duplicates | Existing idempotency tests |
| Existing GZ lot deals no longer contain visible technical values | Bitrix cleanup: 43 cleared, verification found 0 remaining |

The custom field definitions were retained in Bitrix to avoid destructive schema deletion. Only their values on `scrape2lead-gz-lots` deals were cleared.
