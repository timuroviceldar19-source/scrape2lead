# Release Readiness Checklist

Короткий чеклист перед выкладкой новой версии `develop` → `main`. Покрывает
server (`npm run server`), operator UI (`/operator`) и `kz:autopilot`. Не
заменяет полный E2E — это быстрый gate «ничего не сломано в CI-командах».

## 1. Чистота дерева

```bash
git status --short --branch
```

Ожидание: ветка — `develop`, `??` (untracked) и ` M` (modified) либо пусты,
либо относятся к локальным артефактам в `data/`, `exports/`, `logs/` (всё в
`.gitignore`).

## 2. Линт

```bash
npm run lint
```

Ожидание: ноль ошибок TypeScript. `npm run lint` запускает
`tsc -p tsconfig.json --noEmit`.

## 3. Тесты

```bash
npm test
```

Ожидание: `vitest run` зелёный, пропуски допустимы только для
environment-gated suites (`tests/postgresLive.test.ts` и т.п., помечены
`skipped`). Сравни количество пропусков с предыдущим релизом — рост числа
skipped тестов — повод разобраться.

## 4. Production-сборка

```bash
npm run build
```

Ожидание: `tsc -p tsconfig.json` отрабатывает без ошибок и кладёт
`dist/cli.js`, `dist/src/server.js`, и т.д. Сервер запускается из собранного
артефакта командой `npm run server` (= `node dist/src/server.js`).

## 5. Опционально — sanity-check сервера

Только если в этом релизе менялся server.ts или env-binding:

```bash
npm run server:dev &
SERVER_PID=$!
curl -s http://127.0.0.1:8787/health
kill $SERVER_PID
```

Ожидание: HTTP `200`, `ok === true` и `service === "scrape2lead-api"`.
Поля `time` (ISO-8601) и `uptimeSeconds` (целое) присутствуют в ответе, но
являются динамическими — меняются от запроса к запросу и не должны
сравниваться в мониторинге/тестах как статика. Если задан
`SCRAPE2LEAD_API_TOKEN`, `/health` ожидаемо отдаёт `401` — это тоже OK.

## 6. Миграции БД (если в релизе есть schema PR)

Если в релиз попал PR с миграцией (`src/storage/migrations/`), перед merge в
`main` и перед деплоем:

1. Проверь, что в `README.md` changelog есть deploy note с номером миграции и
   именем таблицы/изменения (пример v1.8.0: migration v16 `outreach_seen`).
2. На staging/проде прогони миграцию до первого запуска затронутых команд
   (`kz:autopilot`, server, operator jobs).

## Что дальше

- Перед merge в `main` — PR из `develop` с пройденными шагами 1–4 (хотя бы
  локально; CI на репо пока нет, см. backlog).
- Перед первым запуском `kz:autopilot` на проде — `docs/kz-batch-runbook.md`
  §6 (Windows Task Scheduler + `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`).
- Перед изменением поведения `kz enrich` active-фильтра — `docs/TENDERS.md`
  раздел «Active filter» (это CLI/API flag, не env var).
