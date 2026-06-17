# Промпт: Этап 3.5 — goszakupRegistryCollector (публичный реестр, без токена)

Скопируй блок **ЗАДАНИЕ** целиком в GPT/Cursor.

**База:** после `236e0a3` (goszakup v3 API), `ecd69f7` (zakup filter).  
**Контекст:** `GOSZAKUP_TOKEN` пока нет, но **реестр участников на сайте открыт без логина** — телефон, email, сайт, роли, адреса.  
**Пример:** БИН `960440000716` → участник `31664` → `АО "Нефтяная страховая компания"`, `info@nsk.kz`, `+77272581800`, `www.nsk.kz`.

---

## ЗАДАНИЕ

Проект: `C:\Users\Madara\Desktop\Scrapper`

**Цель:** коллектор **публичного реестра goszakup.gov.kz** — обогащение компаний по БИН **без Bearer token**. Дополняет stat.gov контактами (phone/email/website), не заменяет его.

**Не трогай:** `goszakupClient.ts` / API tenders (остаётся за токеном), zakup filter, stat.gov parser logic.

**Стек:** Playwright (уже в проекте), TypeScript, SQLite migrations, vitest.

---

## Публичные URL (подтверждено)

| Шаг | URL |
|---|---|
| Поиск | `https://goszakup.gov.kz/ru/registry/supplierreg` |
| Карточка | `https://goszakup.gov.kz/ru/registry/show_supplier/{participant_id}` |
| Альтернатива | `https://goszakup.gov.kz/ru/registry/view_supplier/{participant_id}` |

Поиск: поле **«Участник»** (placeholder: «Наименование, БИН, ИНН, ИИН, УНП») → кнопка **«Найти»** → таблица с колонками БИН / № участника.

**Flow на один БИН:**
1. Открыть `supplierreg`
2. Ввести БИН (12 цифр)
3. Нажать «Найти», дождаться таблицы
4. Найти строку где БИН совпадает → извлечь `participant_id` из ссылки (`show_supplier/31664`)
5. Перейти на карточку участника
6. Спарсить HTML → сохранить в БД + snapshot

Если БИН не найден → `not_found`, не throw batch.

---

## 1. Миграция v13 — таблица `goszakup_registry_data`

В `src/storage/migrations.ts`:

```sql
CREATE TABLE IF NOT EXISTS goszakup_registry_data (
  bin TEXT PRIMARY KEY,
  participant_id TEXT,
  name_ru TEXT,
  name_kz TEXT,
  rnn TEXT,
  role TEXT,                    -- e.g. "Поставщик"
  residency TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  registration_date TEXT,       -- из реестра закупок
  last_update_date TEXT,
  kopf TEXT,                    -- КОПФ
  ownership_form TEXT,
  economic_sector TEXT,
  director_name TEXT,
  director_iin TEXT,
  legal_address TEXT,
  location_address TEXT,
  registry_url TEXT,
  updated_at TEXT NOT NULL,
  raw_snapshot_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_goszakup_registry_participant ON goszakup_registry_data(participant_id);
```

**Не расширяй** `stat_gov_data` — отдельная таблица, join по `bin`.

---

## 2. Типы — `src/kz/registryTypes.ts`

```typescript
export interface GoszakupRegistryRecord {
  bin: string;
  participant_id: string | null;
  name_ru: string | null;
  name_kz: string | null;
  rnn: string | null;
  role: string | null;
  residency: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  registration_date: string | null;
  last_update_date: string | null;
  kopf: string | null;
  ownership_form: string | null;
  economic_sector: string | null;
  director_name: string | null;
  director_iin: string | null;
  legal_address: string | null;
  location_address: string | null;
  registry_url: string | null;
  updated_at: string;
  raw_snapshot_path: string | null;
}
```

---

## 3. Парсер HTML — `src/kz/goszakupRegistryParser.ts`

Чистые функции (без Playwright):

```typescript
export function parseRegistrySearchHtml(html: string, bin: string): { participant_id: string; profile_url: string } | null
export function parseRegistryProfileHtml(html: string, bin: string): GoszakupRegistryRecord | null
```

**Парсинг карточки** — таблица label/value (как stat.gov `divTableCell` или `<th>/<td>` — изучи сохранённый snapshot):

| Лейбл на странице | поле |
|---|---|
| БИН участника | bin (verify match) |
| Наименование на рус. языке | name_ru |
| Наименование на каз. языке | name_kz |
| РНН участника | rnn |
| E-Mail / E-mail | email |
| Контактный телефон | phone (нормализовать к `+7...`) |
| Веб-сайт | website (добавить `https://` если нет схемы) |
| Дата регистрации | registration_date |
| Дата последнего обновления | last_update_date |
| Роли участника | role |
| Резидентство | residency |
| КОПФ | kopf |

**Секция «Руководитель»:** ФИО → `director_name`, ИИН → `director_iin`.

**Секция «Контактная информация»:** строки с типом «Юридический адрес» / «Адрес местонахождения».

Нормализация телефона: убрать пробелы, `8` → `+7` для KZ.

---

## 4. Коллектор — `src/kz/goszakupRegistryCollector.ts`

```typescript
export interface RegistryCollectOptions {
  databasePath?: string;
  delayMs?: number;
  headless?: boolean;
  debugDir?: string;
  forceRefresh?: boolean;
  cacheTtlDays?: number;  // default 7, env GOSZAKUP_REGISTRY_CACHE_TTL_DAYS
}

export interface RegistryCollectStats {
  processed: number;
  success: number;
  not_found: number;
  failed: number;
  cached: number;
  skipped: number;
}

export async function collectGoszakupRegistryForBins(
  bins: string[],
  options?: RegistryCollectOptions
): Promise<RegistryCollectStats>
```

- Один browser на batch (как zakup)
- `isValidBin` из `csv.ts`
- TTL: если запись в `goszakup_registry_data` свежее TTL и не `--force-refresh` → skip
- Snapshot: `data/debug/goszakup-registry-{bin}.html`
- Screenshot опционально: `goszakup-registry-search-{bin}.png`
- Ошибки → `kz_enrich_errors` stage=`goszakup_registry`
- **Не требует** `GOSZAKUP_TOKEN`

**Поиск participant_id:**
- Prefer: parse HTML таблицы результатов
- Fallback: regex `show_supplier/(\d+)` рядом с БИН в HTML
- Если несколько строк с одним БИН — взять первую exact match

---

## 5. Storage — `src/kz/kzStorage.ts`

Добавь методы:

```typescript
getGoszakupRegistryByBin(bin: string): GoszakupRegistryRecord | null
isGoszakupRegistryFresh(bin: string, ttlDays: number): boolean
upsertGoszakupRegistry(record: GoszakupRegistryRecord): void
```

---

## 6. Export — расширить Companies

`src/kz/kzExporter.ts` — JOIN `goszakup_registry_data` в `getCompanyCards` или отдельный merge при export:

Новые колонки на листе **Companies**:
- Телефон (goszakup)
- Email (goszakup)
- Сайт (goszakup)
- № участника goszakup
- Роль в реестре

Расширь `CompanyCard` в `tenderTypes.ts` опциональными полями `registry_phone`, `registry_email`, `registry_website`, `participant_id`, `registry_role`.

---

## 7. Интеграция в pipeline

### `enrichPipeline.ts`

Новые опции:
```typescript
skipGoszakupRegistry?: boolean;  // default false
registryForceRefresh?: boolean;
```

Порядок в `runKzEnrich`:
1. stat.gov (если не `--skip-stat`)
2. **goszakup registry** (если не `--skip-goszakup-registry`) — **без токена**
3. tenders / zakup / goszakup API (если не `--skip-tenders`)

### `cli.ts` — флаги

```bash
npm run dev -- kz enrich bins.csv --skip-goszakup-registry   # отключить
npm run dev -- kz enrich bins.csv --registry-only            # только реестр (skip stat + tenders)
npm run dev -- kz registry bins.csv                          # отдельная подкоманда (опционально)
```

### `package.json`

```json
"kz:registry": "tsx scripts/goszakup-registry-collector.ts"
```

Thin wrapper script.

### Summary log

```
registry: processed=10 success=8 not_found=1 cached=1 failed=0
```

---

## 8. Fixtures + тесты

### `tests/fixtures/goszakup-registry-search-960440000716.html`

Минимальный HTML фрагмент таблицы поиска с ссылкой `show_supplier/31664` и БИН `960440000716`.

### `tests/fixtures/goszakup-registry-profile-960440000716.html`

Фрагмент карточки с:
- email: `info@nsk.kz`
- phone: `+77272581800`
- website: `www.nsk.kz`
- name: `Акционерное общество "Нефтяная страховая компания"`

### `tests/kz/goszakupRegistryParser.test.ts`

- `parseRegistrySearchHtml` → participant_id `31664`
- `parseRegistryProfileHtml` → phone, email, website
- BIN mismatch → null
- phone normalization

### `tests/kz/goszakupRegistryCollector.test.ts` (опционально)

Mock page content без live browser.

---

## 9. Документация

**`docs/TENDERS.md`** — секция **Goszakup Public Registry (no token)**:
- что даёт vs stat.gov vs API tenders
- команды
- TTL cache

**`.env.example`:**
```bash
GOSZAKUP_REGISTRY_CACHE_TTL_DAYS=7
```

**`docs/TZ_v2.md`** — добавь подэтап 3.5 (чекбоксы).

---

## 10. DoD

```bash
npm run lint
npx vitest run tests/kz
```

**Ручной прогон (без токена):**
```bash
npm run kz:registry -- bins-batch.csv
# или
npm run dev -- kz enrich bins-batch.csv --skip-tenders --skip-stat
npm run kz:export -- --bins bins-batch.csv
```

Ожидание для `960440000716`:
- `goszakup_registry_data` содержит phone/email/website
- XLSX Companies — новые колонки заполнены

**Commit:**
```
feat(kz): add public goszakup registry collector without API token (stage 3.5)
```

---

## Не делать

- Скрейпинг закупок с публичных страниц (только API с токеном)
- Обход login/CAPTCHA
- Дублировать stat.gov поля (ОКЭД) — только контакты + реестровые метаданные
- GraphQL / OWS API в этом этапе

---

## Порядок работы

1. Migration v13 + registryTypes
2. Parser + fixtures + parser tests
3. kzStorage methods
4. Collector (Playwright)
5. enrichPipeline + CLI + script
6. Export columns
7. Docs
8. Manual test on `960440000716` and `bins-batch.csv`

Начни с parser и fixture HTML — collector пиши после прохождения тестов парсера.
