# Scrape2Lead — KZ Company Intelligence

TypeScript CLI for enriching **Kazakhstan companies by BIN**: stat.gov.kz legal data, goszakup registry contacts, and public procurement contracts — with optional **2GIS/Kaspi feeder** for phone/address leads.

**Product focus (v2):** CSV of BINs → enrich → scored XLSX for sales and tender monitoring.

**Legacy layer (v1.7):** 2GIS/Kaspi scrape adapters, enrichment, proxy rotation — still in the repo as a feeder, not the primary acceptance path.

Spec: [`docs/TZ_v2.md`](docs/TZ_v2.md) · Batch ops: [`docs/kz-batch-runbook.md`](docs/kz-batch-runbook.md)

---

## Quick start (KZ)

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Prepare `bins.csv` (one 12-digit BIN per line, header `bin` optional):

```text
bin
061040006408
960440000716
```

```bash
npm run kz:login                              # stat.gov QR session (operator step)
npm run dev -- kz enrich bins.csv             # stat + registry + tenders
npm run kz:export -- --bins bins.csv          # XLSX: Companies, Tenders, Summary, Errors
```

Harvest TOO BINs from goszakup public registry:

```bash
npm run kz:harvest -- 50 bins-batch-50.csv
```

---

## Data sources

| Source | Role | Auth |
|--------|------|------|
| **stat.gov.kz** | Primary: name, OKED, director, address, registration | QR via egov mobile (`kz:login`) |
| **goszakup registry** | Phone, email, website, participant ID | Public HTML (no token) |
| **goszakup HTML** | Supplier **contracts** by BIN | Public site (Playwright) |
| **goszakup API** | Tenders by BIN | `GOSZAKUP_TOKEN` (optional) |
| **zakup.sk.kz** | Samruk-Kazyna lots by company name | Public (conservative filter) |
| **2GIS / Kaspi** | Feeder: contacts + company names → BIN backfill | Public scrape |

Without `GOSZAKUP_TOKEN`, contracts still load via **goszakup HTML**; API tenders are skipped.

---

## KZ commands

| Command | Description |
|---------|-------------|
| `npm run kz:login` | Save stat.gov session to `data/stat-gov-session.json` |
| `npm run kz:enrich -- bins.csv` | Full enrich pipeline (same as `dev -- kz enrich`) |
| `npm run kz:registry -- bins.csv` | goszakup public registry only |
| `npm run kz:export -- --bins bins.csv` | KZ XLSX with lead scoring columns |
| `npm run kz:export-top-a` | Sales slice: priority **A** from scored batch export |
| `npm run kz:merge` | Write stat.gov fields back into `leads` table |
| `npm run kz:export-unified` | Unified XLSX: 2GIS leads + KZ + scoring |
| `npm run kz:feeder-top-a -- bins.csv` | Top-A feeder: 2GIS → backfill BIN → enrich → unified |
| `npm run kz:audit -- bins.csv` | Quality audit workbook (zakup heuristics) |
| `npm run kz:harvest -- N out.csv` | Harvest TOO BINs from goszakup registry |

CLI equivalents: `npm run dev -- kz login|enrich|export|merge|export-unified …`

### Enrich flags (partial reruns)

```bash
npm run dev -- kz enrich bins.csv --skip-stat
npm run dev -- kz enrich bins.csv --skip-tenders
npm run dev -- kz enrich bins.csv --registry-only
npm run dev -- kz enrich bins.csv --force-refresh --delay-ms 2000
```

### Unified export (2GIS + KZ)

```bash
npm run dev -- kz merge
npm run dev -- kz export-unified --priority A --out exports/unified.xlsx
npm run dev -- kz export-unified --enrich-missing --priority A   # auto-enrich lead BINs first
```

Leads sheet includes **2GIS phone/address** when matched by BIN or fuzzy name.

### Top-A feeder (2GIS → sales file)

```bash
cp config.feeder.example.json config.feeder.json   # local config, not committed
cp config.feeder.astana.example.json config.feeder.astana.json   # optional 2nd city

# Single city, 4 construction categories × 35 cards
npm run kz:feeder-top-a -- bins-batch-100.csv

# Multi-city scrape (Almaty + Astana)
npm run kz:feeder-top-a -- bins-batch-100.csv \
  --config config.feeder.json \
  --config config.feeder.astana.json

# --skip-2gis  --out exports/foo.xlsx  --top-a-csv bins-top-a.csv
```

Feeder runs: top-A extract → 2GIS scrape(s) → batch BIN backfill → enrich → merge → unified export.
Uses `data/scrape2lead.db` by default (`KZ_DATABASE_PATH` to override).

---

## Exports

| File | Contents |
|------|----------|
| KZ export (`kz:export`) | Companies + Tenders + Summary + Errors; scoring columns (`Приоритет лида`, `High volume`, `Stat missing`) |
| Unified export | **Leads** (2GIS contacts + KZ match) + Tenders + Summary + Errors |
| Top-A slice (`kz:export-top-a`) | Priority A companies sorted by active contract budget |

Runtime output: `exports/` (gitignored).

---

## Development

```bash
npm run build
npm test
npm run lint
npm run dev -- --help
npm run dev -- kz --help
```

KZ tests: `npx vitest run tests/kz`

Requirements: Node.js ≥ 20, npm ≥ 9, Playwright Chromium.

---

## Environment variables

Copy `.env.example` → `.env`.

| Variable | Description |
|----------|-------------|
| `GOSZAKUP_TOKEN` | Bearer token for goszakup OWS API (optional) |
| `STAT_GOV_SESSION_PATH` | stat.gov session file (default: `data/stat-gov-session.json`) |
| `STAT_GOV_CACHE_TTL_DAYS` | stat.gov cache TTL (default: 7) |
| `KZ_ENRICH_DELAY_MS` | Pause between BINs (default: 2000) |
| `GOSZAKUP_REGISTRY_CACHE_TTL_DAYS` | Registry cache TTL (default: 7) |
| `KZ_DATABASE_PATH` | SQLite path for KZ/feeder (default: `data/scrape2lead.db`) |
| `STORAGE_BACKEND` | `sqlite` (default) or `postgres` |
| `POSTGRES_CONNECTION_STRING` | Required when `STORAGE_BACKEND=postgres` |
| `PROXY_*` | Optional proxy rotation for 2GIS/Kaspi scrape |

Session files and tokens stay in `data/` / `.env` — never commit them.

---

## Legacy: 2GIS / Kaspi scrape (v1.7)

Platform core: adapter contract, JobManager, normalizer, proxy rotator, telemetry, SQLite/Postgres storage.

```bash
cp config.example.json config.json
npm run dev -- --config config.json --geo "Алматы" --category "Автосервисы" --limit 25
```

Fixture mode (no network):

```bash
npm run dev -- --fixture tests/fixtures/2gis-response.json \
               --geo astana --category autoservice --limit 10
```

2GIS remains useful as a **feeder** (phones + names) merged with KZ data via `kz:merge` and `kz:export-unified`. See [`docs/prompts/gpt-stage5-2gis-leads.md`](docs/prompts/gpt-stage5-2gis-leads.md).

---

## Project layout

```
src/
  kz/           stat.gov, goszakup, zakup collectors, scoring, unified export
  adapters/     2GIS, Kaspi source adapters
  enrichment/   contact enrichment and lead scoring (legacy)
  storage/      SQLite migrations + Postgres backend
  export/       CSV/XLSX helpers
  core/         JobManager, rate limiter, telemetry
  cli.ts        Main CLI + `kz` subcommands
scripts/        Collectors, feeder, harvest, smoke tests
docs/           TZ v2, runbooks, stage prompts
data/           SQLite DBs, sessions (runtime, gitignored)
exports/        XLSX/CSV output (runtime, gitignored)
```

---

## Documentation map

| Doc | Purpose |
|-----|---------|
| [`docs/TZ_v2.md`](docs/TZ_v2.md) | Full spec: sources, schema, acceptance criteria |
| [`docs/kz-batch-runbook.md`](docs/kz-batch-runbook.md) | 50–100 BIN batch, audit, quality gates |
| [`docs/TENDERS.md`](docs/TENDERS.md) | goszakup HTML contracts vs announces |
| `scrape2lead_tz_v1.7.md` | Original 2GIS platform spec (archived priority) |
