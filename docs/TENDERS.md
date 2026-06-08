# KZ Tenders Pipeline

Stage 1 consolidates `zakup.sk.kz` and `goszakup.gov.kz` into one tender pipeline. The public entrypoint is:

```bash
npm run kz:tenders -- bins.csv
```

`scripts/zakup-collector.ts` is deprecated and delegates to the same pipeline for `zakup.sk.kz` only.

## Sources

- `zakup.sk.kz`: Playwright collection from `https://zakup.sk.kz/#/lots` with API capture after submitting a company-name search. Company names come from `stat_gov_data`. Text-based discovery — use `zakupTenderFilter` for relevance gating.
- `goszakup.gov.kz`: REST v3 API at `https://ows.goszakup.gov.kz/v3/trd-buy/bin/{BIN}`. BIN-based verified lookup with pagination. If `GOSZAKUP_TOKEN` is missing, this source is skipped without failing the batch.

**API docs:** https://goszakup.gov.kz/ru/developer/ows_v3

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
npm run kz:enrich -- bins.csv --skip-zakup               # goszakup only
npm run kz:enrich -- bins.csv --goszakup-active-only      # only active tenders
npm run kz:enrich -- bins.csv --goszakup-max-pages 10
npm run kz:enrich -- bins.csv --delay-ms 2000
npm run kz:enrich -- bins.csv --force-refresh
```

## Goszakup API v3

**Endpoint:** `GET https://ows.goszakup.gov.kz/v3/trd-buy/bin/{BIN}`

**Response:**
```json
{
  "total": 32,
  "limit": 50,
  "next_page": "/v3/trd-buy/bin/{BIN}?page=next&search_after=...",
  "items": [{ "id", "number_anno", "name_ru", "customer_name_ru", "org_bin", ... }]
}
```

**Pagination:** Follow `next_page` until empty string. Max pages controlled by `GOSZAKUP_MAX_PAGES` (default 20).

**Active filter:** `GOSZAKUP_ACTIVE_ONLY=1` keeps only tenders with `ref_buy_status_id` in the active set (default: 210, 220). Override with `GOSZAKUP_ACTIVE_STATUS_IDS=210,220`.

**HTTP retry:** 429 and 5xx errors retry with exponential backoff (max 3 attempts). 401/403 records an enrich error and stops.

**Status names:** Loaded from `/v3/refs/ref_buy_status` and cached per batch.

### Smoke Test

```bash
npm run kz:goszakup:smoke -- 061040006408
```

Read-only check: requires `GOSZAKUP_TOKEN`, prints pages/raw/accepted counts and first 3 tenders.

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

## Zakup Relevance Filter

`zakup.sk.kz` performs a **text search**, not a BIN lookup. The portal's default feed returns lots unrelated to the searched company. To prevent false positives, `filterZakupTenders()` applies two gates:

| Gate | Logic |
|---|---|
| **title match** | At least 1 meaningful token from the company name (after normalization and generic-word removal) must appear in `tender_name`. |
| **default feed** | If every tender number in the batch matches `tests/fixtures/zakup-default-feed.json`, the entire batch is rejected. |

**Conservative by default** — a lot is saved only when `hasZakupTitleMatch` is true. 0 saved lots is better than 10 false positives.

`customer_name` is set from `stat_gov_data` **only after** a lot passes the filter. Lots that are rejected are never persisted.

For verified supplier data, use `goszakup.gov.kz` (BIN-based lookup with token).

## Goszakup Public Registry (no token)

Stage 3.5 adds a **public registry collector** that scrapes `goszakup.gov.kz/ru/registry/supplierreg` — no `GOSZAKUP_TOKEN` required. This supplements stat.gov data with contact info (phone, email, website) and registry metadata (participant number, role).

### What it provides vs other sources

| Source | Data |
|---|---|
| stat.gov | Registration, ОКЭД, director, legal status |
| **goszakup registry** | **Phone, email, website, participant ID, role, residency** |
| goszakup API (token) | Tender history by BIN |

### Commands

```bash
npm run kz:registry -- bins.csv
npm run dev -- kz registry bins.csv
npm run dev -- kz enrich bins.csv --skip-tenders --skip-stat    # registry only
npm run dev -- kz enrich bins.csv --skip-goszakup-registry       # disable registry
npm run dev -- kz enrich bins.csv --registry-only                # registry only (alias)
```

### TTL cache

Registry records are cached for 7 days by default. Override with `GOSZAKUP_REGISTRY_CACHE_TTL_DAYS` in `.env`. Use `--force-refresh` to bypass.

### Storage

Data goes to `goszakup_registry_data` table (migration v13), joined into the Companies sheet at export via `bin`.
