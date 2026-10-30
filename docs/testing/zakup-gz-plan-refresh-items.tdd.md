# Статус и товар пункта плана из zakup

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

## Измеренный просмотр

Статусы: 5000 открытых сделок с заполненным номером плана в прежних воронках; найдено 593, без изменений 245, предлагаются 332 правки (330 переходов, 2 синхронизации поля), не найдено 428, пропущено 16. Ошибок 3974: значительная часть обусловлена отсутствием проверяемого БИН/года (3975 входных сделок без контекста; ошибки считаются по уникальным пунктам). Проверка не ослаблена. Это полный ответ фильтра текущей команды, не ограничение выборки числом 5000. Сводка: `final-status-summary.txt`, команда агрегирования в частном отчёте.

Товар: 1029 сделок, предлагаются 7 правок, уже верно 529, нет в реестре 421, ошибка поиска у 70 сделок, пропущено 2. В списке `failed` 122 корня-кандидата, это не число сделок (`plan-items-verified.json`). Из 7 предложений текущий портал подтвердил 6; одно не подтвердил (`item-changes-portal.txt`).

Публичный пример конфликта: корень `88331334`, zakup возвращает версию `88351772` с кодом `279020.100.000003`, портал — более новую `88368717` с `262030.100.000021`. Последняя отсутствует в zakup даже по точному `external_id` (`registry-gaps.txt`). Предложение изменения по старой версии не подтверждено. Даты актов у остальных правок не доказывают, что товар изменили после 29.10.

Статусы: 3587 запросов, 215,757 с. Товар: 4355 запросов, 225,478 с. HTTP-кэш отключён, используется штатный кэш организаций (`*-metrics.json`). Ошибки идентичности приводят к ненулевому коду выхода статусов; эти результаты нельзя называть успешным обновлением всех сделок.

Готовность к боевой записи требует отдельной сверки: публичный zakup и HTML-реестр могут показывать разные статусы одной версии. Это расхождение данных источников, а не только вопрос перевода названий.
