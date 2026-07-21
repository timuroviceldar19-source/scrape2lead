# External procurement sources — TDD evidence

Date: 2026-07-21

## Scope

MITWORK and Samruk records from the Unified Procurement Platform, public Tizilim tenders,
normalization, filtering, persistence, XLSX review workflow, Bitrix dry-run planning and the
production release gate for category `1` / stage `C1:NEW`.

## RED checkpoints

- `edc6a8f` — source parsers, filters, persistence, workbook model and Bitrix lifecycle.
- `bf00c47` — pagination/collection and dry-run/push planner.
- `01bbb93` — upstream plan-to-tender identity.
- `873dbc6` — XLSX writer.
- `9912446` — production configuration.
- `5af153c` — seven-run release gate.
- `d0832a9` — per-source XLSX statistics.
- `e59eb8d` — eligible-customer BIN enrichment.
- `525ace2` — ambiguous-panel quarantine.
- `e91d077` — inactive and missing plan statuses.

Each checkpoint was executed and observed failing before its implementation commit.

## GREEN verification

- Targeted procurement suite: 11 files, 26 tests passed.
- Full suite: 68 files passed, 1 skipped; 553 tests passed, 1 skipped.
- `npm run lint`: passed.
- Changed-module coverage: 94.69% statements/lines, 91.54% functions; every executable
  procurement module has more than 80% line coverage.
- XLSX verification with `@oai/artifact-tool`: four sheets present, expected row counts,
  no formula errors, Summary rendered successfully.

## Read-only manual runs

Five iterative XLSX → inspection → dry-run cycles were performed. The final control run
collected 325 records and classified 28 as Data, 63 as Review and 234 as Rejected. Bitrix
dry-run planned 28 creates, 0 updates, found 0 duplicates and produced 0 errors. It made no
CRM writes.

The earlier runs exposed and drove fixes for missing BIN enrichment, ambiguous generic LCD
panels, and inactive plan statuses. They are not counted as production-admission runs.

## Production admission status

Not admitted. The configuration keeps `bitrix.executeEnabled=false`; execution also requires
seven unique clean entries in `data/procurement-manual-runs.json`. Assignment verification is
still pending because a Bitrix category-1 robot must first round-robin test deals among users
`2015`, `2209`, and `2255` and those deals must appear in each manager's “Мои”. Daily scheduling
must remain disabled until that external check succeeds.

## Dependency audit

`npm audit --omit=dev` reports pre-existing advisories in `brace-expansion` (high) and the
`exceljs` dependency chain through `uuid` (moderate). No automatic dependency mutation was
made because the proposed full fix downgrades ExcelJS across the repository.
