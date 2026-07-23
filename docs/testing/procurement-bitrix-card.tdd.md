# Procurement Bitrix card TDD evidence

## Scope

Improve category `1` (`F3-B2B тендеры`) so enriched procurement data is written to dedicated Bitrix fields and the common deal form contains only procurement-focused sections.

## User journeys

- A manager opens a procurement deal and sees customer, plan, product, price, quantity, delivery and source data without expanding a generic comment.
- A manager does not see unrelated sales, technical-test or UTM sections in this category.

## RED evidence

- `npm test -- --run tests/bitrix/procurementDealPlan.test.ts` — failed because enriched Excel fields were absent from the deal payload.
- `npm test -- --run tests/bitrix/procurementDealLayout.test.ts` — failed because `procurementDealLayout` did not exist.
- Checkpoints: `876faac`, `97c0c40`.

## GREEN evidence

| Guarantee | Test | Result |
|---|---|---|
| Enriched plan fields map to visible Bitrix fields and the comment retains KATO/contact/enrichment details | `tests/bitrix/procurementDealPlan.test.ts` | PASS |
| Category 1 form has six procurement sections and excludes unrelated legacy sections | `tests/bitrix/procurementDealLayout.test.ts` | PASS |

- Target command: `npm test -- --run tests/bitrix/procurementDealPlan.test.ts tests/bitrix/procurementDealLayout.test.ts` — 5 tests passed.
- Full suite: `npm test` — 568 passed, one pre-existing optional E2E test skipped.
- Type/lint gate: `npm run lint` — PASS.
- Coverage command: `npm run test:coverage -- --run tests/bitrix/procurementDealPlan.test.ts tests/bitrix/procurementDealLayout.test.ts`.
  - `procurementDealLayout.ts`: 100% statements/branches/functions/lines.
  - `procurementDealPlan.ts`: 99.28% statements/lines, 91.04% branches, 100% functions.

## Live verification

- Applied the common form configuration only to deal category `1`.
- Created exactly one verified deal, ID `42989`, from source plan `19760305`.
- REST read-back confirmed customer BIN, plan status/link, ЕНС ТРУ, descriptions, quantity, unit price and delivery addresses.
- Chrome inspection confirmed the six intended sections and absence of `Техническое заключение`, `Тестовый раздел`, payment controls and duplicate delivery fields.

## 2026-07-23 regression fix

- RED: the card layout test failed because `UF_CRM_1782386293000_IU_XLS` was absent; the
  assignment/config tests failed because the old manager pool was still active.
- GREEN: 10 targeted tests passed after exposing “№ пункта плана” and changing the only allowed
  assignee to Саматбек Нурматов (`2255`).
- Full suite: 572 tests passed, one optional E2E test skipped; `npm run lint` passed.
- Changed source modules reached 100% statement/line coverage.
- Live layout read-back confirmed six sections, visible plan-point number and plan link, and no
  duplicate technical `UF_CRM_PLAN_ID` field.
- Chrome confirmed deal `43001` displays “№ пункта плана” with value `19760324`.
- The category-1 robot now uses one concrete responsible user, `2255`, with both absence and
  completed-workday skipping disabled. Existing deals were not reassigned.
