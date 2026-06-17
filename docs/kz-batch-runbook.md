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

**Проверенные наборы (harvest v2):**
| Файл | BIN | stat | registry | export |
|---|---|---|---|---|
| `bins-batch-33-harvest.csv` | 33 | 33/33 | 33/33 | 33/33 |
| `bins-batch-50-v2.csv` | 50 | 50/50 | 50/50 | 50/50 |
| `bins-batch-100.csv` | 100 | 99/100 | 100/100 | 100/100 |

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

## 6. Outreach Autopilot (еженедельный дифф)

Одна команда: инкрементальный enrich (skip zakup) → дифф «что нового с прошлого запуска» → два XLSX → уведомление в Telegram.

```bash
# Первый запуск — baseline: фиксирует текущее состояние, ничего не экспортирует
npm run kz:autopilot

# Либо сразу с точкой отсчёта (экспортирует контракты/закупки с даты)
npm run kz:autopilot -- --since 2026-06-01

# Обычный еженедельный запуск (с прогрессом и лимитом страниц goszakup)
npm run kz:autopilot -- --progress --max-pages 5

# Посмотреть без записи в БД и без Telegram
npm run kz:autopilot -- --dry-run --skip-enrich
```

Флаги: `--batch-csv` (default `bins-batch.csv`), `--top-a-csv` (default `bins-top-a.csv`), `--out-dir` (default `exports`), `--since <ISO|dd.mm.yyyy>`, `--dry-run`, `--skip-enrich`, `--progress` (по-БИНовый лог этапов enrich: `enrich [stat.gov] 7/40 BIN=... elapsed=4m12s` + полная сводка), `--max-pages <n>` (лимит страниц goszakup на БИН; приоритет над env `GOSZAKUP_HTML_MAX_PAGES`, default 50), `--baseline` (принудительно зафиксировать весь текущий дифф в `outreach_items` без экспорта).

**Важно:** если первый боевой запуск делался с `--since`, история до этой даты осталась незафиксированной — следующий обычный запуск вывалит её всю в дайджест. Лечится одним запуском `npm run kz:autopilot -- --skip-enrich --baseline`.

Без `--max-pages` полный enrich может идти часами: goszakup HTML обходит до 50 страниц × 3 списка на каждый БИН. Для еженедельного диффа достаточно `--max-pages 5` (250 свежих записей на список).

Артефакты:
- `exports/digest-winners-<дата>.xlsx` — свежие победители (контракты supplier-side) с контактами. Продукт для факторинга/банков (сегмент 2).
- `exports/outreach-queue-<дата>.xlsx` — Top-A компании с новыми активными закупками + готовые WhatsApp-сообщения и `wa.me`-ссылки (сегмент 1).
- `exports/autopilot-<дата>.json` — машинно-читаемая сводка запуска (см. ниже).

Telegram: задать `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` в `.env` — бот пришлёт сводку, черновик письма для факторинга и оба файла. Без env — просто warning в консоли. При `zeroOutput` (см. ниже) сообщение приходит с префиксом `⚠️` — это алерт, а не «всё ок».

Дедуп: пары (БИН, номер тендера) пишутся в `outreach_items`, второй раз в дайджест не попадают.

### Параллельные запуски и lock

`kz-autopilot` в начале создаёт **lock-файл** `data/autopilot.lock` через `O_CREAT|O_EXCL`. Внутри JSON: `{pid, host, startedAt, command}`. Второй запуск, пока первый держит lock, **завершается сразу с exit code 2** и сообщением `autopilot: lock busy: pid=…`. Запланировано две задачи в одно время — вторая просто отказывается стартовать, не дублирует Telegram и не плодит файлы.

Stale lock: если в lock-файле PID из этого же хоста, но процесс мёртв (`process.kill(pid, 0)` → ESRCH), autopilot удалит lock и попробует acquire ещё раз. Lock с другого хоста **не трогается** — чтобы не сбить соседнюю машину при шаре NFS. Если scheduler оставил lock после падения и PID уже переиспользован другим процессом — увы, детектировать нельзя; ручной фикс — удалить `data/autopilot.lock`.

Переопределить путь: `KZ_AUTOPILOT_LOCK_PATH=/path/to/lock` (например, на Windows-сервере с двумя `scrapе2lead` инсталляциями).

### Exit codes

| Code | Смысл | Что делать |
|---|---|---|
| 0 | OK (включая baseline/dry-run и zeroOutput) | ничего |
| 1 | Необработанная ошибка (catch-all) | смотреть stderr + summary JSON |
| 2 | Lock занят другим запуском | в логах второго процесса `lock busy: pid=…`; основной запуск в порядке |
| 3 | DB / diff / register error | проверить `data/scrape2lead.db`, миграции, диск |
| 4 | Ошибка записи XLSX-экспорта | проверить `out-dir` (по умолчанию `exports/`), права на запись, диск |
| 5 | Нет БИНов / невалидные аргументы | проверить `--batch-csv` / `--top-a-csv` и их содержимое |

`process.exitCode` используется вместо `process.exit()` — `main().catch` оставляет код 0/1/2/3/4/5 нетронутым, перезаписывает только если был 0.

### Summary JSON

Каждый запуск пишет `exports/autopilot-YYYY-MM-DD.json` со всеми полями, которые пригодятся мониторингу:

```json
{
  "startedAt": "2026-06-17T08:00:00.000Z",
  "finishedAt": "2026-06-17T08:00:12.345Z",
  "elapsedMs": 12345,
  "dryRun": false,
  "baseline": false,
  "enrichSkipped": false,
  "bins": 40,
  "winners": 7,
  "prospects": 12,
  "registered": 19,
  "exportedFiles": ["exports/digest-winners-2026-06-17.xlsx", "exports/outreach-queue-2026-06-17.xlsx"],
  "warnings": ["stat.gov: 3 БИНов не обновились (проверь QR-сессию: npm run kz:login)"],
  "zeroOutput": false,
  "exitCode": 0,
  "exitReason": "ok",
  "lockHeldBy": null
}
```

Для lock-busy кейса `lockHeldBy` заполнен данными владельца, `exitReason: "lock busy"`, `exitCode: 2`. Файл всегда пишется в `finally` — даже если пайплайн упал.

### Zero-output

`zeroOutput: true` ставится, когда `winners === 0 && prospects === 0 && warnings.length === 0`. Это не ошибка, но **сигнал «что-то не так»**: либо `--since` отрезал всё, либо BIN-ы не обновились, либо enrich не запустился. В Telegram-уведомлении (для non-dry-run) добавляется префикс `⚠️ Autopilot: 0 новых… — проверь enrich / --since / БИНы в CSV`.

Enrich warning (например, протухшая QR-сессия stat.gov) даёт ненулевой `warnings`, поэтому `zeroOutput: false` — это уже не «нулевой» кейс, а «известная деградация». Проверь `npm run kz:login` и запуск руками.

### Мониторинг последнего запуска через `/health`

API-сервер (`npm run server`) отдаёт последний autopilot job в блоке `lastAutopilotRun` на `GET /health` (см. [docs/server.md](./server.md#get-health)). Это самый простой способ для оператора/мониторинга узнать, что autopilot действительно отработал, и в каком он статусе:

```bash
curl -s http://127.0.0.1:8787/health | jq '.lastAutopilotRun'
# {
#   "id": "5c6c…",
#   "status": "completed",
#   "createdAt": "2026-06-15T08:00:00.000Z",
#   "finishedAt": "2026-06-15T08:00:42.456Z",
#   "exitCode": 0,
#   "artifacts": ["autopilot-2026-06-15.json", "digest-winners-2026-06-15.xlsx"]
# }
```

`lastAutopilotRun: null` означает, что через API-сервер ещё ни разу не запускали `kz-autopilot` (либо retention вычистил старые записи). Если чтение JobStore падает, `jobStore: { ok: false, error: ... }` в том же response — `/health` остаётся `200 ok: true`, чтобы не ломать внешний мониторинг.

Operator UI показывает весь `/health` JSON в health-tooltip; правок в UI не требуется.

### Еженедельный запуск (Windows Task Scheduler)

Enrich открывает **видимый** браузер (stat.gov работает с `headless: false`) — в неинтерактивной сессии планировщика он не взлетит. Поэтому два варианта:

**Рекомендуется — разнести enrich и дифф:**

```powershell
# Дифф без браузера — можно запускать в любой сессии
schtasks /Create /TN "kz-autopilot-diff" /SC WEEKLY /D MON /ST 08:00 `
  /TR "cmd /c cd /d C:\Users\Madara\Desktop\Scrapper && npm run kz:autopilot -- --skip-enrich >> logs\autopilot.log 2>&1"
```

Enrich при этом запускай руками накануне (`npm run kz:enrich -- bins-top-a.csv` или `npm run kz:autopilot -- --progress --max-pages 5 --dry-run`), либо отдельной задачей с опцией **"Run only when user is logged on"**.

**Либо одной задачей** — тогда обязательно "Run only when user is logged on":

```powershell
schtasks /Create /TN "kz-autopilot" /SC WEEKLY /D MON /ST 08:00 /IT `
  /TR "cmd /c cd /d C:\Users\Madara\Desktop\Scrapper && npm run kz:autopilot -- --max-pages 5 >> logs\autopilot.log 2>&1"
```

Перед стартом убедись, что сессия stat.gov свежая (`npm run kz:login`) — иначе autopilot продолжит на данных из базы и добавит warning в Telegram.

---

## 7. Чеклист после batch

- [ ] `kz enrich` завершился без критических ошибок
- [ ] `kz:export` — XLSX для клиента/анализа
- [ ] `kz:audit` — workbook с флагами
- [ ] Ручная выборка 10 БИН задокументирована
- [ ] Решение: zakup ok / zakup с фильтром / goszakup primary
