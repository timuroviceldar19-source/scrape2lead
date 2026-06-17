# Operator API Runbook

Практическая инструкция для оператора на Windows: запуск `kz-enrich` jobs через
HTTP API, наблюдение за очередью, скачивание артефактов и отмена. Все примеры
на PowerShell (`Invoke-RestMethod` / `Invoke-WebRequest`), плюс `curl` для
сравнения.

Полный контракт эндпоинтов — в [docs/server.md](./server.md). Здесь только
то, что нужно оператору в работе.

---

## 0. Подготовка

Запусти сервер (в отдельном окне):

```powershell
# dev (tsx) — подхватывает изменения кода
npm run server:dev

# или из собранного dist
npm run build
npm run server
```

По умолчанию слушает `http://127.0.0.1:8787`. Если задан
`SCRAPE2LEAD_API_TOKEN` — нужен заголовок `Authorization: Bearer <token>`
или `X-API-Token: <token>`.

Задай переменные в начале сессии, чтобы не повторять в каждом вызове:

```powershell
$ROOT = "http://127.0.0.1:8787"     # корень — нужен для /health
$BASE = "$ROOT/api/v1"             # все операторские эндпоинты живут тут
$H    = @{ "Content-Type" = "application/json" }
# раскомментируй, если задан SCRAPE2LEAD_API_TOKEN:
# $H["Authorization"] = "Bearer $env:SCRAPE2LEAD_API_TOKEN"
```

> Все маршруты доступны и по `/api/...` (legacy alias). В примерах ниже
> используется `/api/v1`.

---

## 0.5. Web dashboard (рекомендовано)

Для ручной работы в браузере есть встроенный дашборд. Открой:

```text
http://127.0.0.1:8787/operator
```

- Страница `/operator` отдаётся публично (без `Authorization` и `X-API-Token` в запросе) даже когда задан `SCRAPE2LEAD_API_TOKEN` — токен вводится в поле «API token» в top bar, после чего UI подставляет `Authorization: Bearer <token>` в каждый запрос к `/api/v1/*` и `/health`.
- Дашборд покрывает те же операторские действия, что разделы 1-7 ниже: submit `kz-enrich` с BIN-ами и расширенными флагами, очередь и список jobs с фильтром по статусу, детали job и просмотр логов, отмена queued/running, список и скачивание артефактов, smoke-check здоровья.
- Дашборд умеет submit `kz-export` после enrich: задаёшь опциональный список BIN-ов и опциональное имя файла (всегда под `exports/<filename>.xlsx`); пустой BIN-list экспортирует все компании, которые сейчас есть в БД, а готовый xlsx появляется в per-job / global artifacts и скачивается по `GET /api/v1/artifacts/:id`.
- API-примеры ниже (`Invoke-RestMethod` / `curl`) оставлены для headless / scripted / server-to-server / CI сценариев, где браузер не подходит.

Когда браузер недоступен или нужно автоматизировать — переходи к разделу 1.

---

## 1. Поставить kz-enrich job

Через массив `bins` — сервер сам создаст временный CSV в `data/server-jobs/`:

```powershell
$body = @{
  bins               = @("061040006408", "960440000716")
  skipStat           = $true            # пропустить stat.gov (для теста)
  goszakupMaxPages   = 3
  delayMs            = 1500
} | ConvertTo-Json -Depth 5

$job = Invoke-RestMethod -Method Post -Uri "$BASE/jobs/kz-enrich" -Headers $H -Body $body
$jobId = $job.job.id
$jobId
```

Через готовый CSV:

```powershell
$body = @{ csvFile = "bins-batch.csv" } | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Uri "$BASE/jobs/kz-enrich" -Headers $H -Body $body
```

`curl`-аналог:

```bash
curl -X POST http://127.0.0.1:8787/api/v1/jobs/kz-enrich \
  -H "Content-Type: application/json" \
  -d "{\"bins\":[\"061040006408\",\"960440000716\"],\"skipStat\":true}"
```

Все whitelisted-поля для `kz-enrich`: `csvFile`, `binsCsv`, `bins`, `skipStat`,
`skipTenders`, `skipZakup`, `skipGoszakupRegistry`, `skipGoszakupHtml`,
`registryOnly`, `delayMs`, `forceRefresh`, `goszakupActiveOnly`,
`goszakupMaxPages`, `zakupMaxRetries`.

---

## 2. Смотреть очередь / jobs

Список всех jobs с пагинацией:

```powershell
Invoke-RestMethod -Uri "$BASE/jobs?limit=20&offset=0" -Headers $H
```

Только активные (queued + running):

```powershell
Invoke-RestMethod -Uri "$BASE/jobs?status=running" -Headers $H
Invoke-RestMethod -Uri "$BASE/jobs?status=queued"  -Headers $H
```

Детали конкретного job (статус, exit code, встроенный `logTail`):

```powershell
$detail = Invoke-RestMethod -Uri "$BASE/jobs/$jobId" -Headers $H
$detail.job | Select-Object id, type, status, exit_code, signal, error, created_at, finished_at
```

`logTail` в `GET /jobs/:id` — последние 20 строк (для list-view). Полный лог
отдельным запросом — шаг 3.

`curl`-аналоги:

```bash
curl "http://127.0.0.1:8787/api/v1/jobs?status=running&limit=10"
curl http://127.0.0.1:8787/api/v1/jobs/<jobId>
```

---

## 3. Смотреть logs с limit/offset

По умолчанию возвращает **первые `SCRAPE2LEAD_MAX_LOG_LINES` строк (500)**,
не весь лог. Чтобы прокрутить — `?offset=N&limit=M`.

```powershell
# первые 100 строк
Invoke-RestMethod -Uri "$BASE/jobs/$jobId/logs?limit=100" -Headers $H

# следующие 100 (offset=100)
Invoke-RestMethod -Uri "$BASE/jobs/$jobId/logs?limit=100&offset=100" -Headers $H

# только хвост при ручном просмотре (offset = total - 50)
$total = 0  # смотри ниже как узнать total
```

В response есть метаданные — `total`, `limit`, `offset`, `maxLogLines`:

```powershell
$logs = Invoke-RestMethod -Uri "$BASE/jobs/$jobId/logs?limit=200" -Headers $H
$logs.total          # сколько строк всего в JobStore
$logs.limit          # фактический limit после clamp
$logs.offset         # фактический offset
$logs.maxLogLines    # текущий cap (env SCRAPE2LEAD_MAX_LOG_LINES)
$logs.logs[0..4]     # первые 5 строк
```

Печать в консоль читаемо:

```powershell
$logs.logs | ForEach-Object { "[$($_.stream)] $($_.line)" }
```

`curl`-аналог:

```bash
curl "http://127.0.0.1:8787/api/v1/jobs/<jobId>/logs?limit=200&offset=0"
```

---

## 4. Отменить queued / running job

Один и тот же эндпоинт для queued и running:

```powershell
Invoke-RestMethod -Method Post -Uri "$BASE/jobs/$jobId/cancel" -Headers $H
```

Что происходит:

- **queued** → сразу становится `cancelled`, слот не занимался.
- **running** → сервер шлёт `SIGTERM` процессу, записывает `system`-лог
  `Cancellation requested`, ждёт выхода, ставит статус `cancelled`.
- **completed / failed / cancelled / interrupted** → `409 job_not_cancellable`
  с текущим job в теле.

Проверить результат:

```powershell
$after = Invoke-RestMethod -Uri "$BASE/jobs/$jobId" -Headers $H
$after.job.status  # ожидаемо: "cancelled"
```

Быстрая проверка: поставить несколько jobs подряд, отменить второй до того,
как он начнёт выполняться (слот один):

```powershell
foreach ($bin in "061040006408","960440000716","220540025781") {
  $j = Invoke-RestMethod -Method Post -Uri "$BASE/jobs/kz-enrich" -Headers $H `
        -Body (@{ bins = @($bin) } | ConvertTo-Json)
  Write-Host "queued: $($j.job.id)"
}
# отмени второй через Invoke-RestMethod -Method Post .../cancel
```

---

## 5. Скачать artifacts через JobStore id

**Основной путь**: persistent id из `api_job_artifacts`. Никаких произвольных
имён из `exports/` — `GET /api/v1/artifacts/report.xlsx` по умолчанию
вернёт `404`.

Получить список с id:

```powershell
$arts = Invoke-RestMethod -Uri "$BASE/artifacts" -Headers $H
$arts.source                            # "jobStore"
$arts.artifacts | Select-Object id, jobId, name, size, mtime
```

Скачать по id (PowerShell сохранит в `Downloads\artifact-<id>.bin` —
переименуй по `name` из списка):

```powershell
$id = 1
$name = ($arts.artifacts | Where-Object id -eq $id).name
$out = Join-Path $env:USERPROFILE "Downloads\$name"
Invoke-WebRequest -Uri "$BASE/artifacts/$id" -OutFile $out -Headers $H
Get-Item $out | Select-Object FullName, Length
```

Если файл удалён с диска — `410 artifact_file_missing`. Если id не
существует — `404 artifact_not_found`.

Per-job вариант (удобно, когда jobs много):

```powershell
Invoke-RestMethod -Uri "$BASE/jobs/$jobId/artifacts" -Headers $H
Invoke-WebRequest -Uri "$BASE/jobs/$jobId/artifacts/$name" -OutFile $out -Headers $H
```

`curl`-аналоги:

```bash
curl http://127.0.0.1:8787/api/v1/artifacts
curl -OJ http://127.0.0.1:8787/api/v1/artifacts/1
curl -O  http://127.0.0.1:8787/api/v1/jobs/<jobId>/artifacts/report.xlsx
```

---

## 6. Проверить, что legacy fallback только явный

Сначала убедись, что **по умолчанию** файл из `exports/` без записи в
JobStore **не отдаётся**:

```powershell
# Положи вручную файл вне JobStore и запомни имя в $compatName:
$compatName = "compat-$(Get-Date -Format yyyyMMddHHmmss).csv"
"compat-content" | Out-File -Encoding utf8 "exports/$compatName"

# По умолчанию — 404. PowerShell бросает исключение на 4xx/5xx,
# поэтому оборачиваем в try/catch и вытаскиваем код из ответа:
try {
  Invoke-WebRequest -Uri "$BASE/artifacts/$compatName" -Headers $H -UseBasicParsing | Out-Null
  Write-Host "UNEXPECTED: 2xx для legacy-файла без ?legacy=1"
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  $code   # 404
}

# В списке default его нет
$default = Invoke-RestMethod -Uri "$BASE/artifacts" -Headers $H
$default.source                                    # "jobStore"
($default.artifacts | Where-Object name -eq $compatName).Count   # 0
```

Включи legacy **явно** — двумя способами:

```powershell
# A) На конкретный запрос:
$legacy = Invoke-RestMethod -Uri "$BASE/artifacts?legacy=1" -Headers $H
$legacy.source                           # "jobStore+exports"
$legacy.artifacts | Where-Object jobId -eq "legacy-exports"

# B) Глобально на инстанс (env, требует рестарт сервера):
#    $env:SCRAPE2LEAD_ARTIFACT_LEGACY_FALLBACK = "1"
#    npm run server:dev
```

Legacy-записи помечаются `id: -1`, `jobId: "legacy-exports"`. В режиме
legacy имя всё равно проверяется: без `..`, без `/`, без `\`, без
Windows-drive-letter, файл должен лежать внутри `SCRAPE2LEAD_EXPORT_DIR`
(default `exports`).

Не забудь убрать `SCRAPE2LEAD_ARTIFACT_LEGACY_FALLBACK` после миграции —
оставлять его включённым в проде нельзя, иначе теряется смысл «persistent
artifacts only» контракта.

---

## 7. Быстрый smoke-check здоровья

```powershell
# 200 без auth, 401 если задан SCRAPE2LEAD_API_TOKEN.
# /health — корневой, не под /api/v1, поэтому используем $ROOT
# и передаём -Headers $H, чтобы авторизация тоже сработала:
(Invoke-WebRequest -Uri "$ROOT/health" -Headers $H -UseBasicParsing).StatusCode
```

> Эндпоинт `GET /health` живёт в корне, не под `/api/v1`.

Полная проверка одной командой (всё, что должен уметь оператор):

```powershell
# 1. submit
$j = Invoke-RestMethod -Method Post -Uri "$BASE/jobs/kz-enrich" -Headers $H `
       -Body (@{ bins = @("061040006408"); skipStat = $true } | ConvertTo-Json)
$id = $j.job.id

# 2. queue snapshot
Invoke-RestMethod -Uri "$BASE/jobs?status=running" -Headers $H

# 3. logs
Invoke-RestMethod -Uri "$BASE/jobs/$id/logs?limit=50" -Headers $H | Select-Object -ExpandProperty logs

# 4. artifacts (после завершения)
Invoke-RestMethod -Uri "$BASE/jobs/$id/artifacts" -Headers $H

# 5. cancel — только если нужно прервать
# Invoke-RestMethod -Method Post -Uri "$BASE/jobs/$id/cancel" -Headers $H
```

---

## Что дальше

- Перед массовыми запусками — `docs/kz-batch-runbook.md`.
- Полная карта эндпоинтов и безопасность — `docs/server.md`.
- Web-дашборд для оператора: [docs/server.md#operator-ui](./server.md#operator-ui).
- Спецификация Scrape2Lead — `docs/TZ_v2.md`.
