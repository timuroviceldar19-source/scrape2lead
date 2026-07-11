# TDD-отчёт: OpenCode vision-анализ спецификаций

## Область изменения

- OpenCode-совместимый multimodal API с MiMo-V2.5 Free.
- Резервный Kimi K2.6 после ошибок запроса или невалидного JSON.
- Преобразование PDF в изображения через Poppler с очисткой временных файлов.
- Сохранение Anthropic native-PDF режима для обратной совместимости.

## RED

До реализации были добавлены тесты конфигурации OpenCode, multimodal payload, fallback и PDF-рендера.

```powershell
npx vitest run tests/analysis/specAnalyzer.test.ts tests/analysis/pdfRenderer.test.ts
```

Ожидаемый результат был получен: тестовый запуск завершился ошибкой из-за отсутствующих OpenCode-функций и модуля PDF-рендера. Отдельный регрессионный тест также выявил смешивание `ANTHROPIC_BASE_URL` с явно выбранным OpenCode-провайдером.

## GREEN

После реализации и исправления изоляции настроек провайдеров:

```text
Test Files  2 passed (2)
Tests       26 passed (26)
```

Проверка типов:

```powershell
npm run lint
```

завершилась без ошибок.

## Покрытие

```powershell
npx vitest run tests/analysis/specAnalyzer.test.ts tests/analysis/pdfRenderer.test.ts --coverage --coverage.include=src/analysis/specAnalyzer.ts --coverage.include=src/analysis/pdfRenderer.ts --coverage.reporter=text
```

Итог для новых модулей: 92,52% statements/lines, 73,41% branches, 96% functions.

## Интеграционная проверка PDF

Одностраничный тестовый PDF был создан локально, преобразован реальными `pdfinfo`/`pdftoppm` в JPEG и визуально проверен. Результат: одна страница, `image/jpeg`, 45 362 байта. Тестовые и временные файлы после проверки удалены.

## Ограничения проверки

Живой запрос к OpenCode не выполнялся: ключ не переносился из пользовательских хранилищ и локальный `.env` не изменялся. Для smoke-теста требуется локально задать ключ OpenCode и запустить команду с `--limit 1` без `--execute`.

Промежуточные Git-коммиты TDD не создавались, потому что рабочее дерево уже содержало незакоммиченные пользовательские изменения в той же области.

Полный `npm test`: 821 тест прошёл, 6 пропущено, один ранее существовавший тест `tests/kz/goszakupPlanParser.test.ts` падает на ожидании `totalPages >= 2` при фактическом значении `1`. Тесты нового анализатора при полном прогоне проходят.

`npm audit` сообщает о трёх известных проблемах зависимостей: одна low в dev-зависимости `esbuild` и две moderate через `exceljs -> uuid`. Автоматическое исправление не применялось, поскольку полное исправление предлагает несовместимое понижение `exceljs`.
