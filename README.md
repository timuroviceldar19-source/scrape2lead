# Scrape2Lead v1.7

Local TypeScript MVP for collecting and normalising B2B leads. Platform core + `2gis` source adapter.

## What is included

- CLI job runner (`source`, `geo`, `category`, `limit`).
- Source adapter contract: `searchCompanies`, `listCards`, `getCardDetail`, `getContacts`, `normalize`, `capabilities`.
- 2GIS adapter — Playwright browser session, JSON API capture, DOM fallback, CAPTCHA detection, fixture mode.
- SQLite storage via `better-sqlite3` with versioned migrations and `UNIQUE(source, external_id)` deduplication.
- Lead normaliser: phones, email, URL, social links, incomplete flag.
- CSV/XLSX export.
- Proxy rotator with channel/IP tracking and per-attempt proxy ID recording.
- Job telemetry: success/partial/failed rates, captcha count, ban count, proxy rotation count, average parse time, cards-per-hour.
- Unit and integration tests (Vitest).

## Requirements

- Node.js >= 20
- npm >= 9

## Setup (clean machine)

```bash
npm install
npx playwright install chromium
cp .env.example .env          # fill in values if using a proxy
cp config.example.json config.json  # adjust as needed
```

## Development

```bash
npm run build     # compile TypeScript → dist/
npm test          # run the full test suite
npm run lint      # type-check without emitting (reports type errors)
npm run dev -- --help  # run CLI via tsx without building
```

## Run against a saved fixture (no network required)

```bash
npm run dev -- --fixture tests/fixtures/2gis-response.json \
               --geo moscow --category autoservice --limit 10
```

## Run against 2GIS live

```bash
npm run dev -- --config config.json --geo moscow --category autoservice --limit 25 --headed
```

> **Note:** 2GIS selectors and API response shapes can change without notice.  
> A CAPTCHA is logged as a runtime event and the adapter saves a JSON evidence snapshot under `raw_snapshots/`.

## Environment variables

Copy `.env.example` to `.env` and fill in values. Variables:

| Variable | Description |
|---|---|
| `PROXY_API_URL` | Rotation endpoint — GET returns a new proxy URL (JSON or plain text). Leave blank to disable rotation. |
| `PROXY_SERVER` | Static proxy fallback (`http://host:port` or `socks5://host:port`). |
| `PROXY_USERNAME` | Proxy username (optional). |
| `PROXY_PASSWORD` | Proxy password (optional). |

## Project layout

```
src/
  adapters/     source adapter implementations and registry
  browser/      Playwright session manager
  core/         JobManager, RateLimiter, backoff, telemetry
  export/       CSV/XLSX export
  proxy/        ProxyRotator
  storage/      Storage class and SQLite migrations
  types.ts
  cli.ts
tests/          Vitest test suite
data/           SQLite databases (runtime, excluded from git)
exports/        CSV/XLSX output (runtime, excluded from git)
raw_snapshots/  Evidence snapshots (runtime, excluded from git)
```
