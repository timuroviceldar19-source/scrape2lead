# Устойчивый частичный сбор ГЗ — TDD

Исходный план: промпт пользователя от 03.11.2026, вариант 1 — сохранять пригодные данные,
явно показывать пропуски и изолировать временные сетевые отказы веток планов и лотов.
База: `4bde0de6f3975374f4f375aceda86c3bfb4c2735`. Ветка: `feat/gz-partial-collection`.

## Сценарии и решения

- Как оператор, хочу получить успешные страницы, даже если следующая страница или год недоступны.
- Как оператор, хочу различать пустую выдачу, частичный сбор и полный отказ источника.
- Как оператор, хочу отправить пригодные планы, когда лоты недоступны, и наоборот.
- Как оператор, хочу видеть БИН и номера исключённых пунктов при недоступности обязательной карточки заказчика.

Частичный режим явно включается только адаптером automation. Остальные потребители,
включая мониторы статусов, сохраняют строгий режим. Ошибки кода, конфигурации,
ограничения полной пагинации и неподтверждённое отсутствие обязательного реестра остаются фатальными.
Настоящая пустая страница считается успешным запросом. Успешная первая страница
незавершённого запроса также учитывается: данные этой страницы пригодны для частичного импорта.

При временном отказе одной ветки другая проходит обычные dry-run и проверку SHA-256.
`preparedBranches` перечисляет только подготовленные ветки; старые манифесты без этого поля
по-прежнему требуют все предусмотренные workflow артефакты. Новые поля опциональны.
AI-анализ остаётся отдельным действием approve и не запускается расписанием.

При успехе хотя бы одной ветки статус доставки остаётся `ready` / `pushed` / `applied`,
CLI возвращает 0; пропуски, ошибки второй ветки и предупреждения сохраняются.
При полном отказе всех веток статус `failed`, код 1 и сетевой маркер сохраняют повтор
через shell-обёртку. Отдельно исправлен код возврата `run` в режиме `deliveryMode=prepare`:
состояние `ready` теперь считается успешным завершением.

## RED → GREEN

1. `npx vitest run tests/kz/gzPartialCollection.test.ts tests/automation/gzPartialPeriods.test.ts tests/automation/orchestrator.test.ts tests/automation/runSummary.test.ts tests/kz/gzPlanExporterIntegration.test.ts --reporter=dot`
   — RED: 25 failed, 50 passed. Воспроизведены потери страниц/периодов, блокировка второй ветки,
   фатальная потеря всего экспорта при сетевом отказе одного БИН, отсутствие таблицы пропусков.
   Checkpoint: `2c8f818`.
2. После реализации тот же набор плюс классификатор: GREEN — 95 passed. Checkpoint: `56f09f4`.
3. Проверка TimeoutError без сетевого текста в message: RED — 1 failed, 47 passed;
   после добавления явного маркера для shell: GREEN — 48 passed. Checkpoints: `87a84cd`, `508b058`.
4. Полный набор выявил регрессию двух прежних тестов на сообщение `Timeout Nms exceeded`
   без `page.goto`. После исправления — 33 passed в двух соответствующих файлах (`25c1a38`).
5. Проверка CLI в режимах prepare/push: RED — 1 failed, 3 passed;
   после исправления — GREEN: 37 passed вместе с коллекторами/классификатором (`006d548`, `0bb8cc1`).

## Гарантии

| Поведение | Тесты | Тип |
| --- | --- | --- |
| При таймауте страницы 2 сохраняются строки страницы 1 и точное число попыток | `tests/kz/gzPartialCollection.test.ts` | Коллектор + XLSX |
| После N отказов первой страницы оставшиеся запросы не вызывают навигацию; пустой успешный ответ сбрасывает счётчик | `tests/kz/gzPartialCollection.test.ts` | Интеграционный |
| Сбой 2027 года сохраняет итоговый XLSX за 2026; полный отказ выбрасывает сетевую ошибку, штатный ноль разрешён | `tests/automation/gzPartialPeriods.test.ts` | Адаптер + XLSX |
| Для недоступного реестра исключается только подтверждённый проблемный БИН; отсутствие без сетевой причины фатально | `tests/kz/gzPlanExporterIntegration.test.ts` | Экспорт + SQLite |
| Реестр сообщает конкретные БИН, использует кэш, останавливает навигацию при серии отказов, не скрывает ошибки кода | `tests/kz/gzPartialRegistry.test.ts` | Коллектор + SQLite |
| Планы и лоты независимы при сетевых отказах; оба отказа дают failed; SHA-256 и dry-run сохраняются | `tests/automation/orchestrator.test.ts` | Жизненный цикл |
| Summary различает три результата и экранирует таблицу пропусков | `tests/automation/runSummary.test.ts` | Модульный |
| CLI отличает подготовленный пакет от ошибки | `tests/automation/gzPartialCli.test.ts` | CLI с подменой адаптеров |
| Классификация сетевых ошибок включает cause/code и HTTP 429/5xx, но не ошибки схемы/HTTP 400 | `tests/kz/gzCollectionErrors.test.ts` | Модульный |

## Итоговая проверка

- `npm run lint` — PASS, `tsc --noEmit` без ошибок.
- Профильный `npm run test:coverage -- ...` — 237 passed, 8 штатно skipped;
  92.06% statements/lines, 80.29% branches, 83.60% functions по девяти затронутым
  исполняемым модулям. Включённые файлы и полная команда указаны в `verification/coverage.log`.
  Новый `gzCollection.ts`: 100% строк, 97.72% ветвлений; `runSummary.ts`: 100% строк.
- Два полных запуска с `--reporter=dot` прошли: 1741 и 1748 тестов соответственно
  (до последних двух дополнительных проверок; 9 штатно skipped).
- Последующий запуск `npm test` прервался аварией нативного SQLite/Node 24.19.0
  (`RemoveEnvironmentCleanupHook`, затем `ERR_IPC_CHANNEL_CLOSED`), без assertion failure теста.
  Заключительный `npm test -- --pool=forks --maxWorkers=2` — PASS: **1750 passed,
  9 штатно skipped**, 153 файла passed, 4 skipped; 67.06 с. Ни одного failed.
- `git diff --check` — PASS. Патч дополнительно проверяется через `git apply --check`
  на базовом коммите и через обратную проверку на готовой ветке.

Полные команды и вывод сохраняются вместе с патчем в файлах `verification`.

## Изменённые файлы

- `src/kz/gzCollection.ts`, `goszakupPlanTypes.ts`, `gzPlansConfig.ts` — структура пропуска,
  классификатор, счётчик успешных запросов и настраиваемый порог предохранителя.
- `src/kz/goszakupPlanCollector.ts`, `goszakupLotsNstruExporter.ts` — сохранение страниц,
  обход оставшихся запросов и учёт пропусков; HTTP 429/5xx и техработы не считаются пустой выдачей.
- `src/kz/goszakupRegistryCollector.ts`, `goszakupRegistryFetcher.ts`, `gzPlanExporter.ts` —
  подтверждение сетевых отказов отдельных БИН, использование пригодного кэша, исключение только проблемных строк.
- `src/automation/realDependencies.ts` — попериодное обновление итогового XLSX и JSON-отчёта.
- `src/automation/types.ts`, `orchestrator.ts`, `runSummary.ts` — независимые ветки,
  запись пропусков и ошибок, проверка артефактов и Markdown-таблица.
- `scripts/automation.mts`, `run-automation-with-retry.sh` — корректный код возврата prepare
  и совместимость сетевых маркеров; README/AGENTS — описание нового поведения.
- Тесты перечислены в таблице выше; дополнены прежние фикстуры v1/v2-манифестов:
  они действительно не содержат нового поля `preparedBranches`.

Навигация и CRM в новых тестах подменены; SQLite и XLSX настоящие. Боевые сборы,
вызовы Bitrix, push, запуск workflow и деплой не выполнялись. POSIX-тесты оболочки
на Windows штатно пропускаются; их исходный механизм повторов сохранён.
Возобновление незавершённых запросов между разными запусками не входит в вариант 1.

`npm audit` перед checkpoint-коммитами: 26 известных уязвимостей в исходном дереве
зависимостей (1 low, 12 moderate, 11 high, 2 critical). Зависимости и lock-файл не изменялись.

## Исправления замечаний ревью — 3 ноября 2026

Источник требований — пять замечаний ревью к принятой реализации `bfee9a7`.
Ветка перенесена локальным `git fetch` из исходной рабочей копии в `F:\scrape2lead-main`.

### RED → GREEN

- Команда: `npx vitest run tests/automation/gzPartialPeriods.test.ts tests/automation/orchestrator.test.ts tests/automation/runSummary.test.ts tests/kz/gzPartialCollection.test.ts --pool=forks --reporter=dot`.
- RED до изменения production-кода: **11 failed, 72 passed**, четыре файла.
  Checkpoint `2411b0c`: воспроизведены ложный чистый ноль, отсутствие пропусков деталей,
  пустой артефакт при полном отказе, неполный список кодов и блокировка/устаревшие ошибки resume.
- GREEN той же команды: **83 passed**, четыре файла. Checkpoint `1724cdf`.

| Замечание | Исправление и проверяемая гарантия | Регрессия |
| --- | --- | --- |
| Сетевые потери деталей | Summary не пишет «сбоев нет» при `fetch_failed > 0`. После исчерпания сетевых повторов деталей сохраняются ключевое слово, период, ID пункта, попытки и причина. Это работает до фильтра ЕНСТРУ. Поиск, все найденные пункты которого потеряны таким образом, не считается успешным; корректный пустой запрос остаётся успешным. Если остались только сетевые потери, экспорт выбрасывает `GzSourceUnavailableError` до записи XLSX | `runSummary.test.ts`, `gzPartialCollection.test.ts` |
| Очистка файлов | При полном отказе удаляются имена `.part.xlsx` для всех запрошенных периодов и итоговый XLSX; `.collection.json` с обоими пропусками остаётся. Проверено отдельно для plans и lots | `gzPartialPeriods.test.ts` |
| Resume | Повторяются незавершённые доступные ветки push/approve, успешно выполненные apply/AI не повторяются. Успешная стадия удаляет только собственные старые ошибки, сохраняет посторонние и обновляет manifest на диске. Проверены сбои обеих веток и повтор AI; полностью завершённый прогон по-прежнему отклоняет повтор | `orchestrator.test.ts` |
| Коды лотов из файла | Если явные коды и слова пусты, `readNstruCodes(inputPath)` загружает реальный список для экспортёра и fallback-отчёта. При отказе периода отчёт содержит оба кода из тестового файла | `gzPartialPeriods.test.ts` |
| Node 24 / SQLite | Стандартный `test` теперь запускает `vitest run --pool=forks`. Прежняя авария `RemoveEnvironmentCleanupHook` зафиксирована выше; проверка исправления — полный `npm test` без дополнительных аргументов | `package.json`, полный набор |

### Итоговая проверка ревизии

- `npm run lint` — PASS.
- `npm run build` — PASS.
- **Чистый `npm test` — PASS: 1762 passed, 9 штатно skipped; 154 файла passed,
  3 skipped, 67.94 с**, Node 24.19.0. Без дополнительных аргументов и без аварии SQLite.
- Профильное покрытие: **92.30% statements/lines, 81.59% branches, 81.81% functions**;
  176 passed, 8 штатно skipped. Команда:
  `npm run test:coverage -- --pool=forks tests/automation tests/kz/goszakupPlanCollector.test.ts tests/kz/gzPlanExporter.test.ts tests/kz/gzPlanExporterIntegration.test.ts tests/kz/gzPartialCollection.test.ts tests/kz/gzPlanCompletePagination.test.ts --coverage.include=src/automation/orchestrator.ts --coverage.include=src/automation/realDependencies.ts --coverage.include=src/automation/runSummary.ts --coverage.include=src/kz/goszakupPlanCollector.ts --coverage.include=src/kz/gzPlanExporter.ts --reporter=dot`.
- `git diff --check` — PASS. Изменения просмотрены перед push.
- `npm audit --json` — те же 26 известных уязвимостей; зависимости не менялись.

Регрессии используют подменённые ответы портала и адаптеры CRM; SQLite/XLSX настоящие.
Штатные пропуски полного набора — восемь POSIX-тестов оболочки на Windows и один
отдельно включаемый браузерный тест отчётности. Боевые сборы, отправка в Bitrix,
ручной запуск workflow и деплой не выполнялись.
