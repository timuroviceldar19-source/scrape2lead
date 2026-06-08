# KZ Batch Runbook — 50–100 БИН

Проверка качества zakup.sk.kz на реальном batch после `kz enrich`.

## Важно про zakup

Поиск на zakup.sk.kz идёт по **тексту в лотах**, не по БИН заказчика. API `4dv3rts/filter` **не возвращает** поле заказчика в списке. Поэтому часть результатов может быть **ложной** — лот совпал по слову из названия компании, но заказчик другой.

Аудит ловит эвристики:
- `cross_bin_duplicate` — один `tender_number` у нескольких БИН
- `weak_title_match` — в названии лота нет токенов компании
- `high_volume` — >10 zakup-лотов на одну компанию
- `short_search_name` — слишком короткое нормализованное имя

**Ручная проверка обязательна** для строк с `review_priority=high` + скриншоты `data/debug/zakup-search-<BIN>.png`.

---

## 1. Подготовить список БИН

Файл `bins-batch.csv` — по одному БИН на строку, 12 цифр:

```text
bin
220540025781
010140001234
...
```

### Откуда взять 50–100 БИН

| Источник | Как |
|---|---|
| **goszakup harvest (рекомендуется)** | `npm run kz:harvest -- 50 bins-batch-50.csv` |
| Свой CRM / Excel | Экспорт колонки БИН |
| Feeder 2GIS/Kaspi | Собрать лиды → `merge` после stat |
| Тестовый срез | 10 знакомых + 40 из одной отрасли по ОКЭД |

**Harvest ТОО** (`scripts/harvest-registry-bins.ts`):
- Поиск только по **«ТОО»** в публичном реестре goszakup
- Парсинг строк таблицы (БИН + наименование)
- Фильтр: наименование содержит ТОО, не ИП/физлицо
- Валидация: формат 12 цифр + **контрольная цифра KZ**
- Метафайл `{out}-meta.json` — отклонённые причины (`not_too_name`, `invalid_checksum`)

Не используй сырой regex по HTML — это тянет ИП и битые BIN (см. `bins-batch-33-excluded.json`).

---

## 2. Прогон pipeline

```bash
# Сессия stat.gov (если протухла)
npm run kz:login

# Первый прогон — полный сбор
npm run dev -- kz enrich bins-batch.csv --force-refresh

# Только тендеры (stat уже в БД)
npm run dev -- kz enrich bins-batch.csv --skip-stat

# Экспорт для бизнеса
npm run kz:export -- --bins bins-batch.csv
```

**Оценка времени:** ~4–6 сек на БИН (stat + zakup) → 50 БИН ≈ 4–5 мин, 100 БИН ≈ 8–10 мин.

Рекомендуется сначала **пилот 10 БИН**, потом полный batch.

---

## 3. Аудит качества

```bash
npm run kz:audit -- bins-batch.csv
# или все компании в БД:
npm run kz:audit
```

Создаёт `exports/kz-audit-<timestamp>.xlsx`:
- **Summary** — сводка
- **Companies** — флаги по компаниям
- **TendersReview** — только подозрительные лоты

---

## 4. Критерии приёмки batch

| Метрика | Хорошо | Плохо |
|---|---|---|
| stat.gov success rate | ≥ 80% | < 70% |
| `search input not found` | ≤ 1/10 | > 3/10 — retry не помогает, проверить SPA |
| `cross_bin_duplicate` | 0 | > 0 — баг или шум поиска |
| `weak_title_match` / все zakup | < 30% | > 50% — поиск по имени не работает для продукта |
| `high_volume` компаний | < 5% batch | > 15% |
| zakup accepted | 0 ок (filter) | — |
| Ручная выборка 10 БИН | ≥ 7/10 корректны | < 5/10 — стоп, чинить zakup |

**Ожидаемое поведение после Stage 3.6:** `search input not found` ≤ 1/10 (было 4/10). `zakup accepted = 0` — нормально, filter работает корректно.

### Ручная выборка (10 компаний)

1. Отсортируй **Companies** по `review_priority=high`.
2. Для каждой: открой скриншот `data/debug/zakup-search-<BIN>.png`.
3. Открой 1–2 URL из **TendersReview**.
4. Зафиксируй: ✅ заказчик совпал / ❌ ложное совпадение.

Шаблон заметок:

```text
BIN | company | tenders | manual_ok | comment
220540025781 | API-KZ | 3 | 1/3 | лоты не про эту компанию
```

---

## 5. Если качество zakup плохое

Варианты (по приоритету):
1. **Этап 3 optional B** — не сохранять tender при `weak_title_match` + запись в `kz_enrich_errors`.
2. Открывать карточку лота в Playwright и парсить заказчика с детальной страницы (медленно).
3. Опираться на **goszakup.gov.kz** по БИН (после получения токена) как primary для госзакупок.
4. Использовать zakup только как discovery, не как verified customer list.

---

## 6. Чеклист после batch

- [ ] `kz enrich` завершился без критических ошибок
- [ ] `kz:export` — XLSX для клиента/анализа
- [ ] `kz:audit` — workbook с флагами
- [ ] Ручная выборка 10 БИН задокументирована
- [ ] Решение: zakup ok / zakup с фильтром / goszakup primary
