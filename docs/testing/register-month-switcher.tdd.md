# Переключение месяцев Реестра ОП

Источник: задача пользователя из вложения; сценарии выведены из её требований.
Ветка: feat/register-month-switcher от свежего origin/main.

## RED
Команда: npx vitest run tests/bitrix/salesPultRegisterMonthSwitcher.test.ts
Результат: 2 failed — отсутствует monthViews (получено []), нет кнопок (0 вместо 3).
Дополнительный RED: часовой антиспам после успешной попытки — 1 failed.

## GREEN и рефакторинг
Полные срезы строятся после межмесячной сверки CRM без вложенной истории.
Последний файл обновляет срез своего месяца; hasValColumn сохраняется.
Старый кэш требует обновления с часовым ограничением попыток.
Кнопки и hash переключают отчёт, шапку и подвал; общая история остаётся.
Fallback старого кэша использует итоги, менеджеров, накопительные продажи
и missingCrm; подробные строки недоступны и обозначены в блоке 05.
Рефакторинг: кэш расшифровывается один раз; click/hashchange не вызывают
повторную перерисовку того же месяца.

## Гарантии тестов
| Гарантия | Проверка | Результат |
|---|---|---|
| Сентябрь, октябрь, ноябрь имеют собственные file/asOf/total/managers/mix/channels/rows/missing | Новый Vitest-тест с Excel-файлами | PASS |
| Кнопки/hash обновляют шапку, блоки 01, 02, 05 и подвал, сохраняют историю и активный месяц | Chromium через Vitest | PASS |
| Невалидный hash constructor безопасен; старый кэш работает | Chromium через Vitest | PASS |
| Февраль 28/29 дней, сентябрь 30, октябрь 31: конечная точка графика на границе месяца | Chromium через Vitest | PASS |
| Старая схема обновляется с часовым антиспамом; текущий срез актуален без рекурсии | Временный зашифрованный кэш и локальный Excel | PASS |

Команда: npx vitest run salesPultRegister --coverage --coverage.include='src/bitrix/salesPult/register/**' --coverage.reporter=text
Результат: 6 файлов, 69 тестов PASS; строки 83,81%, ветви 77,29%, функции 93,05%.
Клиентский JS проверен Chromium, его покрытие не входит в серверный V8-отчёт.
Первый запуск coverage с glob в фильтре не нашёл файлов; повтор с фильтром salesPultRegister успешен.

## Итоговые проверки
npm run lint — PASS (tsc --noEmit).
npm run build — PASS (tsc).
npm test — PASS: Test Files 155 passed | 3 skipped (158); Tests 1766 passed | 9 skipped (1775), 67,09 с.
Пропуски: runAutomationRetry (5), runAutomationShell (3), reportingDashboard.e2e (1).
git diff --check — PASS.
npm audit --audit-level=high — exit 1: 26 существующих уязвимостей
(1 low, 12 moderate, 11 high, 2 critical); зависимости не менялись.

RED сохранён коммитом c1c5a49; GREEN — acc375d; уточнения и рефакторинг
проверены итоговым полным прогоном. Боевые действия, push и деплой не выполнялись.
