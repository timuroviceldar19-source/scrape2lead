# Промпт для GPT: Этап 2 — CLI, кэш, агрегаты, KZ export

**База:** commit `ab7457c` (Этап 1 завершён).  
**Спека:** `docs/TZ_v2.md` §8 Этап 2 + §6 Export.  
**Проект:** `C:\Users\Madara\Desktop\Scrapper`

Скопируй блок «ЗАДАНИЕ» ниже целиком в GPT/Cursor.

---

## ЗАДАНИЕ

Ты работаешь в репозитории **Scrape2Lead** после успешного Этапа 1 (`feat(kz): consolidate stat.gov and tenders pipeline`).

**Цель Этапа 2:** довести KZ pipeline до **продуктового MVP** — одна точка входа через `cli.ts`, кэш stat.gov, агрегаты закупок на карточке компании, **XLSX export** (Companies / Tenders / Summary / Errors).

**Не трогай:** 2GIS/Kaspi scrape path, enrichment scoring logic, unrelated unstaged files (Assets/, старые 2GIS scripts), падающие тесты `exporter.test.ts` и `postgresMigrationOrdering.test.ts` — чини только если твои изменения их затронули.

**Стек:** Node 20+, TypeScript, Commander, better-sqlite3, exceljs, vitest, Playwright (уже в `src/kz/`).

---

## Что уже есть (не переписывай с нуля)

```
src/kz/
  statGovParser.ts, statGovCollector.ts
  zakupCollector.ts, goszakupCollector.ts
  tendersPipeline.ts, tenderTypes.ts
  normalizeCompanyName.ts, csv.ts
scripts/kz-enrich.ts          — оркестратор enrich
scripts/stat-gov-login.ts
npm run kz:login | kz:enrich | kz:tenders | kz:merge
Миграция v11: stat_gov_data, tender_data(source, bin, tender_number)
tests/kz/* — 15 tests pass
```

Логику Playwright/API **делегируй** в существующие `src/kz/*` модули. Этап 2 — интеграция и продуктовый слой, не rewrite collectors.

---

## Задачи (обязательно)

### 1. KZ Storage layer — `src/kz/kzStorage.ts`

Единый доступ к SQLite для KZ (используй `runMigrations`, путь `data/scrape2lead.db` или env):

```typescript
// Минимальный контракт:
getStatGovByBin(bin: string): StatGovRecord | null
getStatGovByBins(bins: string[]): StatGovRecord[]
isStatGovFresh(bin: string, ttlDays: number): boolean
getTendersByBin(bin: string): TenderRecord[]
getTendersByBins(bins: string[]): TenderRecord[]
getCompanyCards(bins?: string[]): CompanyCard[]  // stat + aggregates
upsertStatGov(record: StatGovRecord): void       // для collector reuse
upsertTenders(records: TenderRecord[]): void
recordEnrichError(bin: string, stage: string, message: string): void
getEnrichErrors(): EnrichError[]
```

**`CompanyCard`** (добавь в `src/kz/tenderTypes.ts`):

- все поля `StatGovRecord`
- `tender_count_total: number`
- `tender_count_active: number` — статусы `PUBLISHED`, `ACTIVE` (case-insensitive; задокументируй список)
- `tender_budget_sum: number | null` — sum `budget_amount` как number
- `tender_sources: string` — comma-separated distinct sources
- `last_tender_end_date: string | null`

Агрегаты — SQL `GROUP BY bin` с JOIN `stat_gov_data` LEFT JOIN `tender_data`.

**Тест:** `tests/kz/kzStorage.test.ts` — in-memory sqlite, seed 2 companies + tenders, проверь aggregates.

### 2. Кэш stat.gov с TTL

В `collectStatGovForBins` (`src/kz/statGovCollector.ts`):

- Перед Playwright-запросом: если `kzStorage.isStatGovFresh(bin, ttlDays)` → skip, `stats.cached++` (добавь поле в `StatGovCollectStats`).
- `ttlDays` из `options.cacheTtlDays ?? Number(process.env.STAT_GOV_CACHE_TTL_DAYS ?? 7)`.
- Флаг CLI `--force-refresh` — игнорировать кэш.
- Freshness = `updated_at` в `stat_gov_data` моложе TTL.

**Тест:** unit на `isStatGovFresh` logic (можно через kzStorage + fake dates).

### 3. Таблица ошибок enrich (миграция v12)

В `src/storage/migrations.ts` migration `version: 12`:

```sql
CREATE TABLE IF NOT EXISTS kz_enrich_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bin TEXT NOT NULL,
  stage TEXT NOT NULL,   -- 'stat_gov' | 'zakup' | 'goszakup'
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_kz_enrich_errors_bin ON kz_enrich_errors(bin);
```

Коллекторы при fail пишут сюда через `kzStorage.recordEnrichError`.

### 4. Тонкие адаптеры — `src/adapters/kz/`

Обёртки над `src/kz/*`, **без дублирования логики**:

```
src/adapters/kz/
  StatGovAdapter.ts      — implements IStatGovAdapter (см. TZ v2 §2.4)
  ZakupTenderAdapter.ts  — ITenderSourceAdapter, source='zakup.sk.kz'
  GoszakupTenderAdapter.ts
  types.ts               — интерфейсы
  index.ts
```

`ZakupTenderAdapter` / `GoszakupTenderAdapter` делегируют в `zakupCollector` / `goszakupCollector`.

`isAvailable()` для goszakup = `Boolean(process.env.GOSZAKUP_TOKEN)`.

**Тест:** `tests/kz/adapters.contract.test.ts` — mock env, проверь `isAvailable()` и что методы вызывают делегаты (vi.mock).

### 5. CLI — подкоманды `kz` в `src/cli.ts`

Используй Commander nested command `program.command("kz")`:

```bash
npm run dev -- kz login              # → stat-gov-login (можно spawn или import)
npm run dev -- kz enrich bins.csv [--skip-stat] [--skip-tenders] [--delay-ms 2000] [--force-refresh]
npm run dev -- kz export [--bins bins.csv] [--out exports/kz-report.xlsx] [--format xlsx]
npm run dev -- kz merge              # merge stat → leads (опционально)
```

- `kz enrich` — рефактор `scripts/kz-enrich.ts`: логика в `src/kz/enrichPipeline.ts`, script = thin wrapper (как сейчас).
- `scripts/kz-enrich.ts` оставь рабочим (вызывает тот же pipeline).
- Не ломай существующие root scrape и `enrich` (2GIS) subcommands.

**package.json** добавь:
```json
"kz:export": "tsx scripts/kz-export.ts"
```

### 6. KZ Export — `src/kz/kzExporter.ts` + `scripts/kz-export.ts`

ExcelJS, русские заголовки (как стиль `src/export/exporter.ts`):

| Лист | Содержимое |
|---|---|
| `Companies` | CompanyCard columns |
| `Tenders` | flat TenderRecord + company name join |
| `Summary` | total companies, with tenders, by source, by tender status |
| `Errors` | из `kz_enrich_errors` |

- Если `--bins csv` — фильтр по списку БИН; иначе все из `stat_gov_data`.
- Output default: `exports/kz-{ISO-timestamp}.xlsx`
- Создавай `exports/` если нет.

**Тест:** `tests/kz/kzExporter.test.ts` — создай xlsx во tmp, проверь sheet names и row count (без бинарного snapshot).

### 7. Полный пайплайн `src/kz/enrichPipeline.ts`

```typescript
export async function runKzEnrich(options: KzEnrichOptions): Promise<KzEnrichResult>
```

- Читает bins из CSV
- stat (с кэшем) → tenders → возвращает summary + errors count
- Используется и из CLI, и из `scripts/kz-enrich.ts`

После успешного enrich опционально логируй: `Run npm run kz:export to generate report`.

### 8. Конфиг env — `.env.example`

Добавь (не коммить реальные значения):

```bash
GOSZAKUP_TOKEN=
STAT_GOV_SESSION_PATH=data/stat-gov-session.json
STAT_GOV_CACHE_TTL_DAYS=7
KZ_ENRICH_DELAY_MS=2000
```

### 9. Документация

- `README.md` — секция KZ: login → enrich → export (3 команды).
- `docs/TENDERS.md` — добавь export и cache TTL.
- Отметь в `docs/TZ_v2.md` §8 Этап 2 чекбоксы как выполненные (только этот раздел, не переписывай весь файл).

---

## Задачи (опционально, если успеваешь)

### A. goszakup pagination

Если API возвращает `totalPages` / `page` / `hasMore` — обойти все страницы. Без токена — тест на fixture JSON.

### B. zakup customer validation

После получения результатов: если `customer_name` из API не матчится с `stat.name` (normalize + score < 0.5) — не сохранять tender, записать warning в `kz_enrich_errors`.

---

## Не делать

- Postgres KZ tables
- Telegram notifications
- Cron / scheduler
- Перенос `src/kz/*` внутрь adapters с копипастой логики
- Рефакторинг legacy 2GIS exporter columns

---

## Definition of Done

- [ ] `npm run lint` pass
- [ ] `npx vitest run tests/kz` pass (все старые + новые)
- [ ] `npm run dev -- kz enrich test-bins.csv` — cached skip на повторном запуске без `--force-refresh`
- [ ] `npm run kz:export` — создаёт xlsx с 4 листами
- [ ] `npm run dev -- kz enrich test-bins.csv` затем export — Companies содержит tender aggregates
- [ ] Commit: `feat(kz): add CLI, cache, aggregates and XLSX export (stage 2)`
- [ ] Conventional Commits, один логичный commit или 2 max (feat + docs)

---

## Порядок работы

1. `tenderTypes.ts` — CompanyCard, EnrichError
2. Migration v12 + kzStorage + tests
3. Cache в statGovCollector + test
4. enrichPipeline refactor
5. Adapters (thin wrappers) + contract test
6. kzExporter + kz-export script + test
7. CLI `kz` subcommands
8. .env.example, README, docs

Начни с kzStorage и миграции v12 — без них export и cache не взлетят.

---

## Справка: активные статусы закупок (для tender_count_active)

```typescript
const ACTIVE_TENDER_STATUSES = new Set([
  "PUBLISHED", "ACTIVE", "OPEN", "PUBLISHED_SUPPLIER_SELECTION"
  // zakup: advertStatus; goszakup: уточни по реальному ответу API
]);
```

Если неизвестен статус — не считать active, но не падать.
