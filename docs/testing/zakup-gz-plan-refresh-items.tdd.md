# Статус и товар пункта плана из zakup

## Правки перед слиянием, 30.10.2026

- Каждая предлагаемая правка статуса сверяется с самой новой версией реестра портала: версия и статус должны совпасть с zakup. Конфликт или недоступность портала оставляют поля CRM прежними; отдельные счётчики `portal_verification`, причины `skippedReasons` и разбивка `skippedByReason` попадают в отчёт.
- Сделки без проверяемого БИН и года пропускаются как `no_bin`, с разбивкой по воронкам. Они не считаются ошибкой или отсутствием в API. Проверка контекста относится к каждой сделке: соседняя сделка с тем же номером плана не даёт ей права на обновление.
- Каждая правка товара требует совпадения версии портала и zakup, затем точного совпадения кода из карточки портала (`ref_enstru_code`). Более новая версия портала даёт сообщение «zakup отстаёт от портала». В частном отчёте есть исходные кандидаты, разрешённые правки и заблокированные предложения.
- CLI статуса и товара принимают `--max-full-scans`, по умолчанию общий адаптер допускает 2 полных обхода за прогон. Исчерпание предела учитывается отдельно.
- RED: `npm test -- tests/bitrix/gzPlanStatusRefresh.test.ts tests/bitrix/gzPlanItemPortal.test.ts` — 4 бизнес-проверки упали, модуль проверки товара отсутствовал (`tmp/zakup-review-20261030/status-items-red.txt`). Отдельный RED отсутствующего контекста: `no-bin-red.txt`, защиты контекста конкретной сделки: `per-deal-context-red.txt`.
- GREEN: `npm test -- tests/bitrix/gzPlanStatusRefresh.test.ts tests/bitrix/gzPlanItemPortal.test.ts tests/bitrix/gzPlanItemChange.test.ts tests/kz/goszakupPlanStatusApi.test.ts` (`status-items-green.txt`), `npm run lint` (`status-items-lint.txt`). Совместный набор итогов, лотов, статуса и товара: 1536 пройдено, 9 пропущено; lint и build успешны (`tmp/zakup-review-20261030/final-tests.txt`, `final-checks.json`).
- Покрытие проверки статуса, товара и общего чтения портала: 96,88% строк, 87,90% ветвей (`status-final-coverage.txt`). Данные CRM в Git не включаются.

Финальный dry-run статуса: 4999 сделок, 548 статусов найдены, 291 правка подтверждена порталом, 31 заблокирована как `source_conflict`, недоступность портала — 0, настоящих ошибок чтения — 3. `no_bin`: 4020 пропусков (воронка 9 — 42, 41 — 6, 29 — 3972). Источник — `tmp/zakup-review-20261030/status-final.json`, команда `node --import tsx --import ./tmp/zakup-review-20261030/readonly.mjs scripts/bitrix-refresh-gz-plan-status.mts`, с пустым токеном ows и блокировкой записи. Время 1082,379 с; запросов 3927 (zakup 3562, портал 328, CRM 37), failed 3, blocked 0 (`status-final-metrics.json`). Код Node 1 соответствует трём настоящим ошибкам, а не пропускам `no_bin`.

Старый вводный счётчик контекста по наличию номера в общей Map показывал 3975 вместо 4020: у сделок без собственного контекста встречаются номера из других сделок. На итоговые решения финального прогона эта строка не влияла — там уже работал фильтр каждой сделки. Вводный лог приведён к тому же подсчёту; защита подтверждена отдельным тестом (`per-deal-context-red.txt`, `status-items-green.txt`).

Dry-run товара: 1028 сделок, из прежних 7 кандидатов разрешены те же 6, один остановлен по более новой версии портала. При совпавшей версии код проверен в карточке. Время 263,642 с; запросов 4380 (zakup 4346, портал 13, CRM 21), failed 3, blocked 0 (`items.json`, `items-metrics.json`). Команда: `node --import tsx --import ./tmp/zakup-review-20261030/readonly.mjs scripts/bitrix-sync-gz-plan-items.mts --report tmp/zakup-review-20261030/items.json`.

Сопоставление всех прежних кандидатов записано в `tmp/zakup-review-20261030/summary.json`, команда `node tmp/zakup-review-20261030/summarize.mjs`; исходная локальная выборка — `F:/Temp/zakup-migration-evidence/plan-items-verified.json`. Частные сведения CRM в коммиты не включены.

Общий `GzPlanLookup`: поиск q с проверкой БИН и года, затем точная связь корня через позиции договоров заказчика, ограниченных полным прежним/текущим кодом ЕНС ТРУ; дополнительный путь через лоты и объявление. Полный обход только без кода. Договоры и карточки повторно не читаются в пределах процесса. HTML в этот адаптер не добавлен.

## Гарантии

- Токен ows необязателен в обеих CLI-командах.
- Ошибка отдельного пункта не теряет успешные статусы других пунктов пачки и учитывается как ошибка, а не «не найдено».
- Смена товара по-прежнему требует совпадения БИН и возраста версии; ручные изменения названия/комментария защищены прежней доменной логикой.
- `timestamp` не считается датой создания версии. Без даты акта пункт попадает в `failed`, правки не готовятся. Более ранний акт консервативно отсекает потенциальную правку.
- Синхронизация товара поддерживает `--report <локальный путь>`; отчёт содержит данные CRM и предназначен только для локального хранения.
- Контекст статуса включает БИН, год создания, полный код и версии пункта. Если БИН сделки отсутствует, читается существующее поле БИН связанной компании; неподтверждённая идентичность не подменяется данными найденного пункта.
- Исправлен выявленный при реальном чтении цикл пагинации Bitrix: если последняя страница полная, `result_total` завершает обход. Смещение за конец списка иногда возвращало первую страницу заново. Регрессионный тест воспроизводит это поведение.

## Свидетельства

Каталог вне Git: `F:\Temp\zakup-migration-evidence`.

| Проверка | Команда | Вывод |
|---|---|---|
| RED: закуп без токена | `npx vitest run tests/kz/goszakupPlanStatusApi.test.ts tests/kz/goszakupPlanItems.test.ts` | `refresh-items-red.txt` |
| GREEN: адаптеры и прежние доменные правила | `npx vitest run tests/kz/goszakupPlanStatusApi.test.ts tests/kz/goszakupPlanItems.test.ts tests/bitrix/gzPlanStatusRefresh.test.ts tests/bitrix/gzPlanItemChange.test.ts` | `refresh-items-green.txt` |
| RED: частичный сбой API | `npx vitest run tests/kz/goszakupPlanStatusApi.test.ts` | `status-partial-red.txt` |
| RED: учёт частичного сбоя в отчёте | `npx vitest run tests/bitrix/gzPlanStatusRefresh.test.ts` | `status-partial-domain-red.txt` |
| GREEN: частичный сбой | `npx vitest run tests/kz/goszakupPlanStatusApi.test.ts tests/bitrix/gzPlanStatusRefresh.test.ts` | `status-partial-green.txt` |
| RED/GREEN: полная последняя страница Bitrix | `npx vitest run tests/bitrix/reportingClient.test.ts` | `pagination-red.txt`, `pagination-green.txt` |
| RED/GREEN: контекст компании | `npx vitest run tests/bitrix/gzPlanStatusRefresh.test.ts` | `status-company-context-red.txt`, `status-company-context-green.txt` |
| Статусы, без записи | `node --import ./tmp/zakup-readonly-fresh.mjs --import tsx scripts/bitrix-refresh-gz-plan-status.mts` | `plan-status-final.txt`, `plan-status-final-metrics.json`; копия JSON: `plan-status-final.json` |
| Товар, без записи | `node --import ./tmp/zakup-readonly-fresh.mjs --import tsx scripts/bitrix-sync-gz-plan-items.mts --report F:/Temp/zakup-migration-evidence/plan-items-verified.json` | `plan-items-verified.txt`, `plan-items-verified-metrics.json` |
| Каждая правка товара против текущего портала | `node --import ./tmp/zakup-readonly-fresh.mjs --import tsx tmp/verify-item-changes.mts` | `item-changes-portal.txt` |
| Повторная проверка пропуска версии в zakup | `node --import ./tmp/zakup-readonly-fresh.mjs --import tsx tmp/verify-registry-gaps.mts` | `registry-gaps.txt` |
| Все предлагаемые статусы против портала | `node --import ./tmp/zakup-readonly-fresh.mjs --import tsx tmp/verify-status-changes.mts` | `status-changes-portal.txt` |
| Повторное текущее чтение zakup для отличий | `node --import ./tmp/zakup-readonly-fresh.mjs --import tsx tmp/recheck-status-conflicts.mts` | `status-conflicts-rechecked.txt` |

## Измеренный просмотр

Статусы: 5000 открытых сделок с заполненным номером плана в прежних воронках; найдено 593, без изменений 245, предлагаются 332 правки (330 переходов, 2 синхронизации поля), не найдено 428, пропущено 16. Ошибок 3974: значительная часть обусловлена отсутствием проверяемого БИН/года (3975 входных сделок без контекста; ошибки считаются по уникальным пунктам). Проверка не ослаблена. Это полный ответ фильтра текущей команды, не ограничение выборки числом 5000. Сводка: `final-status-summary.txt`, команда агрегирования в частном отчёте.

Товар: 1029 сделок, предлагаются 7 правок, уже верно 529, нет в реестре 421, ошибка поиска у 70 сделок, пропущено 2. В списке `failed` 122 корня-кандидата, это не число сделок (`plan-items-verified.json`). Из 7 предложений текущий портал подтвердил 6; одно не подтвердил (`item-changes-portal.txt`).

Публичный пример конфликта: корень `88331334`, zakup возвращает версию `88351772` с кодом `279020.100.000003`, портал — более новую `88368717` с `262030.100.000021`. Последняя отсутствует в zakup даже по точному `external_id` (`registry-gaps.txt`). Предложение изменения по старой версии не подтверждено. Даты актов у остальных правок не доказывают, что товар изменили после 29.10.

Статусы: 3587 запросов, 215,757 с. Товар: 4355 запросов, 225,478 с. HTTP-кэш отключён, используется штатный кэш организаций (`*-metrics.json`). Ошибки идентичности приводят к ненулевому коду выхода статусов; эти результаты нельзя называть успешным обновлением всех сделок.

Проверены все 332 предложения статуса: 300 совпали с текущим порталом, 30 расходятся, для 2 портал не вернул точную строку. Это 319 уникальных корней, 319 HTML-запросов за 674,542 с с паузой 1,5 с, без сетевых ошибок (`status-changes-portal.txt`). Пределы 500 пунктов / 20 минут соблюдены. Поскольку dry-run и сверку разделяло несколько часов, все 32 неподтверждённых предложения дополнительно прочитаны из zakup: 30 конфликтов сохранились (`status-conflicts-rechecked.txt`). Это подтверждённое расхождение текущих данных, а не вывод из разновременных снимков. Перевод статусов не объясняет разные значения одной версии; время реального события относительно 29.10 не установлено. Частная таблица содержит каждое предложение и результат проверки.

Готовность к боевой записи требует отдельной сверки: публичный zakup и HTML-реестр могут показывать разные статусы одной версии. Это расхождение данных источников, а не только вопрос перевода названий.

## Обработка отсутствующей записи zakup

RED: `npx vitest run tests/kz/goszakupPlanStatusApi.test.ts` — 1 ошибка из 20: 404 конкретной записи не считался пропуском. GREEN: та же команда — 20 тестов пройдены; 503 остаётся ошибкой. `npm run lint` — успешно. Проверка полного сценария и dry-run ещё не выполнена.

## Дополнительные проверки товара, 404 и Summary

- RED: `npx vitest run tests/kz/goszakupPlanItems.test.ts` — 1 ошибка из 7: отсутствовали `skipped` и причина сбоя. GREEN: 7 тестов прошли.
- RED: `npx vitest run tests/kz/zakupGzRegistry.test.ts` — 1 ошибка из 21: неполный индекс публиковался до завершения загрузки договоров. GREEN: 21 тест прошёл.
- RED: `npx vitest run tests/kz/zakupGzPlans.test.ts` — 1 ошибка из 21: найденный лот скрывал 404 договора. GREEN: 21 тест прошёл.
- RED: `npx vitest run tests/bitrix/gzPlanStatusRefresh.test.ts` — 1 ошибка из 49: БИН из комментария уступал БИН компании. GREEN: 49 тестов прошли; дополнительные тесты проверяют пропуск по воронке и ошибку источника.
- RED: `npx vitest run tests/bitrix/gzOutcomeSummary.test.ts` — отсутствовала функция вывода Summary. GREEN: 1 тест прошёл.
- `npx vitest run tests/bitrix/gzDealBin.test.ts` — 1 тест прошёл: БИН компании позволяет проверить товар, при отсутствии БИН возвращается пропуск.

Проверки ветки товара и статуса: `runs/zakup-verification-20261030/status-final-checks.log` — lint и build exit 0; полный набор при параллельном запуске упёрся в тайм-аут закрытия Chromium. Последовательный повтор `runs/zakup-verification-20261030/status-retest.log` — 1540 passed, 9 skipped, exit 0. Ветка лотов: `runs/zakup-verification-20261030/lot-checks.log` — lint, build и тесты exit 0, 1517 passed, 9 skipped. Объединённое состояние: `runs/zakup-verification-20261030/combined-retest.log` — lint, build и тесты exit 0, 1563 passed, 9 skipped.

Dry-run товара: `tmp/zakup-review-20261030/items-final-followup.log`, отчёт `items-final-followup.json`, метрики `items-final-followup-metrics.json`: 1029 сделок, БИН компании получен для 0, без БИН 50 сделок, ошибок поиска 19 пунктов (16 без даты, 3 HTTP 404); подтверждены 6 прежних предложений, 1 отклонено конфликтом, новых предложений нет. 4388 запросов, 3 failed, 0 blocked, 267,515 с, exit 0. Прежний и новый отчёты сравнили по спискам правок.

Финальный dry-run статуса: `tmp/zakup-review-20261030/status-final-followup.log`, отчёт `status-final-followup.json`, метрики `status-final-followup-metrics.json`. 5000 сделок, 546 найдено в API, 300 подтверждено порталом, 31 `source_conflict`, 0 `portal_unavailable`; `no_bin` по воронкам: 9 — 42, 29 — 3972, 41 — 6; `zakup_not_found`: 29 — 2, 41 — 1; ошибок прогона 0, код Node 0. Запросов 3935, failed 3, blocked 0, 929,892 с. PowerShell завершил оболочку с кодом 1 из-за перенаправленного stderr; метрики дочернего Node фиксируют его собственный код 0.
