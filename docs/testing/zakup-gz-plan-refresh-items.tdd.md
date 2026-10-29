# Статус и товар пункта плана из zakup

Общий `GzPlanLookup`: поиск q с проверкой БИН и года, затем точная связь корня через позиции договоров заказчика. Договоры и карточки повторно не читаются в пределах процесса. HTML в этот адаптер не добавлен.

## Гарантии

- Токен ows необязателен в обеих CLI-командах.
- Ошибка отдельного пункта не теряет успешные статусы других пунктов пачки и учитывается как ошибка, а не «не найдено».
- Смена товара по-прежнему требует совпадения БИН и возраста версии; ручные изменения названия/комментария защищены прежней доменной логикой.
- `timestamp` не считается датой создания версии. Без даты акта пункт попадает в `failed`, правки не готовятся. Более ранний акт консервативно отсекает потенциальную правку.
- Синхронизация товара поддерживает `--report <локальный путь>`; отчёт содержит данные CRM и предназначен только для локального хранения.

## Свидетельства

Каталог вне Git: `F:\Temp\zakup-migration-evidence`.

| Проверка | Команда | Вывод |
|---|---|---|
| RED: закуп без токена | `npx vitest run tests/kz/goszakupPlanStatusApi.test.ts tests/kz/goszakupPlanItems.test.ts` | `refresh-items-red.txt` |
| GREEN: адаптеры и прежние доменные правила | `npx vitest run tests/kz/goszakupPlanStatusApi.test.ts tests/kz/goszakupPlanItems.test.ts tests/bitrix/gzPlanStatusRefresh.test.ts tests/bitrix/gzPlanItemChange.test.ts` | `refresh-items-green.txt` |
| RED: частичный сбой API | `npx vitest run tests/kz/goszakupPlanStatusApi.test.ts` | `status-partial-red.txt` |
| RED: учёт частичного сбоя в отчёте | `npx vitest run tests/bitrix/gzPlanStatusRefresh.test.ts` | `status-partial-domain-red.txt` |
| GREEN: частичный сбой | `npx vitest run tests/kz/goszakupPlanStatusApi.test.ts tests/bitrix/gzPlanStatusRefresh.test.ts` | `status-partial-green.txt` |

Готовность к боевой записи требует отдельной сверки: публичный zakup и HTML-реестр могут показывать разные статусы одной версии. Это расхождение данных источников, а не только вопрос перевода названий.
