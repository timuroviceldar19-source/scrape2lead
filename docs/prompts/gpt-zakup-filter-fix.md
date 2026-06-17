# Промпт: фикс zakup-фильтра (ложные закупки)

Скопируй блок **ЗАДАНИЕ** целиком в GPT/Cursor.

**Контекст:** batch-тест `bins-batch.csv` (10 ТОО из goszakup) показал:
- stat.gov: 9/10 ✅
- zakup: **10 лотов у одного БИН** (`210940017793`), все — дефолтная выдача портала (гироскопия, кабель, Эмбамунайгаз)
- audit: **10/10** `weak_title_match`, `cross_bin_duplicate=0`
- API списка `4dv3rts/filter` **не содержит заказчика** — `customer_name` сейчас подставляется из stat.gov без проверки

---

## ЗАДАНИЕ

Проект: `C:\Users\Madara\Desktop\Scrapper`  
База: после Stage 2 (`963f111` + batch audit tooling).

**Цель:** не сохранять ложные zakup-лоты. После фикса batch `bins-batch.csv` должен давать **0 или верифицированные** zakup-записи, а не 10 случайных лотов на одну компанию.

**Не трогай:** stat.gov collector, goszakup, 2GIS/Kaspi, exporter columns.

---

## Корневая проблема (подтверждено batch)

1. Перехват API ловит **дефолтную** выдачу `/4dv3rts/filter?size=10&page=0&sort=lastModifiedDate,desc` без привязки к поисковому запросу.
2. `mapZakupTender` пишет `customer_name: companyName` — **ложная верификация**.
3. Нет фильтра релевантности между `companyName` и `tender_name`.
4. `findSearchInput` может взять не то поле (`"input"` fallback).

---

## Что сделать

### 1. `src/kz/zakupTenderFilter.ts` (новый модуль)

Вынеси логику фильтрации из `batchAudit.ts` (не дублируй — **импортируй/переиспользуй**):

```typescript
export interface ZakupFilterResult {
  accepted: TenderRecord[];
  rejected: Array<{ item: Record<string, unknown>; reason: ZakupRejectReason }>;
  stats: { total: number; accepted: number; rejected: number };
}

export type ZakupRejectReason =
  | "weak_title_match"
  | "generic_default_feed"
  | "duplicate_tender_number"
  | "missing_number";

export function tokenizeForZakupMatch(text: string): string[];
export function hasZakupTitleMatch(companyName: string, tenderName: string): boolean;
export function isKnownDefaultZakupFeed(tenderNumbers: string[]): boolean;
export function filterZakupTenders(
  items: Array<Record<string, unknown>>,
  bin: string,
  companyName: string,
  options?: { minTokenOverlap?: number }
): ZakupFilterResult;
```

**Правила фильтра (обязательно):**

| Правило | Логика |
|---|---|
| `hasZakupTitleMatch` | ≥1 значимый токен из `normalizeCompanyName(company)` встречается в `tender_name` (case-insensitive). Переиспользуй `tokenizeForMatch` из `batchAudit.ts` — **рефактор:** вынеси в `zakupTenderFilter.ts`, `batchAudit` импортирует оттуда. |
| `generic_default_feed` | Если **все** номера лотов из набора совпадают с fixture дефолтной выдачи — reject batch. Fixture: `tests/fixtures/zakup-default-feed.json` (скопируй 10 `number` из `data/debug/zakup-api-calls.json`). |
| Пустой API | `extractZakupItems` → 0 items → **не ошибка**, return `[]`, log `info`. |
| `customer_name` | В `mapZakupTender`: если лот **прошёл** фильтр — `customer_name: companyName`; иначе не маппить. Добавь опциональное поле `match_verified: boolean` в `TenderRecord` **только если** не ломает миграции — иначе не добавляй, достаточно не сохранять rejected. |

**Консервативный режим (default):** сохранять лот только если `hasZakupTitleMatch === true`.  
Лучше 0 лотов, чем 10 ложных.

### 2. Фикс перехвата API в `src/kz/zakupCollector.ts`

```typescript
// После Enter — ждать КОНКРЕТНЫЙ response:
const response = await page.waitForResponse(
  (res) => {
    const url = res.url();
    return res.ok() && url.includes("4dv3rts") && wasSubmittedAfterSearch(url, searchName);
  },
  { timeout: 15_000 }
).catch(() => null);
```

`wasSubmittedAfterSearch`:
- `searchSubmitted` выставлять **только после** `press("Enter")`
- убрать глобальный `page.on("response")` который копит stale data ИЛИ сбрасывать `apiData=null` перед Enter и принимать только первый post-enter response
- опционально: URL/body содержит нормализованный search token (если API кладёт query в URL — проверь в network при отладке; если нет — полагайся на filter + default feed detection)

**`findSearchInput`:** убрать fallback `"input"` — только:
```typescript
'input[placeholder*="Слово"]'
'input[placeholder*="поиска"]'
'input[type="search"]'
```
Если не найдено → throw (как сейчас).

**`ZakupBatchResult` — расширить:**
```typescript
filtered: number;      // rejected by filter
accepted: number;
```

Лог на каждый БИН:
```
zakup.sk.kz: bin=... search="..." raw=10 accepted=0 rejected=10 reasons={weak_title_match:10}
```

### 3. Pipeline + errors

В `tendersPipeline.ts` после zakup:
- если `accepted === 0` и `raw > 0` → `storage.recordEnrichError(bin, "zakup", "all lots rejected by relevance filter")`
- не считать rejected как `zakupCount`

### 4. Тесты `tests/kz/zakupTenderFilter.test.ts`

| Кейс | Ожидание |
|---|---|
| Fixture default feed + company `ТОО "ALAU"` | accepted=0, rejected=10, reason includes `weak_title_match` or `generic_default_feed` |
| Synthetic item с `nameRu: "Поставка для ALAU"` | accepted=1 |
| Пустой массив | accepted=0, не throw |
| `isKnownDefaultZakupFeed(["1216770","1225537",...])` | true |

Создай `tests/fixtures/zakup-default-feed.json`:
```json
{ "numbers": ["1216770","1225537","1226459","1228180","1228178","1228181","1224410","1227281","1227835","1222475"] }
```

### 5. Обновить `tests/kz/batchAudit.test.ts`

Импорт `tokenizeForMatch` / `hasWeakTitleMatch` из `zakupTenderFilter.ts` (если перенёс).

### 6. Документация

`docs/TENDERS.md` — секция **Zakup relevance filter**:
- zakup = текстовый поиск, не БИН
- сохраняем только title match
- дефолтная выдача отбрасывается
- для verified data → goszakup по БИН

`docs/kz-batch-runbook.md` — обнови критерий: после фикса batch 10 БИН ожидается `zakup_tenders` ≈ 0 до получения токена (это нормально).

### 7. CLI flag (опционально)

`--zakup-strict` (default true) в `kz enrich` / `enrichPipeline`.  
`--zakup-lenient` — сохранять как раньше (для отладки).

---

## Проверка (DoD)

```bash
npm run lint
npx vitest run tests/kz
npm run dev -- kz enrich bins-batch.csv --skip-stat --force-refresh
npm run kz:audit -- bins-batch.csv
```

**Ожидание после фикса:**
- `tender_data` для zakup: **0 строк** или только с реальным title match (для ALAU и т.д.)
- **Нет** лотов `1216770`, `1225537`, … привязанных к `210940017793`
- audit: `weak_title_match` в сохранённых данных = 0
- stat.gov и goszakup не сломаны

**Commit:**
```
fix(kz): filter false-positive zakup lots by title match and default feed detection
```

---

## Файлы

| Файл | Действие |
|---|---|
| `src/kz/zakupCollector.ts` | waitForResponse, filter integration |
| `src/kz/zakupTenderFilter.ts` | **новый** |
| `src/kz/batchAudit.ts` | импорт из filter, убрать дубли |
| `src/kz/tendersPipeline.ts` | errors, stats |
| `tests/fixtures/zakup-default-feed.json` | **новый** |
| `tests/kz/zakupTenderFilter.test.ts` | **новый** |
| `docs/TENDERS.md` | обновить |

---

## Не делать

- Парсинг карточки лота в Playwright (отдельная задача, медленно)
- Пагинация zakup
- Изменение схемы БД без необходимости

---

## Порядок

1. Fixture default feed + `zakupTenderFilter.ts` + tests
2. Рефактор `batchAudit.ts` imports
3. `zakupCollector.ts` response capture fix
4. Pipeline logging/errors
5. Docs
6. Прогон `bins-batch.csv --skip-stat`
