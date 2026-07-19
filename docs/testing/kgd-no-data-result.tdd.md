# TDD evidence: KGD no-data result

## Source and user journey

The journey was derived from the user's live observation on 20.07.2026: when KGD renders `Данные не найдены`, the check must complete as a negative result instead of consuming another CapSolver attempt and entering manual fallback.

## RED / GREEN evidence

- RED checkpoint `5a57ea4`: `npm test -- tests/kz/kgdCaptchaAutomation.test.ts` executed the new Playwright scenario and failed because the current outcome observer could not recognize rendered no-data text.
- GREEN checkpoint `8927fbc`: the observer accepts the no-data phrase from either a JSON response or rendered page text. Manual waiting uses the same observer.

| Guarantee | Test | Type | Result |
|---|---|---|---|
| Rendered `Данные не найдены` resolves to a successful payload with `isLiquidated: false` | `tests/kz/kgdCaptchaAutomation.test.ts` | Playwright integration | PASS |
| Existing callback injection, two-attempt fallback, and first-success behavior remain intact | `tests/kz/kgdCaptchaAutomation.test.ts` | integration/unit | PASS |

## Commands and results

- Target test: 4/4 PASS.
- Full regression: 57 files and 511 tests PASS; one pre-existing E2E test skipped.
- `npm run build`: PASS.
- Full repository coverage: 46.46% lines/statements, 77.83% functions, 76.04% branches. The repository-wide 80% target is not met because executable CLI entrypoints are included with zero coverage. The directly related CAPTCHA automation module remains at 96.55% line coverage; the changed browser observer is exercised by Chromium.

## Known gaps

The live KGD retry was not repeated after the fix to avoid another paid CapSolver request without need. The saved progress for BIN `100740005402` remains reusable for a resumed run.

## Portal-error and no-manual-fallback regression (20.07.2026)

- User journey: when KGD renders `Ошибка при получении данных`, fail the current automatic attempt immediately; after two failed attempts, return control to the batch workflow without opening manual CAPTCHA waiting.
- RED checkpoint `ccd6b41`: the Playwright toast test timed out and the automatic-attempt test resolved to `null`, reproducing both reported behaviors.
- GREEN checkpoint `399dc07`: the rendered/JSON portal error now rejects the attempt, and exhausted automatic attempts throw instead of selecting manual fallback.
- Target result: 5/5 tests PASS; CAPTCHA automation coverage is 96.55% lines/statements and 80% functions.
- Full regression: 57 files and 512 tests PASS; one pre-existing E2E test skipped. `npm run build` PASS.
