# TDD-отчёт: Qwen3.7 Plus через OpenCode Go `/messages`

## Пользовательский сценарий

Как владелец тендерного пайплайна, я хочу анализировать один PDF моделями Kimi и Qwen через их реальные API-протоколы, чтобы выбрать модель по измеренному качеству, а не по названию.

## RED

До реализации были добавлены тесты следующих гарантий:

- Qwen автоматически выбирает transport `messages`.
- PDF-страницы преобразуются в Anthropic-compatible image blocks.
- thinking отключается для совместимости со structured output.
- ответ `/messages` извлекается из массива `content` и проходит существующую Zod-схему.

Команда:

```powershell
npx vitest run tests/analysis/specAnalyzer.test.ts
```

Результат RED: 4 теста упали по ожидаемым причинам — отсутствовали transport, builder и обработчик ответа `/messages`.

## GREEN

После реализации:

```text
Test Files  2 passed (2)
Tests       29 passed (29)
```

Команды:

```powershell
npx vitest run tests/analysis/specAnalyzer.test.ts tests/analysis/pdfRenderer.test.ts
npm run lint
```

Обе завершились без ошибок.

## Покрытие

```powershell
npx vitest run tests/analysis/specAnalyzer.test.ts tests/analysis/pdfRenderer.test.ts --coverage --coverage.include=src/analysis/specAnalyzer.ts --coverage.include=src/analysis/pdfRenderer.ts --coverage.reporter=text
```

Итог: 93,08% statements/lines, 73,78% branches, 96,42% functions. Требование 80% выполнено для statements, lines и functions; ветвление ниже 80% в основном относится к диагностическим ошибкам внешних процессов и редким вариантам provider payload.

## Интеграционная проверка

- Маленькое изображение успешно распознано реальным `qwen3.7-plus` через OpenCode Go `/messages`.
- Пять публичных PDF прогнаны через Kimi и Qwen без записи в Bitrix24.
- Большой 14-страничный PDF дополнительно проверен в сжатом режиме после фиксации лимита 6 МБ.

Git-чекпоинты не создавались, поскольку рабочее дерево до начала задачи уже содержало незакоммиченные пользовательские изменения в тех же файлах.
