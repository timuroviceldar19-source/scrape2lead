# Анализ тендерных PDF через OpenCode

Скрипт `npm run kz:analyze-gz-specs` анализирует технические спецификации из госзакупок и записывает структурированный результат в Bitrix24. По умолчанию PDF преобразуется в JPEG-страницы и отправляется в vision-модель MiMo-V2.5 Free. Если основной запрос или валидация ответа не удались, скрипт использует Kimi K2.6 через OpenCode Go.

## Настройка

Ключ лучше хранить только в локальном `.env` или в секретах среды. Не добавляйте его в Git и не отправляйте в сообщения.

```dotenv
SPEC_ANALYSIS_PROVIDER=opencode
OPENCODE_API_KEY=<ключ OpenCode>
OPENCODE_BASE_URL=https://opencode.ai/zen/v1
OPENCODE_MODEL=mimo-v2.5-free
SPEC_ANALYSIS_FALLBACK_BASE_URL=https://opencode.ai/zen/go/v1
SPEC_ANALYSIS_FALLBACK_MODEL=kimi-k2.6
```

Переменные `OPENCODE_*` имеют приоритет над старыми общими `CLOUD_*`. Существующую конфигурацию Anthropic поэтому можно оставить без изменений. Если для резервной модели нужен отдельный ключ, задайте `SPEC_ANALYSIS_FALLBACK_API_KEY`.

Для Windows укажите пути к Poppler, если `pdfinfo` и `pdftoppm` отсутствуют в `PATH`:

```dotenv
PDFINFO_PATH=C:\path\to\poppler\Library\bin\pdfinfo.exe
PDFTOPPM_PATH=C:\path\to\poppler\Library\bin\pdftoppm.exe
SPEC_PDF_MAX_PAGES=30
SPEC_PDF_DPI=150
SPEC_PDF_JPEG_QUALITY=88
```

Временные изображения удаляются после каждого анализа, включая ошибочные запуски. PDF длиннее `SPEC_PDF_MAX_PAGES` отклоняется, чтобы не отправить неожиданно большой запрос.

## Запуск

Проверка без записи в Bitrix24:

```powershell
npm run kz:analyze-gz-specs -- --limit 1
```

Запись результата в Bitrix24:

```powershell
npm run kz:analyze-gz-specs -- --limit 10 --execute
```

Параметры командной строки переопределяют `.env`:

```powershell
npm run kz:analyze-gz-specs -- --provider opencode --model mimo-v2.5-free --fallback-model kimi-k2.6 --limit 1
```

`--fallback-model none` отключает резервную модель. `--force` повторно анализирует уже обработанные сделки.

## Конфиденциальность

Бесплатные модели OpenCode могут сохранять входные данные для улучшения моделей. Этот режим предназначен только для публичных тендерных документов. Для внутренних документов, персональных данных и закрытых вложений используйте провайдера с подходящими договорными гарантиями.

Старый Anthropic-режим сохранён для совместимости:

```dotenv
SPEC_ANALYSIS_PROVIDER=anthropic
ANTHROPIC_API_KEY=<ключ Anthropic>
ANTHROPIC_BASE_URL=https://api.anthropic.com/v1/
SPEC_ANALYSIS_MODEL=claude-sonnet-5
```
