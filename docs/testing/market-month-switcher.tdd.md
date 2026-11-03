# Переключатель месяцев рынка ИП и КТ

Источник: задача пользователя из вложения; сценарии выведены из требований.
Ветка feat/market-month-switcher создана от свежего origin/main.

## RED
Команда: npx vitest run tests/bitrix/salesPultMarketMonthSwitcher.test.ts
Результат: 6 tests failed — monthViews отсутствует, кнопок 0 вместо 6,
прямые ссылки открывают октябрь вместо января/сентября.
Браузерные проверки реально выполнены в Chromium.
Контрольная точка RED: 95b9579.

## GREEN
В aggregate.ts выделен чистый расчёт одного месяца, построены срезы всех
доступных месяцев и месяца по умолчанию. Верхний уровень сохраняет прежнее
правило выбора месяца и общую диаграмму; срезы не содержат months/monthViews.
Кнопки, столбики, подписи и hash переключают полный отчёт обеих групп.
Добавлены проверка формата/собственных ключей, сводка старого кэша и её пояснение.
Команда: npx vitest run tests/bitrix/salesPultMarketMonthSwitcher.test.ts tests/kz/marketAggregate.test.ts
Первый GREEN: 2 файла, 15 тестов PASS. Контрольная точка: 1ebeb86.

## REFACTOR
Месяц по умолчанию назван defaultMonth, состояние выбранного месяца отдельно
для ИП и КТ. Повторный выбор не пересоздаёт отчёт. Обновление aria-pressed
сохраняет фокус кнопки, старые элементы снимаются с IntersectionObserver.
Выделение активной подписи учитывает стили вложенных span.
Дополнительные проверки: пустые данные, лимиты списков, клавиатура, ширина 390 px.
После уточнения типов в тестах npm run lint и npm run build проходят.

## Таблица гарантий
| Гарантия | Проверка | Результат |
|---|---|---|
| Независимые total/us/prev/suppliers/contractList/methods/kinds/lost/customers, YTD в пределах выбранного года и месяца, без рекурсии | Новый Vitest-тест срезов ИП/КТ | PASS |
| Правило выбора предыдущего месяца в начале месяца сохранено; пустой defaultMonth доступен | Новые и существующие тесты агрегации | PASS |
| Срезы сохраняют топ-12 поставщиков, топ-10 заказчиков/упущенных договоров, до 20 договоров в списке | Новый тест лимитов | PASS |
| Кнопка, столбик, подпись и hash обновляют блоки 01–05 и YTD обеих групп | Chromium через Vitest | PASS |
| Диаграмма месяцев сохраняется; aria-pressed/aria-current соответствуют выбору | Chromium через Vitest | PASS |
| Повторный выбор сохраняет DOM; Enter/Space работают; фокус кнопки сохранён | Chromium через Vitest | PASS |
| Прямые ссылки и невалидные/неизвестные ключи безопасны; унаследованный ключ не считается срезом | Chromium через Vitest | PASS |
| Старый кэш показывает сводку с пояснением, без чужих подробностей и YTD | Chromium через Vitest | PASS |
| На Пульте и в ТВ кнопки скрыты; месяц Пульта не берётся из hash рынка | Новые и существующие браузерные тесты | PASS |
| Кнопки содержат год при нескольких годах; переключатель помещается в 390 px | Chromium через Vitest | PASS |

## Покрытие
npx vitest run tests/bitrix/salesPultMarketMonthSwitcher.test.ts tests/kz/marketAggregate.test.ts --coverage --coverage.include='src/kz/market/aggregate.ts' --coverage.reporter=text
2 файла, 17 тестов PASS. aggregate.ts: строки/операторы 97,85%, ветви 80,36%, функции 100%.
Клиентский JS проверяется в Chromium и не входит в серверный V8-отчёт.

## Итоговые проверки
npm run lint — PASS (tsc --noEmit).
npm run build — PASS (tsc).
После уточнения типов тестов целевой файл повторно проверен: 8 tests passed.
npm test — PASS: 156 passed | 3 skipped (159 файлов);
1774 passed | 9 skipped (1783 теста), 68,26 с.
Пропуски: runAutomationRetry (5), runAutomationShell (3), reportingDashboard.e2e (1).
git diff --check — PASS.
npm audit --audit-level=high — exit 1: 26 существующих уязвимостей
(1 low, 12 moderate, 11 high, 2 critical). Зависимости не менялись.
Push, деплой, запись в Bitrix и ручной запуск workflow не выполнялись.
