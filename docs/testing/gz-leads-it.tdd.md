# IT supplier lead export — TDD evidence

Source plan: user-provided implementation request in this task.

## User journeys

- A sales operator can receive a ranked XLSX list of IT-equipment suppliers in Astana and Almaty with valid phone numbers.
- A sales operator can retain viable suppliers from other cities and suppliers without usable phones on separate sheets.

## Evidence

| Guarantee | Test or command | Result |
|---|---|---|
| Kazakhstan phone numbers are normalized and obvious junk is rejected | `tests/kz/goszakupLeads.test.ts` | PASS |
| City detection, 18-month dormant rule, ranking and phone deduplication work | `tests/kz/goszakupLeads.test.ts` | PASS |
| Existing contract export remains compatible after its lead-collection callback was added | `tests/kz/goszakupContractExporter.test.ts` | PASS |
| Full repository suite and typecheck pass | `npm test`; `npm run lint` | 711 passed, 4 skipped; PASS |

The new-lead tests were RED before the module existed (`Cannot find module ../../src/kz/goszakupLeads.js`) and GREEN after implementation.

## Coverage and known gap

`npm run test:coverage` completed successfully. Repository-wide statement coverage is 52.11% because many pre-existing CLI scripts are not exercised; the new pure lead-selection module is 100% statements and lines. A real portal run was attempted but stopped after two minutes with no first response from goszakup; it produced no workbook or partial output.
