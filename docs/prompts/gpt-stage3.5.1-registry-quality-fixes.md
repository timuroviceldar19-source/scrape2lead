# Промпт: Этап 3.5.1 — quality fixes для goszakup registry

Скопируй блок **ЗАДАНИЕ** целиком в GPT/Cursor.

**База:** после `592941e` (Stage 3.5 — public registry collector).  
**Контекст:** batch `bins-batch.csv` (10 TOO) — collector **10/10 success**, но в данных и export есть 4 бага.

---

## ЗАДАНИЕ

Проект: `C:\Users\Madara\Desktop\Scrapper`

**Цель:** hotfix качества данных Stage 3.5 — без новых фич, без миграций, минимальный diff.

**Не трогай:** goszakup API (v3), zakup filter, stat.gov collector, postgres/exporter, 2GIS.

---

## Проблемы из batch-прогона (подтверждено)

| # | БИН | Симптом | Root cause |
|---|-----|---------|------------|
| 1 | все 10 | `participant_id` = null в БД | collector не прокидывает ID из search step |
| 2 | `061040006408` | phone `+34369387011878787` | `normalizePhone` принимает любую длину |
| 3 | `080440022930` | website `https://pernebeknps10@mail.ru` | email попал в поле «Веб-сайт» |
| 3b | `260540002333` | website `https://-` | placeholder `-` стал URL |
| 4 | `241240019455` | есть в registry, **нет в XLSX** | `getCompanyCards` стартует от `stat_gov_data` |

**Ожидание после фикса:** batch 10/10 в XLSX, `participant_id` заполнен, нет мусорных phone/website.

---

## Fix 1 — `participant_id` propagation

**Файл:** `src/kz/goszakupRegistryCollector.ts`

После `parseRegistryProfileHtml` search step уже знает `participant_id` и `profile_url`, но они теряются:

```typescript
// сейчас (строка ~126):
return {
  record: parseRegistryProfileHtml(profileHtml, bin),
  rawSnapshotPath
};
```

**Сделай:**
```typescript
const record = parseRegistryProfileHtml(profileHtml, bin);
if (!record) {
  return { record: null, rawSnapshotPath };
}
return {
  record: {
    ...record,
    participant_id: record.participant_id ?? searchResult.participant_id,
    registry_url: record.registry_url ?? searchResult.profile_url
  },
  rawSnapshotPath
};
```

Добавь unit-тест: profile HTML **без** `show_supplier/\d+`, но с валидными полями → после merge через collector helper (или тест merge-логики) `participant_id` = из search.

---

## Fix 2 — валидация телефона (KZ)

**Файл:** `src/kz/goszakupRegistryParser.ts` — функция `normalizePhone`

**Правила:**
1. Извлечь кандидатов regex: `(?:\+?7|8)[\s\-()]*\d[\d\s\-()]{8,12}\d` или проще — split по `[,;/]` и нормализовать каждый фрагмент
2. Нормализовать к `+7XXXXXXXXXX` (ровно 12 символов: `+7` + 10 цифр)
3. `8XXXXXXXXXX` (11 цифр) → `+7XXXXXXXXXX`
4. `7XXXXXXXXXX` (11 цифр) → `+7XXXXXXXXXX`
5. Если длина ≠ 12 после нормализации — **отклонить** кандидат
6. Вернуть **первый** валидный; если ни одного — `null`

**Кейсы из batch:**
| input | output |
|-------|--------|
| `+77272581800` | `+77272581800` |
| `+7 (727) 258-18-00` | `+77272581800` |
| `87272581800` | `+77272581800` |
| `+34369387011878787` | `null` |
| `+77071017793` | `+77071017793` |

**Рекомендация:** экспортировать `normalizePhone` (named export) для прямых unit-тестов без HTML.

---

## Fix 3 — валидация website

**Файл:** `src/kz/goszakupRegistryParser.ts` — функция `normalizeWebsite`

**Отклонять (→ `null`):**
- пустая строка
- содержит `@` (email, не сайт)
- placeholder: `-`, `—`, `нет`, `n/a`, `отсутствует` (case-insensitive)
- после strip схемы длина < 4
- нет точки в hostname (кроме `localhost` — маловероятно, можно игнорировать)

**Принимать:**
| input | output |
|-------|--------|
| `www.nsk.kz` | `https://www.nsk.kz` |
| `https://www.zharykled.kz` | `https://www.zharykled.kz` |
| `http://royalfitness.kz/` | `http://royalfitness.kz/` |
| `pernebeknps10@mail.ru` | `null` |
| `-` | `null` |

Экспортировать `normalizeWebsite` для unit-тестов.

---

## Fix 4 — export: union stat + registry

**Файл:** `src/kz/kzStorage.ts` — метод `getCompanyCards`

**Проблема:** `FROM stat_gov_data s` — BIN только в registry не попадает в отчёт.

**Решение:** CTE с union BIN:

```sql
WITH company_bins AS (
  SELECT bin FROM stat_gov_data
  UNION
  SELECT bin FROM goszakup_registry_data
)
SELECT
  c.bin,
  COALESCE(s.name, r.name_ru) AS name,
  COALESCE(s.registration_date, r.registration_date) AS registration_date,
  s.oked, s.oked_name,
  COALESCE(s.address, r.legal_address, r.location_address) AS address,
  COALESCE(s.director, r.director_name) AS director,
  s.legal_status, s.krp_code, s.krp_name, s.kfs_code, s.kfs_name,
  s.sector_code, s.sector_name,
  COALESCE(s.updated_at, r.updated_at) AS updated_at,
  s.raw_snapshot_path,
  COUNT(t.id) AS tender_count_total,
  -- ... остальные агрегаты tenders без изменений ...
  r.phone AS registry_phone,
  r.email AS registry_email,
  r.website AS registry_website,
  r.participant_id,
  r.role AS registry_role
FROM company_bins c
LEFT JOIN stat_gov_data s ON s.bin = c.bin
LEFT JOIN goszakup_registry_data r ON r.bin = c.bin
LEFT JOIN tender_data t ON t.bin = c.bin
WHERE ... -- фильтр по bins если передан
GROUP BY c.bin
ORDER BY name COLLATE NOCASE
```

**Важно:**
- `mapStatGov(row)` должен работать с COALESCE-полями — при необходимости поправь маппер, не дублируй логику
- Существующий тест `builds company cards with tender aggregates` не сломать
- Добавь тест: **только registry**, без stat.gov → карточка возвращается с `name` из `name_ru`, `registry_phone` заполнен

---

## Тесты

### `tests/kz/goszakupRegistryParser.test.ts` — дополнить

```typescript
describe("normalizePhone", () => {
  it("rejects concatenated garbage", () => {
    expect(normalizePhone("+34369387011878787")).toBeNull();
  });
  it("accepts valid KZ mobile", () => {
    expect(normalizePhone("+77071017793")).toBe("+77071017793");
  });
});

describe("normalizeWebsite", () => {
  it("rejects email in website field", () => {
    expect(normalizeWebsite("pernebeknps10@mail.ru")).toBeNull();
  });
  it("rejects placeholder dash", () => {
    expect(normalizeWebsite("-")).toBeNull();
  });
});
```

### `tests/kz/kzStorage.test.ts` — новый кейс

```typescript
it("includes registry-only BIN in company cards", () => {
  storage.upsertGoszakupRegistry({
    bin: "241240019455",
    participant_id: "12345",
    name_ru: "ТОО ALATAU STROY 2030",
    // ... минимальные поля ...
    phone: "+77072454647",
    email: "torekhanuly_m@mail.ru",
    updated_at: "2026-06-07T00:00:00.000Z"
  });
  const cards = storage.getCompanyCards(["241240019455"]);
  expect(cards).toHaveLength(1);
  expect(cards[0].name).toBe("ТОО ALATAU STROY 2030");
  expect(cards[0].registry_phone).toBe("+77072454647");
});
```

### Опционально: fixture `tests/fixtures/goszakup-registry-profile-061040006408.html`

Минимальный HTML с «грязным» телефоном для regression — если есть snapshot из `data/debug/`, используй; иначе синтетический.

---

## DoD

```bash
npm run lint
npx vitest run tests/kz
```

**Ручная проверка** (если есть сеть + Playwright):

```bash
npm run kz:registry -- bins-batch.csv --force-refresh --delay-ms 1500
npm run kz:export -- --bins bins-batch.csv --out data/kz-registry-batch-v2.xlsx
```

| Проверка | Ожидание |
|----------|----------|
| `goszakup_registry_data` count | 10 |
| `participant_id` not null | 10/10 |
| phone `061040006408` | null или валидный `+7...` (12 символов) |
| website `080440022930` | null |
| website `260540002333` | null |
| XLSX Companies rows | **10** (включая `241240019455`) |

**Commit:**
```
fix(kz): improve goszakup registry data quality and export coverage (stage 3.5.1)
```

---

## Не делать

- Новые таблицы / миграции
- Рефакторинг collector flow (Playwright selectors)
- Авто-перезапись уже сохранённых записей без `--force-refresh`
- Batch audit script / runbook (Stage 4)

---

## Порядок работы

1. `normalizePhone` + `normalizeWebsite` + тесты
2. `participant_id` propagation в collector
3. `getCompanyCards` union + storage test
4. lint + vitest
5. (опционально) batch re-run для верификации

Начни с parser validators — они изолированы и дают быстрый feedback.
