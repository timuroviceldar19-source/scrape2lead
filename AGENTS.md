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
| `src/assistant/` | чат-бот-помощник в Bitrix24 (только чтение): запуск `npm run assistant`, см. `docs/testing/bitrix-assistant-bot.tdd.md` |
| `scripts/` | CLI-обёртки (`automation.mts`, `check-gz-deal-outcomes.mts`, `bitrix-*.mts`) |
| `config/` | конфиги запусков (`automation.json` — main, `automation.pk.json` — PK), ключевые слова, маршрутизация |
| `infra/cloudflare-github-dispatch/` | Worker, который по cron вызывает `workflow_dispatch` |
| `functions/_middleware.ts` | проверка входа на пульт (Cloudflare Pages Functions); логика — `src/bitrix/salesPult/gate/` |
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
- При сетевых сбоях automation сохраняет частичные страницы/периоды и обрабатывает планы/лоты независимо.
  Пропуски видны в manifest/Step Summary. Если не сработала ни одна ветка, `scripts/run-automation-with-retry.sh`
  делает до 3 попыток с паузой 10 минут. `partialCollection` включён только в automation: мониторы оставляют строгий режим.
- В GitHub сбор идёт цепочкой до трёх машин (`gz-automation.yml` → `gz-automation-machine.yml`): машины 1 и 2 при
  недоступном портале сразу передают сбор следующей (код 76 обёртки, job остаётся зелёным), машина 3 работает по схеме
  выше. Запуск зелёный, только если job `collection-result` увидел выполненный сбор; на это опираются guard и watchdog.

## Роли на пульте (f3-pult.pages.dev)

- Сайт закрыт Cloudflare Access; после него каждый запрос проходит `functions/_middleware.ts`. Он проверяет
  токен Access (`Cf-Access-Jwt-Assertion` или кука `CF_Authorization`, RS256 по ключам команды), берёт почту,
  находит роль и отдаёт страницу варианта `_r/<вариант>/index.html` или `reg.html`. Напрямую `_r/…` закрыт (404).
- Список «почта → роль» — секрет репозитория `PULT_ROLES`, **не репозиторий** (он публичный). Формат:
  `{"team": "<команда Access>", "aud": "<AUD-тег приложения>", "users": {"почта": "all" | "tv" | "manager:<ID Битрикса>"}}`.
  Шаг выкладки собирает из него `exports/pult-gate/config.json` (`scripts/pult-gate-config.mts`, почты в лог не пишет);
  ошибка в секрете роняет выкладку.
- Без секрета проверка выключена: все, кого пускает Access, видят полный пульт (вариант `all`), как раньше.
- С секретом: почты нет в списке — «Нет доступа» с кнопкой выхода; варианта роли нет в выкладке — «ещё не готов»
  (полный пульт вместо него не отдаётся); страницы нет в варианте (у `tv` нет «Выручки») — «эта страница вам недоступна».
- Варианты собираются в шаге выкладки `sales-pult.yml`; сейчас только `all`. Ответы с `cache-control: private, no-store`.
- Проверить локально: `PULT_ROLES= npx tsx scripts/pult-gate-config.mts exports/pult-gate/config.json`, разложить страницы
  в `exports/sales-pult-deploy/_r/all/`, затем `npx wrangler pages dev exports/sales-pult-deploy --port 8788`.

## Подводные камни (выяснено на практике)

- **TLS портала.** `procurement.gov.kz` отдаёт только листовой сертификат без промежуточного RapidSSL.
  Playwright это переживает, Node `fetch` падает с `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (в логе — просто `fetch failed`).
  Поэтому в workflow задан `NODE_EXTRA_CA_CERTS=certs/rapidssl-tls-rsa-ca-g1.crt`. Для локальных скриптов, которые
  ходят на портал через `fetch`, нужна та же переменная. Файлы `*.pem` в `.gitignore`, сертификат хранится как `.crt`.
- **Недоступность портала с IP GitHub.** Повторяющиеся `ERR_CONNECTION_TIMED_OUT` обрабатываются частичным сбором;
  после 3 последовательных отказов первой страницы оставшиеся запросы периода пропускаются (порог
  `maxConsecutiveNetworkFailures`). Полный отказ источника не считается штатным `rows=0`.
- **Bitrix24.** Лимит ~2 запроса в секунду на вебхук; клиент ([src/bitrix/client.ts](src/bitrix/client.ts)) держит паузу 500 мс и
  повторяет при 429/5xx/`QUERY_LIMIT_EXCEEDED`. Пауза считается внутри процесса, параллельные прогоны её не делят.
- **`deal-outcomes`** ([scripts/check-gz-deal-outcomes.mts](scripts/check-gz-deal-outcomes.mts)) работает с `--execute` и пишет
  итоги в Bitrix; шаг `continue-on-error`, поэтому остаётся зелёным при массовых сбоях — смотрите строку `outcomes: ...`
  (`html_failed`, `errors`) в логе. За прогон HTML-проверка берёт до 500 сделок и работает не дольше 20 минут (`--html-limit`, `--html-budget-min`); сколько проверено из скольких, видно в Summary и в строке `html_status_checked=… html_status_pending=…`, а при ≥20% сбоев портала появляется предупреждение `::warning::`.
  Чей договор считается чьим, задаёт `config/gz-deal-outcomes.json`. `ourBins` — это F3. В `partnerBins` — компании группы F3 (Amanat Asia, «Торговая сеть Казахстана»): если договор подписала такая компания, в сделке пишется «выиграл наш партнёр», а не проигрыш. Сверка «Есть на портале, нет в реестре» на странице реестра ОП берёт `partnerBins` (обе компании). Если какой-то партнёр через реестр не продаёт, задайте для сверки отдельный список `registerPartnerBins`, он заменит `partnerBins`.
- **Сводка запуска.** Каждый прогон GZ пишет в Step Summary итог (создано/обновлено/уже были, этапы, время) из
  `runs/<id>/manifest.json` — смотрите её вместо раскопок в логе. Счётчики этапов `applyPlans`/`applyLots` берутся из строки
  `preflight: create=… update=…` скрипта загрузки, а не из отдельных строк `[created]`.
- **Помощник в чате Bitrix24** (`src/assistant/`). Настройки и секреты — в `.env` (`ANTHROPIC_API_KEY`, `ASSISTANT_MODEL`,
  `BITRIX_CRM_WEBHOOK_URL`, `BITRIX_BOT_WEBHOOK_URL`, `BITRIX_BOT_TOKEN`, `BITRIX_BOT_ID`, `GOSZAKUP_TOKEN`,
  `ASSISTANT_ALLOWED_USER_IDS`, дневные лимиты). Два отдельных входящих вебхука: `imbot` (бот) и `crm` (чтение). У вебхука нет
  режима «только чтение», поэтому запись исключена кодом: `CrmReader` пускает лишь методы из белого списка (`crm.deal.get/list/fields`, `crm.company.get/list`, `crm.contact.list`, `crm.activity.list`, `crm.status.list`). Инструменты бота — `src/assistant/tools.ts`; поиск в интернете подключён серверным инструментом Anthropic `web_search` (до 3 поисков на вопрос, $10 за 1000; если в аккаунте он выключен, бот работает без него); данные портала — `GoszakupApi` (контакты и телефоны из договоров, цены, история и поставщики заказчика, статус плана). Проверка без бота:
  `npm run assistant -- --ask "оцени сделку N"`; регистрация бота и любые ответы в чат — только по явной просьбе.
- **Смена товара в пункте плана.** Заказчик может заменить в пункте код ЕНС ТРУ и название, оставив сумму и количество: номер пункта на портале прежний (`rootrecordId`), запись в реестре новая. `gzPlanRevision.ts` замечает только сумму и количество, поэтому товар в сделке оставался старым. `scripts/bitrix-sync-gz-plan-items.mts` (шаг в job `deal-outcomes` файла `gz-daily-pk.yml`, утренний слот) сверяет открытые сделки `gz-plan:` с действующей версией пункта (`src/kz/goszakupPlanItems.ts`; номер пункта берётся из «ID Плана», названия `[GZ <номер>]` и `ORIGIN_ID`: у старых сделок в `ORIGIN_ID` внутренний номер записи на портале, а не номер пункта) и правит поля «Код ЕНСТРУ», «Название ЕНСТРУ», «Код ТРУ», «Наименование»; название сделки и строку `Item:` в комментарии меняет, только если их не правили руками; пишет комментарий «План изменён заказчиком». Запись реестра принимается, только если совпал БИН заказчика и версия не старше сделки (иначе номер мог совпасть с чужой старой записью). Просмотр по умолчанию, запись с `--execute`, пробно `--limit 5`. См. `docs/testing/gz-plan-item-change.tdd.md`.
- **Сроки в сделках по лотам.** Выгрузка лотов с портала не содержит дат, поэтому раньше Bitrix сам ставил `BEGINDATE` = день создания, `CLOSEDATE` = +7 дней, и это выглядело как срок закупки. Теперь `bitrix-push-gz-lots.mts` берёт срок приёма заявок из реестра по номеру лота (`src/kz/goszakupLotWindow.ts`). Уже созданные сделки правит `scripts/bitrix-backfill-gz-lot-dates.mts` (просмотр по умолчанию, запись только с `--execute`, пробно `--limit 5`; даты, поправленные менеджером, не трогает). Число до дефиса в номере лота — старый пункт плана, ключом оно не служит. См. `docs/testing/gz-lot-bid-dates.tdd.md`.
- **Рынок для пульта** (`src/kz/market/`) берётся из открытого API `zakup.gov.kz/api/core/api/public/` без токена ([src/kz/zakupPublicApi.ts](src/kz/zakupPublicApi.ts)); ows с `GOSZAKUP_TOKEN` — запасной, только если zakup не ответил. Это адреса фронтенда сайта, без документации и лимитов: пауза 100 мс, 4 запроса одновременно, повтор при сбоях. БИН организаций кэшируется в `data/market/orgs.json`. В логе видно, какой источник сработал: `[Рынок] Утреннее обновление (zakup|ows)`. См. `docs/testing/market-zakup-public-api.tdd.md`.
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
