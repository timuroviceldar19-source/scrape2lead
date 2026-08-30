# TDD: карточка плана B2G — ОК / ЗЦП

## Пользовательская история

Менеджер видит в карточке сделки категории 9 те данные плана Goszakup, которые уже загружены интеграцией, не теряя существующие коммерческие разделы карточки.

## RED / GREEN

- RED: `npx vitest run tests/bitrix/gzPlanDealLayout.test.ts` завершился ошибкой отсутствующего модуля `src/bitrix/gzPlanDealLayout.ts`.
- GREEN: тот же тестовый файл прошёл `6/6` после реализации безопасного слияния раскладки.
- Coverage: `100%` statements/lines/functions и `92.3%` branches для `src/bitrix/gzPlanDealLayout.ts`.

## Гарантии

| Что гарантируется | Проверка | Результат |
|---|---|---|
| Существующие разделы категории 9 сохраняются | `gzPlanDealLayout.test.ts` | PASS |
| Добавляется отдельный раздел «Данные плана закупки» | `gzPlanDealLayout.test.ts` | PASS |
| Поля не дублируются и повторный запуск безопасен | `gzPlanDealLayout.test.ts` | PASS |
| Настройки отображения существующих полей клонируются без мутации ответа Bitrix | `gzPlanDealLayout.test.ts` | PASS |
| Перед записью создаётся JSON-резервная копия, после записи проверяется наличие всех полей | `bitrix-apply-gz-plan-layout.mts` dry-run/execute | PASS |
| В живой карточке отображаются названия и значения новых полей | Проверка в Bitrix24 через браузер | PASS |

## Применение

`npm run bitrix:apply-gz-plan-layout -- --execute` применён к категории `9`. Резервная копия сохранена в `runs/bitrix-layout-backups/`.

Полный `npm run lint` запускался, но остаётся красным из-за ранее существовавших несвязанных ошибок в незакоммиченных модулях `digestSample`, `goszakupAnalyticsEnricher` и `goszakupWinnersExporter`. Точечная TypeScript-проверка нового модуля и тестов проходит.
