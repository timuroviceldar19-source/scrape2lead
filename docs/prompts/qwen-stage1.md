# Промпт для Qwen: Этап 1 — консолидация KZ pipeline (stat.gov + tenders)

Скопируй всё содержимое блока ниже в Qwen как единое задание.

---

## ЗАДАНИЕ

Ты работаешь в репозитории **Scrape2Lead** (`C:\Users\Madara\Desktop\Scrapper`).

**Цель:** Этап 1 по `docs/TZ_v2.md` — консолидировать разрозненные скрипты stat.gov + tenders в один рабочий пайплайн без рефакторинга всей платформы v1.7.

**Не трогай:** 2GIS/Kaspi adapters, enrichment scoring, JobManager (кроме переиспользования `Storage`/`runMigrations` если нужно).

**Стек:** Node 20+, TypeScript, Playwright, better-sqlite3, vitest.

---

## Контекст (текущие проблемы)

1. `scripts/zakup-collector.ts` и `scripts/tenders-collector.ts` создают **разные схемы** `tender_data` (с/без `source`). `CREATE TABLE IF NOT EXISTS` не чинит уже созданную таблицу.
2. `tenders-collector.ts` называется Multi-source, но вызывает **только goszakup**; zakup — отдельный скрипт.
3. `scripts/merge-stat-gov-data.ts` **баг**: в `legal_status` пишет `kfs_name`, в `founder` — `krp_name`.
4. Таблицы `stat_gov_data` / `tender_data` создаются в скриптах, **не в** `src/storage/migrations.ts`.
5. `parseHtmlResponse` в stat-gov-collector не тестируется; при смене HTML всё сломается незаметно.
6. zakup: на каждый БИН новый браузер; `apiData = json` перезаписывается последним response — риск сохранить **дефолтные 10 лотов** с главной страницы вместо результатов поиска.
7. `data/stat-gov-session.json` **не в** `.gitignore`.
8. На странице stat.gov (`data/debug/stat-gov-220540025781.html`) **нет поля «статус юрлица»** — только КФС/КРП. Не подставляй `kfs_name` в `legal_status`.

---

## Что сделать (обязательно)

### 1. Миграция v11 в `src/storage/migrations.ts`

Добавь migration `version: 11` с `run:` (не голый SQL, т.к. таблица может уже существовать):

**`stat_gov_data`:**
```sql
bin TEXT PRIMARY KEY,
name TEXT,
registration_date TEXT,
oked TEXT,
oked_name TEXT,
address TEXT,
director TEXT,
legal_status TEXT,          -- 'active'|'inactive'|'liquidated'|'reorganizing'|'unknown'
krp_code TEXT,
krp_name TEXT,
kfs_code TEXT,
kfs_name TEXT,
sector_code TEXT,
sector_name TEXT,
updated_at TEXT,
raw_snapshot_path TEXT
```

**`tender_data` (унифицированная):**
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
source TEXT NOT NULL,       -- 'zakup.sk.kz' | 'goszakup.gov.kz'
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
+ индекс `idx_tender_data_bin ON tender_data(bin)`.

Логика миграции:
- Если `tender_data` существует без `source` — пересоздать таблицу с переносом данных (`source = 'zakup.sk.kz'` для старых строк).
- Если `stat_gov_data` существует — `ALTER ADD COLUMN` для новых полей.

Убедись, что `Storage` constructor вызывает `runMigrations` (уже должно быть).

### 2. Вынести парсинг stat.gov в `src/kz/statGovParser.ts`

- Экспорт `parseStatGovHtml(html: string): StatGovRecord | null`
- Экспорт `extractStatGovField(html, label)` — текущая regex-логика по `divTableCell`
- `legal_status`: попробуй извлечь по лейблам «Статус», «Состояние»; если поля нет — `'unknown'`
- Не экспортировать Playwright из этого модуля (чистая функция для тестов)

**Тест:** `tests/kz/statGovParser.test.ts` — fixture `data/debug/stat-gov-220540025781.html`:
- `bin === '220540025781'`
- `oked === '46610'`
- `director` содержит `БЕГИШЕВА`
- `legal_status === 'unknown'` (пока нет поля на странице)

### 3. Вынести нормализацию названия для zakup в `src/kz/normalizeCompanyName.ts`

Перенеси логику из `zakup-collector.ts` (удаление ТОО/АО/ИП, кавычки, скобки). Unit-тест на 2–3 кейсах.

### 4. Модули коллекторов в `src/kz/`

```
src/kz/
  statGovParser.ts
  normalizeCompanyName.ts
  statGovCollector.ts    — логика сбора (Playwright, session, upsert)
  zakupCollector.ts      — один browser на batch, перехват API ПОСЛЕ search
  goszakupCollector.ts   — fetch по БИН, graceful skip без токена
  tenderTypes.ts         — StatGovRecord, TenderRecord interfaces
```

**zakupCollector — критичные фиксы:**
- Один `browser` на весь batch, не на БИН.
- Флаг `searchSubmitted = false`; принимать API response только если URL содержит `4dv3rts` **и** `searchSubmitted === true` (после Enter в поле поиска).
- Если `apiData` — объект с `content`/`items`, извлеки массив.
- Если поиск не удался (нет input) — **не сохранять** закупки, лог `warn`.
- `source: 'zakup.sk.kz'` на каждой записи.

**statGovCollector:**
- Валидация БИН `/^\d{12}$/`, иначе skip + warn.
- Использовать `Storage` или открывать DB через существующий `Storage` class + migrations.
- `raw_snapshot_path` при сохранении.
- Рефактор `scripts/stat-gov-collector.ts` → тонкая обёртка, вызывающая `src/kz/statGovCollector.ts`.

### 5. Единый скрипт тендеров `src/kz/tendersPipeline.ts`

Объединить zakup + goszakup:
```typescript
async function collectTendersForBins(bins: string[], options): Promise<TenderCollectStats>
```
- Для каждого БИН: имя из `stat_gov_data` (обязательно для zakup).
- goszakup: если нет `GOSZAKUP_TOKEN` — skip с логом, не throw.
- Upsert в `tender_data` через prepared statements.
- Пауза 2000ms между БИН.

`scripts/tenders-collector.ts` → thin wrapper.  
`scripts/zakup-collector.ts` — deprecate: в начале файла комментарий `// DEPRECATED: use tenders-collector.ts` и `process.exit` с подсказкой, ИЛИ делегируй в новый pipeline.

### 6. Оркестратор `scripts/kz-enrich.ts`

Одна команда на CSV с БИН:

```bash
npx tsx scripts/kz-enrich.ts bins.csv
# Флаги:
#   --skip-stat     только тендеры (stat уже в БД)
#   --skip-tenders  только stat.gov
#   --delay-ms 2000
```

Порядок:
1. stat.gov (если не `--skip-stat`) — нужна сессия `data/stat-gov-session.json`
2. tenders (если не `--skip-tenders`)

В конце — summary в stdout (processed/success/failed/tenders_count).

`stat-gov-login.ts` остаётся отдельным интерактивным шагом.

### 7. Исправить `scripts/merge-stat-gov-data.ts`

Правильный маппинг в `leads`:
| leads column | источник |
|---|---|
| `bin` | stat.bin |
| `registration_date` | stat.registration_date |
| `oked`, `oked_name` | stat |
| `director` | stat.director |
| `legal_status` | stat.legal_status (не kfs_name!) |
| `legal_form` | stat.kfs_name ИЛИ парсинг ТОО/АО из stat.name |
| `founder` | `NULL` (нет данных — не писать krp_name) |
| `company_age_years` | вычисляемое |

Добавь тест `tests/kz/mergeStatGov.test.ts` с in-memory sqlite или mock — проверь, что `legal_status !== kfs_name`.

### 8. `.gitignore`

Добавь:
```
data/stat-gov-session.json
data/debug/
```

### 9. `package.json` scripts

```json
"kz:login": "tsx scripts/stat-gov-login.ts",
"kz:enrich": "tsx scripts/kz-enrich.ts",
"kz:tenders": "tsx scripts/tenders-collector.ts",
"kz:merge": "tsx scripts/merge-stat-gov-data.ts"
```

### 10. Документация

Обнови `docs/TENDERS.md` — один пайплайн, unified schema.  
Добавь в `README.md` секцию **KZ Pipeline (v2)** — 5 строк: login → enrich → merge (опционально).

---

## Что НЕ делать на этом этапе

- Не переносить в `src/adapters/` (это Этап 2).
- Не делать Postgres-миграции для kz-таблиц.
- Не трогать enrichment/2GIS/Kaspi.
- Не добавлять Telegram, cron, CAPTCHA solver.
- XLSX export — **опционально**, только если успеваешь: минимальный `scripts/kz-export.ts` (Companies + Tenders). Если нет — не блокируй PR.

---

## Definition of Done

- [ ] `npm test` — новые тесты проходят; не ломать существующие (2 падающих до тебя — exporter/postgres migration — можно не чинить, если не связано).
- [ ] `npm run lint` без новых ошибок.
- [ ] Миграция v11 применяется на чистой и на существующей БД.
- [ ] `npx tsx scripts/kz-enrich.ts test-bins.csv` — один вызов, stat + tenders без ручного переключения скриптов.
- [ ] `tender_data` всегда с `source`.
- [ ] merge не пишет kfs/krp в legal_status/founder.
- [ ] Conventional Commit: `feat(kz): consolidate stat.gov and tenders pipeline (stage 1)`.

---

## Файлы для ориентира

| Файл | Роль |
|---|---|
| `docs/TZ_v2.md` | Спека v2 |
| `scripts/stat-gov-login.ts` | QR auth |
| `scripts/stat-gov-collector.ts` | Текущий stat collector |
| `scripts/zakup-collector.ts` | zakup (баги) |
| `scripts/tenders-collector.ts` | goszakup only |
| `scripts/merge-stat-gov-data.ts` | Баг маппинга |
| `data/debug/stat-gov-220540025781.html` | Fixture для теста |
| `src/storage/migrations.ts` | Добавить v11 |
| `src/storage/storage.ts` | Storage class |
| `src/utils/nameNormalizer.ts` | matchNames для merge |

---

## Порядок работы

1. Миграция v11 + тест миграции (in-memory db).
2. `statGovParser` + тест на fixture HTML.
3. `normalizeCompanyName` + тест.
4. Рефактор коллекторов в `src/kz/`.
5. `tendersPipeline` + фиксы zakup.
6. `kz-enrich.ts` оркестратор.
7. Fix merge + тест.
8. gitignore, package.json, docs.
9. Прогон на `test-bins.csv`.

Начинай с миграции и тестов — не пиши новый код поверх старых `CREATE TABLE` в скриптах.
