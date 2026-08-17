# KATO tender export — TDD evidence

## Source and user journey

The user requested a reusable Goszakup lot export and a live XLSX for August–December 2026, filtered only by five delivery-place KATO codes and four active publication statuses.

As a tender analyst, I want one deduplicated workbook for the requested settlements so that I can review every currently active goods, works and services lot without product or amount restrictions.

## RED → GREEN evidence

- RED: `npm test -- --run tests/kz/goszakupLotsNstruExporter.test.ts` executed 20 tests with 7 intended failures before KATO support (`136c74d`). Missing behaviors were KATO-only URLs, page-limit safety, location merging, the geography config and the delivery-place column.
- GREEN: the same command passed 20/20 after the minimal implementation (`6942dbc`).
- Workbook usability RED: the target suite then had 1 intended failure for missing frozen header/filter/styling (`6f1eb1a`).
- Workbook usability GREEN: the target suite passed 20/20 after formatting, numeric amounts and hyperlink styling (`c1dee26`).

## Test specification

| Guarantee | Evidence | Result |
|---|---|---|
| A KATO-only search URL contains `filter[kato]` and all four status filters without name/NSTRU filters | `tests/kz/goszakupLotsNstruExporter.test.ts` | PASS |
| More result pages than `maxPages` raises an explicit truncation error | same target | PASS |
| Duplicate lot numbers merge matched delivery places into one row | same target | PASS |
| Config contains the five requested KATO codes, months 8–12, four active statuses and no product/amount filters | same target | PASS |
| XLSX contains the KATO/location columns, styled frozen header, auto-filter, numeric amount and clickable lot link | same target | PASS |
| Repository typecheck/build and regression suite remain green | `npm run lint`; `npm run build`; `npm test` | PASS — 838 passed, 4 skipped |

## Live export validation

- Command: `npm run kz:export-lots-nstru -- --config config/gz-lots-balkhash-aktogay.json`.
- Result: 53 rows from 5 KATO queries across months 8–12; 53 unique lot numbers and no pagination truncation.
- Distribution: 50 August rows and 3 September rows. Later configured months currently have no matching active lots.
- Geography: 41 Балхаш rows, 11 Актогай-only rows and 1 row matching both Шашубай and Актогай. Саяк and Торангылык currently have no matching active lots.
- Statuses: 4 `Опубликован`, 10 `Опубликован (прием заявок)`, 39 `Опубликован (прием ценовых предложений)`; no unexpected status.
- Workbook inspection: one sheet, `A1:O54`, no formula-error tokens, frozen row 1, auto-filter `A1:O54`, numeric amount cells and complete lot/announcement hyperlinks.

## Coverage and known gaps

- `npm run test:coverage` passed all tests. Current repository-wide coverage is 53.54% statements / 76.25% branches / 82.70% functions / 53.54% lines; the existing browser exporter module is 53.26% statements and 91.07% branches. The repository does not currently meet an 80% global statements/lines threshold because many CLI entrypoints are included with zero coverage.
- `npm audit --audit-level=high` reports 11 existing dependency advisories (8 high) in transitive packages including Wrangler/Miniflare and ExcelJS dependencies. No dependency files were changed for this export, and automatic fixes were not applied because several proposed fixes are breaking or outside configured ranges.
