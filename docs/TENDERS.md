# KZ Tenders Pipeline

Stage 1 consolidates `zakup.sk.kz` and `goszakup.gov.kz` into one tender pipeline. The public entrypoint is:

```bash
npm run kz:tenders -- bins.csv
```

`scripts/zakup-collector.ts` is deprecated and delegates to the same pipeline for `zakup.sk.kz` only.

## Sources

- `zakup.sk.kz`: Playwright collection from `https://zakup.sk.kz/#/lots` with API capture after submitting a company-name search. Company names come from `stat_gov_data`.
- `goszakup.gov.kz`: REST call to `https://ows.goszakup.gov.kz/trd-buy/biin/<BIN>`. If `GOSZAKUP_TOKEN` is missing, this source is skipped without failing the batch.

## Unified Schema

`tender_data` is created by SQLite migration v11, not by collector scripts.

```sql
source TEXT NOT NULL,
bin TEXT NOT NULL,
tender_number TEXT NOT NULL,
tender_name TEXT NOT NULL,
customer_name TEXT,
budget_amount TEXT,
currency TEXT DEFAULT 'KZT',
start_date TEXT,
end_date TEXT,
status TEXT,
method TEXT,
url TEXT,
parsed_at TEXT NOT NULL,
UNIQUE(source, bin, tender_number)
```

Every row must have `source` set to either `zakup.sk.kz` or `goszakup.gov.kz`.

## Full KZ Flow

```bash
npm run kz:login
npm run kz:enrich -- bins.csv
npm run kz:export -- --out exports/kz-report.xlsx
npm run kz:merge
```

Useful flags:

```bash
npm run kz:enrich -- bins.csv --skip-stat
npm run kz:enrich -- bins.csv --skip-tenders
npm run kz:enrich -- bins.csv --delay-ms 2000
npm run kz:enrich -- bins.csv --force-refresh
```

`stat_gov_data` is cached by `updated_at`. Default TTL is 7 days and can be changed with `STAT_GOV_CACHE_TTL_DAYS`; `--force-refresh` bypasses the cache.

## XLSX Export

```bash
npm run kz:export
npm run dev -- kz export --bins bins.csv --out exports/kz-report.xlsx
```

The workbook has four sheets:

- `Companies`: stat.gov company cards plus tender aggregates.
- `Tenders`: flat tender records with company name.
- `Summary`: totals by company coverage, source and tender status.
- `Errors`: rows from `kz_enrich_errors`.

## Input

`bins.csv` can be a single-column CSV with or without a `bin` header:

```text
220540025781
010140001234
```

Only 12-digit BIN values are processed.

## Goszakup Token

Set the token in `.env`:

```bash
GOSZAKUP_TOKEN=your_token_here
```

Without the token, `zakup.sk.kz` still runs and `goszakup.gov.kz` is reported as skipped.
