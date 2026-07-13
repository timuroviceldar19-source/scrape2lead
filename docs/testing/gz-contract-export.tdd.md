# TDD evidence: GZ contract export

Date: 2026-07-13

## RED

- `b65ea1f`: added fixture-based tests for the contract search table, pagination, general information, contract units, parties, sequential code processing, deduplication, missing identifiers, failures and `--limit`.
- `36ba531`: added a failing regression test for the public registry returning no rows when its ENSTRU filter is submitted.
- A final RED check asserted that identifier and ENSTRU columns use Excel text format; it failed with `expected undefined to be "@"` before the writer was hardened.

## GREEN

- `31c3d45`: implemented the parsers, exporter, CLI, configuration, package command and README documentation.
- `f713a96`: implemented discovery through public lots and purchase numbers when the portal's contract ENSTRU filter returns no rows. Every accepted contract is still validated against its signing date, unit code and party details.
- The workbook writer now explicitly formats customer identifiers, supplier identifiers and ENSTRU codes as text.

## Verification

- Focused tests: 11 passed.
- New-contour coverage: 89.35% statements/lines, 96.42% functions.
- Project checks: `npm run build`, `npm run lint`, and the full `npm test` suite passed (31 files, 288 tests).
- Real public crawl for 2026-01-01 through 2026-07-13 completed with 217 rows: 8 for `279020.100.000001`, 209 for `262030.100.000021`, and 0 for `262030.100.000043`.
- Workbook validation found five expected columns, no blank/invalid customer or supplier identifiers, no unexpected codes and no formula errors. XLSX XML stores identifiers as shared strings, preserving leading zeroes.
- `npm audit` reports three existing transitive advisories: one low in Vite/esbuild and two moderate in ExcelJS/uuid. The suggested complete fix requires a breaking ExcelJS downgrade, so it was not applied.

## Portal limitation

The public registry currently ignores or rejects the ENSTRU contract filter used by its form. The fallback finds contracts connected to public lots, then verifies the exact code inside each contract. Direct contracts that have no discoverable purchase/lot number cannot be found through this fallback; the exporter reports that the fallback was used rather than silently treating it as the native filter.
