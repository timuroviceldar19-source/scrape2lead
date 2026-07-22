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

## Known gap

- The existing round-robin robot still leaves the webhook user `2301` responsible; assignment is a separate Bitrix automation issue and was not hidden by this card-layout change.
