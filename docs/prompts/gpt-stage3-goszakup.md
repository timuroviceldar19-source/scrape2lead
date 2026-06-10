# Промпт: Этап 3 — goszakup.gov.kz production

Скопируй блок **ЗАДАНИЕ** целиком в GPT/Cursor.

**База:** после `ecd69f7` (zakup filter fix), Stage 2 `963f111`, batch `bins-batch.csv`.  
**Спека:** `docs/TZ_v2.md` §8 Этап 3.

---

## ЗАДАНИЕ

Проект: `C:\Users\Madara\Desktop\Scrapper`

**Цель Этапа 3:** сделать **goszakup.gov.kz** production-ready источником закупок по БИН — с пагинацией, фильтром активных, надёжным маппингом **OWS v3 REST API**, smoke-тестом и fixture-тестами без live token.

**Документация:** https://goszakup.gov.kz/ru/developer/ows_v3  
**GraphQL schema:** https://ows.goszakup.gov.kz/help/v3/schema/

**Контекст:**
- zakup.sk.kz после `ecd69f7` — консервативный, часто 0 лотов (ок)
- **verified tenders** должны идти из goszakup по БИН
- Сейчас в коде: `GET https://ows.goszakup.gov.kz/trd-buy/biin/{BIN}` — **legacy**, без пагинации
- **Актуальный REST v3:** `GET https://ows.goszakup.gov.kz/v3/trd-buy/bin/{BIN}` → `{ total, limit, next_page, items[] }`
- v3 добавляет поля: `customer_name_ru`, `customer_name_kz`, `org_name_ru`, `org_name_kz` (использовать для `customer_name`)

**Не трогай:** zakup filter logic, stat.gov, 2GIS/Kaspi.

**Токен:** `GOSZAKUP_TOKEN` в `.env` (не коммитить). Тесты — только fixtures + mocked fetch.

---

## 1. Перейти на v3 REST API

Файл: `src/kz/goszakupCollector.ts`  
Base: `https://ows.goszakup.gov.kz`

### Primary endpoint (по доке ows_v3)

```
GET /v3/trd-buy/bin/{BIN}
Authorization: Bearer {GOSZAKUP_TOKEN}
Accept: application/json
```

Пример: `GET https://ows.goszakup.gov.kz/v3/trd-buy/bin/061040006408`

Ответ:
```json
{
  "total": 32,
  "limit": 50,
  "next_page": "/v3/trd-buy/bin/050140006873?page=next&search_after=...",
  "items": [{ "id", "number_anno", "name_ru", "name_kz", "org_bin", "total_sum", "ref_buy_status_id", "start_date", "end_date", "customer_name_ru", "org_name_ru", ... }]
}
```

### Пагинация

Пока `next_page` не пустая строка:
```
GET https://ows.goszakup.gov.kz{next_page}
```

- `GOSZAKUP_MAX_PAGES` env (default 20)
- Собирать все `items` перед маппингом

### Fallback chain (опционально)

1. v3 `/v3/trd-buy/bin/{BIN}`
2. если 404 → v2 `/v2/trd-buy/bin/{BIN}` + warn
3. если 404 → legacy `/trd-buy/biin/{BIN}` + warn

### GraphQL (не делать в MVP, только знать)

Альтернатива для сложных фильтров:
```
POST /v3/graphql
filter: { orgBin: "{BIN}", refBuyStatusId: [210, 220] }
```
REST v3 достаточно для Этапа 3. GraphQL — Этап 4+.

### HTTP errors

| Status | Поведение |
|---|---|
| 401/403 | `recordEnrichError(bin, "goszakup", "invalid or expired token")`, throw или return [] + warn batch |
| 429 | exponential backoff, max 3 retries |
| 5xx | retry 2 раза, потом error |

Вынеси HTTP client в `src/kz/goszakupClient.ts`:
```typescript
export async function goszakupGetJson(path: string, token: string): Promise<unknown>
export async function fetchAllTrdBuyByBin(bin: string, options: GoszakupClientOptions): Promise<GoszakupRawItem[]>
```

---

## 2. Маппинг полей v3 → TenderRecord

Создай `src/kz/goszakupMapper.ts`:

| TenderRecord | v3 item |
|---|---|
| `tender_number` | `number_anno` \|\| `String(id)` |
| `tender_name` | `name_ru` \|\| `name_kz` |
| `customer_name` | `customer_name_ru` \|\| `org_name_ru` \|\| stat.gov `name` fallback |
| `budget_amount` | `String(total_sum)` |
| `start_date` | `start_date` |
| `end_date` | `end_date` |
| `status` | human-readable из `ref_buy_status_id` (см. §3) |
| `method` | `String(ref_trade_methods_id)` или lookup |
| `url` | `https://goszakup.gov.kz/ru/trd-buy/{id}` |
| `source` | `goszakup.gov.kz` |
| `bin` | входной БИН (заказчик) |

**Валидация:** если `org_bin` в item есть и `org_bin !== bin` → skip item + debug log (не должно случаться на `/bin/{BIN}`, но проверь).

---

## 3. Фильтр «только активные закупки»

### Env + CLI

```bash
GOSZAKUP_ACTIVE_ONLY=1          # default: 0 (все статусы)
GOSZAKUP_ACTIVE_STATUS_IDS=210,220   # опционально, override
```

CLI:
```bash
npm run dev -- kz enrich bins.csv --goszakup-active-only
npm run dev -- kz enrich bins.csv --skip-zakup   # только stat + goszakup
```

Пробрось флаги: `cli.ts` → `enrichPipeline` → `tendersPipeline` → `fetchGoszakupTenders`.

### Логика фильтра

1. Загрузи справочник статусов (кэш в памяти на batch):
   ```
   GET https://ows.goszakup.gov.kz/v3/refs/ref_buy_status
   ```
   Сохрани map `id → name_ru`.

2. **Active IDs** (из документации GraphQL пример + расширяемо):
   - default set: `[210, 220]` (опубликовано / приём заявок — уточни по справочнику)
   - override через `GOSZAKUP_ACTIVE_STATUS_IDS`

3. Если `activeOnly`:
   - filter items where `ref_buy_status_id` in activeSet
   - в `status` писать `name_ru` из справочника, не raw id

4. Расширь `ACTIVE_TENDER_STATUSES` в `tenderTypes.ts` при необходимости для export aggregates.

Файл: `src/kz/goszakupStatus.ts` — `loadBuyStatusRef`, `isActiveBuyStatus`, `resolveBuyStatusName`.

---

## 4. Статистика pipeline

`TenderCollectStats` / `GoszakupBatchResult` — добавь:

```typescript
goszakupRaw: number;       // до фильтра
goszakupFiltered: number;  // отсечено activeOnly
goszakupPages: number;
```

Лог на БИН:
```
goszakup.gov.kz: bin=061040006408 pages=1 raw=5 accepted=2 active_only=true
```

---

## 5. Тесты (без live token)

### Fixture: `tests/fixtures/goszakup-v3-bin-response.json`

Санитизированный ответ по документации v2:
```json
{
  "total": 3,
  "limit": 50,
  "next_page": "",
  "items": [
    {
      "id": 415500,
      "number_anno": "415500-1",
      "name_ru": "Тестовая закупка",
      "customer_name_ru": "ТОО \"ALAU\"",
      "org_name_ru": "ТОО \"ALAU\"",
      "org_bin": "061040006408",
      "total_sum": 10000,
      "ref_buy_status_id": 210,
      "start_date": "2026-01-08 05:01:18",
      "end_date": "2026-06-19 05:01:18",
      "ref_trade_methods_id": 7
    },
    {
      "id": 415501,
      "number_anno": "415501-1",
      "name_ru": "Закрытая закупка",
      "org_bin": "061040006408",
      "total_sum": 5000,
      "ref_buy_status_id": 230,
      "start_date": "2020-01-01 00:00:00",
      "end_date": "2020-02-01 00:00:00",
      "ref_trade_methods_id": 7
    }
  ]
}
```

### Fixture pagination: `tests/fixtures/goszakup-v3-page1.json` + `page2.json`

page1 с `next_page: "/v3/trd-buy/bin/061040006408?page=next&search_after=1"`, page2 пустой next.

### Tests: `tests/kz/goszakupCollector.test.ts`

- mock `global.fetch` или inject client
- pagination: 2 pages → merged items count
- activeOnly: 2 items → 1 accepted (210 yes, 230 no)
- map fields correctly
- 401 → error recorded, no throw entire batch
- invalid BIN → skip

### Tests: `tests/kz/goszakupStatus.test.ts`

- resolve status name from ref fixture

---

## 6. Smoke script (live, manual)

`scripts/goszakup-smoke.ts`:

```bash
npx tsx scripts/goszakup-smoke.ts 061040006408
# или первый BIN из bins-batch.csv
```

- Требует `GOSZAKUP_TOKEN` в `.env`
- Печатает: pages, raw, accepted, first 3 tenders JSON
- **Не пишет в БД** (read-only smoke)
- Exit 0 если HTTP ok, exit 1 если нет токена

`package.json`:
```json
"kz:goszakup:smoke": "tsx scripts/goszakup-smoke.ts"
```

---

## 7. Документация

**`docs/TENDERS.md`:**
- v3 endpoint `/v3/trd-buy/bin/{BIN}` (дока: ows_v3)
- ссылка https://goszakup.gov.kz/ru/developer/ows_v3
- pagination `next_page`
- `GOSZAKUP_ACTIVE_ONLY`, `GOSZAKUP_ACTIVE_STATUS_IDS`, `GOSZAKUP_MAX_PAGES`
- zakup = discovery (optional), goszakup = verified by BIN
- smoke command

**`docs/TZ_v2.md` §8 Этап 3** — отметить чекбоксы выполненными.

**`.env.example`:**
```bash
GOSZAKUP_TOKEN=
GOSZAKUP_ACTIVE_ONLY=0
GOSZAKUP_ACTIVE_STATUS_IDS=210,220
GOSZAKUP_MAX_PAGES=20
```

---

## 8. DoD

```bash
npm run lint
npx vitest run tests/kz          # все pass включая новые
```

**С токеном (ручная проверка оператором):**
```bash
npm run kz:goszakup:smoke -- 061040006408
npm run dev -- kz enrich bins-batch.csv --skip-stat --skip-zakup
npm run kz:export -- --bins bins-batch.csv
npm run kz:audit -- bins-batch.csv
```

Ожидание с токеном:
- `goszakup_tenders > 0` хотя бы для части БИН из batch
- audit: goszakup лоты **без** `weak_title_match` (фильтр zakup-only)
- `cross_bin_duplicate = 0` для goszakup (разные tender_number)

**Без токена:** тесты и lint pass, smoke exit 1 с понятным сообщением.

**Commit:**
```
feat(kz): production goszakup v3 API with pagination and active filter (stage 3)
```

---

## Не делать

- GraphQL client (REST v3 достаточно для MVP; schema: /help/v3/schema/)
- Telegram notifications (Этап 4)
- Postgres KZ tables
- Менять zakupTenderFilter

---

## Порядок работы

1. `goszakupClient.ts` + fixtures
2. `goszakupStatus.ts` + ref cache
3. `goszakupMapper.ts`
4. Refactor `goszakupCollector.ts`
5. Pipeline stats + CLI flags
6. Tests
7. Smoke script
8. Docs

Начни с client + fixture tests — без токена.
