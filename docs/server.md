# Scrape2Lead API server

Дата: 2026-06-16

HTTP-сервер для операторского запуска существующих Scrape2Lead-пайплайнов. Сервер не заменяет CLI: он ставит разрешённые команды в очередь, выполняет их через `child_process.spawn`, сохраняет статусы jobs, логи и артефакты в SQLite/Postgres.

## Запуск

Dev-режим:

```bash
npm run server:dev
```

После сборки:

```bash
npm run build
npm run server
```

По умолчанию сервер слушает `http://127.0.0.1:8787`.

Переменные окружения:

| Переменная | Назначение |
|---|---|
| `SCRAPE2LEAD_HOST` | Host bind, default `127.0.0.1`. Только `127.0.0.1`, `localhost` и `::1` разрешены без токена. |
| `SCRAPE2LEAD_PORT` или `PORT` | Port, default `8787` |
| `SCRAPE2LEAD_API_TOKEN` | Если задан, нужен `Authorization: Bearer <token>` или `X-API-Token` |
| `SCRAPE2LEAD_MAX_CONCURRENT_JOBS` | Максимум одновременно выполняемых jobs, default `1` |
| `SCRAPE2LEAD_MAX_LOG_LINES` | Жёсткий cap на размер `logs`/`logTail` в responses и default `limit` для `/jobs/:id/logs`, default `500`, hard cap `5000` |
| `SCRAPE2LEAD_DATABASE_PATH` | Путь к SQLite-файлу, default `data/scrape2lead.db` |
| `POSTGRES_CONNECTION_STRING` | Postgres connection string. Приоритет выше SQLite. |
| `SCRAPE2LEAD_CORS_ORIGIN` | CORS origin, default `*` |
| `SCRAPE2LEAD_EXPORT_DIR` | Директория артефактов, default `exports` |
| `SCRAPE2LEAD_ARTIFACT_LEGACY_FALLBACK` | `1`/`true`/`yes` — включает legacy fallback на файлы в `exports/` для `/api/v1/artifacts` (по умолчанию выключен) |

## Auth и bind

- По умолчанию сервер биндится на `127.0.0.1`.
- Если `SCRAPE2LEAD_HOST` отличается от `127.0.0.1`/`localhost`/`::1`, сервер не стартует без `SCRAPE2LEAD_API_TOKEN`.
- При настроенном токене любой запрос кроме `OPTIONS /health` должен содержать `Authorization: Bearer <token>` или заголовок `X-API-Token: <token>`.

## Очередь и статусы jobs

Новый job всегда создаётся в статусе `queued`. Одновременно выполняется не более `SCRAPE2LEAD_MAX_CONCURRENT_JOBS` (default `1`) jobs. После завершения running job очередь автоматически запускает следующий queued job.

Статусы:

- `queued` — ожидает слота
- `running` — выполняется
- `completed` — завершился с кодом 0
- `failed` — завершился с ненулевым кодом или процесс упал
- `cancelled` — отменён оператором
- `interrupted` — был `running` при рестарте сервера

При старте сервера все `running` jobs помечаются `interrupted`, после чего очередь продолжает работу с queued jobs.

## Endpoints

Все маршруты доступны как в пространстве `/api/v1`, так и в legacy `/api`. Примеры ниже используют `/api/v1`.

### `GET /health`

Проверка процесса. Возвращает фиксированные идентификаторы (`ok`, `service`) и динамические поля `time` (ISO-8601, текущий момент на сервере) и `uptimeSeconds` (целое число секунд с момента старта процесса). `time` и `uptimeSeconds` меняются от запроса к запросу и не должны сравниваться в тестах/мониторинге как статика — для smoke-check достаточно `ok === true` и `service === "scrape2lead-api"`.

```json
{
  "ok": true,
  "service": "scrape2lead-api",
  "time": "2026-06-17T13:57:23.944Z",
  "uptimeSeconds": 13
}
```

### `POST /api/v1/jobs/scrape`

Запускает обычный 2GIS/Kaspi scrape через `src/cli.ts`.

```bash
curl -X POST http://127.0.0.1:8787/api/v1/jobs/scrape \
  -H "Content-Type: application/json" \
  -d "{\"configPath\":\"config.feeder.astana.json\",\"limit\":10,\"headless\":true}"
```

Разрешённые поля: `configPath`, `source`, `geo`, `category`, `limit`, `headless`, `headed`, `fixture`.

### `POST /api/v1/jobs/kz-enrich`

Запускает `kz enrich`. Можно передать существующий CSV или массив БИНов. При массиве сервер создаст временный CSV в `data/server-jobs/`.

```bash
curl -X POST http://127.0.0.1:8787/api/v1/jobs/kz-enrich \
  -H "Content-Type: application/json" \
  -d "{\"bins\":[\"960440000716\"],\"skipStat\":true,\"goszakupMaxPages\":3}"
```

Разрешённые поля: `csvFile`, `binsCsv`, `bins`, `skipStat`, `skipTenders`, `skipZakup`, `skipGoszakupRegistry`, `skipGoszakupHtml`, `registryOnly`, `delayMs`, `forceRefresh`, `goszakupActiveOnly`, `goszakupMaxPages`, `zakupMaxRetries`.

### `POST /api/v1/jobs/kz-export`

Запускает `kz export`.

```bash
curl -X POST http://127.0.0.1:8787/api/v1/jobs/kz-export \
  -H "Content-Type: application/json" \
  -d "{\"csvFile\":\"bins-batch.csv\",\"out\":\"exports/kz-report.xlsx\"}"
```

### `POST /api/v1/jobs/kz-autopilot`

Запускает weekly outreach autopilot.

```bash
curl -X POST http://127.0.0.1:8787/api/v1/jobs/kz-autopilot \
  -H "Content-Type: application/json" \
  -d "{\"skipEnrich\":true,\"dryRun\":true,\"maxPages\":5}"
```

Разрешённые поля: `batchCsv`, `topACsv`, `outDir`, `dryRun`, `since`, `skipEnrich`, `progress`, `maxPages`, `baseline`, `skipChannel`, `channelNiche`.

### Jobs

```bash
curl http://127.0.0.1:8787/api/v1/jobs
curl "http://127.0.0.1:8787/api/v1/jobs?status=running&limit=10&offset=0"
curl http://127.0.0.1:8787/api/v1/jobs/<jobId>
curl http://127.0.0.1:8787/api/v1/jobs/<jobId>/logs
curl "http://127.0.0.1:8787/api/v1/jobs/<jobId>/logs?limit=100&offset=200"
curl -X POST http://127.0.0.1:8787/api/v1/jobs/<jobId>/cancel
```

`GET /api/v1/jobs` поддерживает `status`, `limit` и `offset`.

`GET /api/v1/jobs/:id` отдаёт job c `logs`, обрезанными до `SCRAPE2LEAD_MAX_LOG_LINES` (default `500`). Можно переопределить через `?logLimit=N`.

`GET /api/v1/jobs/:id/logs` по умолчанию возвращает первые `SCRAPE2LEAD_MAX_LOG_LINES` строк, **не весь лог целиком**. Query-параметры:

| Параметр | Назначение | Default |
|---|---|---|
| `limit` | Сколько строк вернуть, начиная с `offset` | `SCRAPE2LEAD_MAX_LOG_LINES` (500) |
| `offset` | С какой позиции начать (0 = с начала) | `0` |

Запрошенный `limit` всегда clamp'ится к `SCRAPE2LEAD_MAX_LOG_LINES` (hard cap `5000`). Response содержит `total`, `limit`, `offset`, `maxLogLines` помимо массива `logs`.

### Artifacts

Список и скачивание работают **только через persistent JobStore** (`api_job_artifacts`). Файлы из `exports/` без привязки к записи в БД не отдаются. Исключение — явный legacy fallback (см. ниже).

#### `GET /api/v1/artifacts`

Возвращает артефакты из `state.jobStore.listArtifacts()`:

```bash
curl http://127.0.0.1:8787/api/v1/artifacts
```

```json
{
  "artifacts": [
    { "id": 1, "jobId": "…", "name": "report.xlsx", "size": 12345, "mtime": "2026-06-16T…" }
  ],
  "source": "jobStore"
}
```

`source: "jobStore"` — дефолт.

#### `GET /api/v1/artifacts/:id`

Скачивание по **numeric persistent id** из `api_job_artifacts`. Сервер находит запись, валидирует имя (`isSafeArtifactName`) и проверяет, что файл лежит внутри `SCRAPE2LEAD_EXPORT_DIR` (без path traversal). Если файл удалён с диска — `410 artifact_file_missing`.

```bash
curl -O http://127.0.0.1:8787/api/v1/artifacts/1
```

Нечисловой сегмент (например `report.xlsx`) **по умолчанию возвращает 404**: произвольный файл из `exports/` без записи в JobStore не отдаётся.

#### `GET /api/v1/jobs/:id/artifacts`

Per-job список:

```bash
curl http://127.0.0.1:8787/api/v1/jobs/<jobId>/artifacts
```

#### `GET /api/v1/jobs/:id/artifacts/:name`

Per-job скачивание по имени (только basename, без `..`/слэшей/drive-letter):

```bash
curl -O http://127.0.0.1:8787/api/v1/jobs/<jobId>/artifacts/report.xlsx
```

#### Legacy fallback (compat)

Для миграции со старого read-from-FS API есть явный opt-in. По умолчанию **выключен**.

Включается одним из способов:

- `?legacy=1` (или `?legacy=true`) на `GET /api/v1/artifacts`
- `SCRAPE2LEAD_ARTIFACT_LEGACY_FALLBACK=1` (или `true`/`yes`) в env

В режиме legacy список объединяется с файлами верхнего уровня из `SCRAPE2LEAD_EXPORT_DIR`, response получает `source: "jobStore+exports"`, а legacy-записи помечаются `id: -1`, `jobId: "legacy-exports"`. Имя резолвится строго внутри export-директории — путь и сегмент имени проходят те же проверки безопасности, что и persisted-артефакты.

```bash
curl "http://127.0.0.1:8787/api/v1/artifacts?legacy=1"
# → { "artifacts": [...], "source": "jobStore+exports" }
```

## Безопасность команд

Сервер не пропускает произвольные аргументы. Для каждого типа job есть whitelist builder: разрешены только известные флаги, значения валидируются (строки ≤500 символов, положительные целые для `--limit`/`--max-pages` и т.д.).

## Совместимость

Все endpoints доступны и по `/api/...` (legacy) для обратной совместимости. Новые клиенты должны использовать `/api/v1/...`.

## Operator UI

Минимальная встроенная dashboard-страница для оператора: `http://127.0.0.1:8787/operator`. Отдаёт статические файлы из `public/operator/` (`index.html`, `operator.js`, `operator.css`). UI использует только существующие `/api/v1` и `/health` endpoints и не добавляет backend-логики. Пошаговый операторский гайд — [docs/operator-api-runbook.md](./operator-api-runbook.md).

Дашборд умеет submit `kz-enrich` job-ов (BIN-ы + расширенные флаги) и `kz-export` job-ов (опциональные BIN-ы и опциональное имя файла под `exports/<filename>.xlsx`); сгенерированный report-артефакт появляется в per-job и global artifact списках и скачивается по `GET /api/v1/artifacts/:id`.

Когда задан `SCRAPE2LEAD_API_TOKEN`, страница `/operator` остаётся публичной (как `OPTIONS`), а UI отправляет токен через `Authorization: Bearer <token>` на `/api/v1/*` и `/health`.

Статические ответы `/operator` отдаются с консервативными security-заголовками: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'self'; …; frame-ancestors 'none'` и `Cache-Control: no-cache`. Это defense-in-depth для публичной страницы с bearer-токеном в `localStorage`: UI полностью inline-free, CSP строгий, не разрешает inline/внешние скрипты и embedding через iframe.

`HEAD` для `/operator` static возвращает те же заголовки, что и `GET`, без тела (Content-Length всё равно указывает размер ресурса); нужно для HTTP-проб, мониторинга и `<link rel="preload">`. В `Access-Control-Allow-Methods` добавлен `HEAD`.

Static `/operator` ответы также несут `ETag` и `Last-Modified`; совпадающий `If-None-Match` на `GET`/`HEAD` возвращает `304 Not Modified` без тела и с теми же security-заголовками (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Cache-Control). `If-Modified-Since` не поддерживается.
