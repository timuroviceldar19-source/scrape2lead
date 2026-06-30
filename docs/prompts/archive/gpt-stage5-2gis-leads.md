# Промпт: Stage 5 — 2GIS/leads + KZ enrich glue

Скопируй блок **ЗАДАНИЕ** целиком в GPT/Cursor.

**База:** после `d7908b4` (`develop`, локально).  
**Контекст:** KZ pipeline готов (stat + registry + HTML-контракты, scoring, export 100 BIN).  
**Sales slice:** `exports/kz-top-a-leads.xlsx` — 30 компаний приоритет A, 8316 контрактов.

**Спека:** `docs/TZ_v2.md` §8 Этап 4 (первый пункт — связь с `leads` / feeder 2GIS).

---

## ЗАДАНИЕ

Проект: `C:\Users\Madara\Desktop\Scrapper`

**Цель Stage 5:** связать **legacy 2GIS/Kaspi leads** с **KZ enrich по БИН** и выдать **единый XLSX** для продаж: телефон/адрес из 2GIS + stat/registry + контракты goszakup + scoring.

**Не трогай:** goszakup HTML collector logic, zakup filter, harvest scripts, Assets/, 2GIS experimental scripts в корне (unless wiring explicitly).

---

## Текущее состояние (gap)

| Что есть | Где |
|---|---|
| KZ enrich + export | `kz enrich`, `kz export`, `src/kz/kzExporter.ts` |
| Lead type с KZ полями | `src/types.ts` — `bin`, `oked`, `director`, `legal_form`, … |
| SQLite leads columns | `src/storage/migrations.ts` (v11+) |
| merge stat → leads | `scripts/merge-stat-gov-data.ts`, CLI `kz merge` |
| Legacy 2GIS export | `src/export/exporter.ts` |
| **Незакоммичено** | `exporter.ts` (+ KZ columns), `postgres/*` (migration v2, upsert leads) |
| top-A sales export | `scripts/kz-export-top-a.mts` → `exports/kz-top-a-leads.xlsx` |

**Проблемы:**
1. `merge-stat-gov-data.ts` матчит только по `stat_gov_data` ↔ `leads.name` — нет registry/goszakup fallback, нет reverse flow (BIN CSV → enrich → join leads).
2. Два разных export path: legacy `exporter.ts` (2GIS) vs `kzExporter.ts` (KZ-only).
3. Postgres path частично подготовлен, но не закоммичен и без тестов на новые колонки.
4. Нет команды «взять leads из DB → собрать BIN list → enrich → unified XLSX».

---

## Fix 1 — Закоммитить подготовленный diff (если валиден)

Проверь и доведи до green tests:

```
src/export/exporter.ts          — колонки BIN, ОКЭД, director в XLSX
src/storage/postgres/migrations.ts  — migration v2: KZ fields on leads
src/storage/postgres/sql.ts
src/storage/postgres/PostgresStorage.ts
tests/enrichmentFilter.test.ts  — null → undefined (если нужно для типов)
```

**DoD:** `npx vitest run tests/enrichmentFilter.test.ts tests/storageAbstraction.test.ts` — без регрессий.

---

## Fix 2 — Unified merge: leads ↔ KZ data

Создай `src/kz/leadKzMerge.ts` (или расширь `merge-stat-gov-data.ts`):

### Matching strategy (priority order)

1. `lead.bin === company.bin` (exact)
2. `stat_gov_data.bin` + fuzzy name (`matchNames` из `nameNormalizer`)
3. `goszakup_registry_data.bin` + fuzzy name (fallback если stat missing — см. `220640028224`)

### Write-back to `leads`

Поля: `bin`, `registration_date`, `oked`, `oked_name`, `director`, `legal_status`, `company_age_years`, `legal_form`  
Источник: `stat_gov_data` > registry > null.

### New: enrich columns on export (read-only join)

Для export **не дублировать** всё в leads — можно JOIN at export time из `tender_data` aggregates + `kzLeadScore`:

| Колонка | Источник |
|---|---|
| `tender_count_total` | `KzStorage.getCompanyCards` |
| `tender_count_active` | idem |
| `tender_active_budget_sum` | idem |
| `lead_priority` | `scoreCompanyCard()` |
| `registry_phone` | `goszakup_registry_data` |

---

## Fix 3 — CLI: unified export

Добавь команду:

```bash
npm run dev -- kz export-unified [--out exports/unified.xlsx] [--priority A|B|C]
```

**Pipeline:**
1. Read leads from SQLite (`Storage` / `KzStorage` same DB `data/scrape2lead.db`)
2. Collect unique BINs from `leads.bin` + optional `--bins csv`
3. For BINs without fresh KZ data → `runKzEnrich` subset (flags: `--skip-zakup` default)
4. Merge KZ into lead view
5. Write XLSX: **Leads** (2GIS fields + KZ + scoring), **Tenders** (filtered by lead BINs), **Summary**, **Errors**

Reuse `src/export/exporter.ts` styling helpers or extract shared `styleSheet` from `kzExporter.ts`.

---

## Fix 4 — BIN discovery from 2GIS leads

Если у lead нет BIN:

1. Попробовать harvest: поиск в goszakup registry по названию (optional, scope cut — **не обязательно в v1**)
2. Или: оператор запускает `kz harvest` → manual merge

**MVP scope:** работать только с leads где `bin` уже заполнен **или** после `kz merge`.

Добавь в Summary метрику: `leads_without_bin`, `leads_with_kz_tenders`.

---

## Fix 5 — npm scripts + docs

```json
"kz:export-top-a": "tsx scripts/kz-export-top-a.mts",
"kz:export-unified": "tsx scripts/kz-export-unified.ts"
```

Обнови `docs/TZ_v2.md` §8 Этап 4 — первый чекбокс ✅ после реализации.  
Краткая секция в README или `docs/kz-batch-runbook.md`: flow 2GIS → merge → enrich → export-unified.

---

## Тесты (минимум)

1. `tests/kz/leadKzMerge.test.ts` — match by bin, fuzzy name, registry fallback
2. `tests/kz/unifiedExport.test.ts` — in-memory DB: 2 leads + stat + tenders → export row count
3. Не чини `exporter.test.ts` / `postgresMigrationOrdering.test.ts` unless your migration fixes ordering

---

## Smoke (ручной)

```bash
# 1. Убедись что в DB есть 2GIS leads (или seed fixture)
npm run dev -- kz merge

# 2. Enrich BINs from leads
npm run dev -- kz enrich bins-from-leads.csv --skip-zakup

# 3. Unified export
npm run dev -- kz export-unified --out exports/unified-smoke.xlsx

# 4. Top-A slice (уже работает)
npx tsx scripts/kz-export-top-a.mts exports/kz-batch-100-scored.xlsx exports/kz-top-a-leads.xlsx
```

---

## Definition of Done

- [ ] Postgres + SQLite paths сохраняют KZ fields на leads
- [ ] `kz export-unified` → один XLSX с 2GIS + KZ + scoring
- [ ] `kz merge` обновляет leads из stat (+ registry fallback для stat gaps)
- [ ] Summary показывает coverage: % leads with bin, with tenders
- [ ] Unit tests green для merge + unified export
- [ ] `docs/TZ_v2.md` обновлён
- [ ] Нет секретов в коммите

**Commit message:**
```
feat(kz): glue 2GIS leads with KZ enrich and unified export (stage 5)
```

---

## Out of scope (Stage 5.1+)

- Telegram notifications
- cron / scheduled re-run
- Postgres as default production backend switch
- goszakup registry search by company name (no BIN)
- zakup.sk.kz full batch without audit

---

## Справка: scoring thresholds (`src/kz/kzLeadScore.ts`)

| Priority | Условие |
|---|---|
| **A** | active ≥ 10 OR active budget ≥ 50M OR (active ≥ 5 AND budget ≥ 10M) |
| **B** | active ≥ 3 OR budget ≥ 1M OR total ≥ 20 |
| **C** | any tenders |

High volume: `tender_count_total >= 50`.

---

## Справка: sales file (уже готов)

`exports/kz-top-a-leads.xlsx`:
- **30** companies priority A
- **8316** supplier contracts (high-volume A leads)
- Сортировка: `Сумма активных` DESC

Используй как acceptance reference для unified export quality.
