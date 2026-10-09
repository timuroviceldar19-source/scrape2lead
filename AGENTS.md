# AGENTS.md

Инструкции для AI-агентов и разработчиков. Подробности для людей — в [README.md](README.md).

## Что это за проект

Scrape2Lead — робот, который собирает госзакупки Казахстана (портал `procurement.gov.kz`,
API `ows.goszakup.gov.kz`) и превращает их в сделки Bitrix24. Расписание задаёт Cloudflare Worker,
сборы выполняет GitHub Actions. Язык проекта — русский (README, комментарии, логи), код — TypeScript.

## Стек и команды

Node 20+ (в CI Node 22), TypeScript strict, ESM (`NodeNext`), Vitest, Playwright, better-sqlite3, zod.

```bash
npm ci                    # зависимости
npm test                  # vitest run (весь набор)
npx vitest run tests/automation/gzGithubWorkflow.test.ts   # один файл
npm run lint              # tsc --noEmit
npm run build             # tsc -> dist/
npm run cloudflare:check  # wrangler deploy --dry-run
```

- Скрипты — `scripts/*.mts`, запускаются через `tsx`; доменный код — `src/**` (`.ts`).
- Импорты внутри проекта пишутся с расширением `.js` (`../src/automation/config.js`).
- На каждый PR и push в `main` запускается `.github/workflows/ci.yml` (`lint` + `npm test`), merge при красном CI не делаем.
- Локально два теста могут падать без окружения: `kgdReport` (нужен `python` с reportlab) и `kgdCaptchaAutomation`
  (нужен Chromium для Playwright, `npx playwright install chromium`). В CI они ставятся автоматически.

## Структура

| Путь | Что там |
|---|---|
| `src/kz/` | сбор с портала и API Goszakup, парсеры, КГД-проверка контрагентов |
| `src/bitrix/` | клиент Bitrix24, импорт, маршрутизация сделок, исходы закупок |
| `src/automation/` | жизненный цикл запуска: prepare → dry-run → push → approve |
| `src/analysis/` | AI-анализ технических спецификаций |
| `scripts/` | CLI-обёртки (`automation.mts`, `check-gz-deal-outcomes.mts`, `bitrix-*.mts`) |
| `config/` | конфиги запусков (`automation.json` — main, `automation.pk.json` — PK), ключевые слова, маршрутизация |
| `infra/cloudflare-github-dispatch/` | Worker, который по cron вызывает `workflow_dispatch` |
| `.github/workflows/` | `gz-daily-main`, `gz-daily-pk`, `gz-automation` (общее тело), `gz-watchdog`, `gz-probe` |
| `certs/` | публичный промежуточный сертификат портала (см. ниже) |
| `docs/testing/*.tdd.md` | журналы TDD по каждой фиче: RED/GREEN, решения |

## Автоматизация и расписание

- Расписание живёт в **коде Worker** ([infra/cloudflare-github-dispatch/src/index.ts](infra/cloudflare-github-dispatch/src/index.ts)),
  а не в cron GitHub Actions: GHA cron опаздывает на часы, он остаётся только запасным путём (backstop).
- Список cron в `wrangler.jsonc` должен совпадать с `SCHEDULED_CRONS` в `index.ts` (это проверяет тест).
  Бесплатный тариф Cloudflare — **не больше 5 cron на аккаунт**; сейчас занято 3.
- Слоты (Алматы, UTC+5): 08:40 — PK и main одновременно, PK с `deal_outcomes=true`; затем каждый час в :30
  до 16:30 — PK и main без `deal-outcomes`; watchdog в 11:30 и 15:15. F3 в Actions и Worker отключён
  (код F3 оставлен).
- PK и main работают параллельно: у каждого своя concurrency-группа `gz-automation-<runs-dir>` и свой кэш плана
  (`gz-db-pk-`, `gz-db-main-`). Это безопасно, пока наборы планов не пересекаются.
- Guard пропускает повтор только для `event=schedule`; `workflow_dispatch` (Worker и ручной запуск) выполняется
  безусловно. Повторный сбор идемпотентен: дедупликация в Bitrix по `UF_CRM_PLAN_ID`.
- Worker выкладывает `.github/workflows/deploy-worker.yml` при слиянии в `main`, затронувшем
  `infra/cloudflare-github-dispatch/` (секрет репозитория `CLOUDFLARE_API_TOKEN`). Если секрета нет, job падает с пояснением.
  Запасной путь — руками: `npm run cloudflare:check`, затем `npm run cloudflare:deploy` (нужен `wrangler login`).
  Секрет `GITHUB_ACTIONS_TOKEN` лежит в Cloudflare и при деплое не трогается.
- Сетевые сбои портала сбор переживает сам: `scripts/run-automation-with-retry.sh` — до 3 попыток с паузой 10 минут,
  только при сетевых ошибках в логе новой попытки.

## Подводные камни (выяснено на практике)

- **TLS портала.** `procurement.gov.kz` отдаёт только листовой сертификат без промежуточного RapidSSL.
  Playwright это переживает, Node `fetch` падает с `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (в логе — просто `fetch failed`).
  Поэтому в workflow задан `NODE_EXTRA_CA_CERTS=certs/rapidssl-tls-rsa-ca-g1.crt`. Для локальных скриптов, которые
  ходят на портал через `fetch`, нужна та же переменная. Файлы `*.pem` в `.gitignore`, сертификат хранится как `.crt`.
- **Недоступность портала с IP GitHub.** Иногда `ERR_CONNECTION_TIMED_OUT` на сборе — это временный сбой,
  следующий часовой слот подхватывает работу. Не чинить кодом, пока это не повторяется регулярно.
- **Bitrix24.** Лимит ~2 запроса в секунду на вебхук; клиент ([src/bitrix/client.ts](src/bitrix/client.ts)) держит паузу 500 мс и
  повторяет при 429/5xx/`QUERY_LIMIT_EXCEEDED`. Пауза считается внутри процесса, параллельные прогоны её не делят.
- **`deal-outcomes`** ([scripts/check-gz-deal-outcomes.mts](scripts/check-gz-deal-outcomes.mts)) работает с `--execute` и пишет
  итоги в Bitrix; шаг `continue-on-error`, поэтому остаётся зелёным при массовых сбоях — смотрите строку `outcomes: ...`
  (`html_failed`, `errors`) в логе. За прогон HTML-проверка берёт не больше 200 сделок, остальные подтягиваются ротацией.
- **Сводка запуска.** Каждый прогон GZ пишет в Step Summary итог (создано/обновлено/уже были, этапы, время) из
  `runs/<id>/manifest.json` — смотрите её вместо раскопок в логе. Счётчики этапов `applyPlans`/`applyLots` берутся из строки
  `preflight: create=… update=…` скрипта загрузки, а не из отдельных строк `[created]`.
- **Кэш плана** `data/scrape2lead.db` — ускоритель, не источник правды. Каждый слот сохраняет кэш заново (18 раз в сутки).

## Правила работы

- **Секреты** (`.env`, `BITRIX24_WEBHOOK_URL`, `GOSZAKUP_TOKEN`, токены GitHub/Cloudflare) никогда не печатать в логи, коммиты
  и чат; `.env.example` — только имена. Токены в чат не просить.
- **Боевые действия только по явной просьбе:** любые `--execute`/`push` в Bitrix, `cloudflare:deploy`, ручной запуск
  workflow, merge PR. Dry-run и чтение — свободно.
- **Тесты.** Тест рядом по смыслу в `tests/<область>/`; для новой фичи — сначала красный тест. Расписание и workflow
  защищены тестами из `tests/cloudflare/` и `tests/automation/` — правя cron, слоты, concurrency или кэш, обновляйте их.
  Решения и RED/GREEN записывайте в `docs/testing/<фича>.tdd.md`.
- **Git.** Работа в ветках `feat/…` и `fix/…`, в `main` — через PR с merge-коммитом. Сообщения коммитов на английском,
  в формате `feat: …` / `fix: …`.
- **README** — источник описания расписания для людей; при смене слотов обновляйте таблицу Worker в README вместе с кодом.
