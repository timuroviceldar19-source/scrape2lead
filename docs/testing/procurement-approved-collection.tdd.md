# TDD evidence: approved procurement collection

## Source and journeys

The journeys were derived from the user-approved implementation plan in the Codex task.

- Collect every 2026 MITWORK/Samruk plan without silently truncating pagination.
- Admit only plans whose normalized status is `Утвержден`.
- Keep only active published tenders and reject monitoring services that merely contain a similar word.
- Enrich by stable identifiers; name-only Goszakup matches remain review candidates.
- Expose collection completeness and enrichment provenance in XLSX and block production push for incomplete reports.

## RED/GREEN evidence

| Guarantee | Test target | RED evidence | GREEN evidence |
|---|---|---|---|
| EPZ requests include `plan_year_id=9`, approved/published status filters, active deadline and full pagination metadata | `tests/kz/procurementCollector.test.ts` | Targeted run: 3 intended failures because collector returned a plain array | Targeted run: 3/3 passed |
| Only normalized `Утвержден` plans are accepted; `мониторинг` is not a monitor | `tests/kz/procurementFilter.test.ts` | Targeted run: 2 intended failures | Targeted run: 7/7 passed |
| Stable EPZ enrichment records exact provenance | `tests/kz/procurementEnrichment.test.ts` | Targeted run: 2 intended failures | Targeted run: 2/2 passed |
| Goszakup stable-key matches can fill fields while exact-name matches remain candidates | `tests/kz/procurementGoszakupEnrichment.test.ts` | Module missing and config field absent | Targeted run: 3/3 passed |
| XLSX contains completeness and enrichment columns | `tests/kz/procurementWorkbook.test.ts` | Targeted run: 2 intended failures | Targeted run: 2/2 passed |
| Incomplete collection blocks production execution | `tests/kz/procurementReleaseGate.test.ts` | Gate function missing | Targeted run: 2/2 passed |
| The production query avoids the EPZ `offset > 10000` ceiling | `tests/kz/procurementConfig.test.ts` | Config still contained the broad OR query | Targeted run passed after using `Компьютер` with downstream code filtering |

## Validation

- `npm test` — PASS.
- `npm run lint` — PASS.
- `npm run test:coverage` — PASS; changed procurement modules have 80.46–100% line coverage.
- Live XLSX collection — PASS: 11,761 records, 152 pages, `collection.complete=true`, all 11,235 plans have status `Утвержден`.
- Bitrix dry-run — PASS: 22 create, 0 update, 0 duplicate, 0 failed; no deals created.
- XLSX visual verification — PASS for `Data`, `Review`, `Rejected`, and `Summary`; formula-error scan returned zero matches.

## Known constraints

- `planYearId=9` is the explicit 2026 EPZ identifier and must be updated for a future plan year.
- Rows without a confirmed PK code remain in `Review`; Goszakup name matches never make a row CRM-eligible.
- The first diagnostic control run was intentionally retained as incomplete evidence after EPZ returned HTTP 400 at offset 10,000.
