# Scrape2Lead — Госзакупки → Bitrix24

Узкоспециализированный пайплайн для работы с государственными закупками Казахстана:

1. сбор планов и лотов с `goszakup.gov.kz`;
2. экспорт и дедупликация Excel-отчётов;
3. загрузка и обслуживание сделок в Bitrix24;
4. мониторинг публикации закупок;
5. анализ технических спецификаций с помощью vision-моделей.

Старые контуры 2GIS, Kaspi, stat.gov, enrichment, operator API и outreach из проекта удалены.

## Требования

- Node.js 20 или новее;
- Chromium для Playwright;
- Poppler (`pdfinfo` и `pdftoppm`) для анализа PDF;
- входящий webhook Bitrix24 для CRM-команд.

## Установка

```powershell
npm ci
npx playwright install chromium
Copy-Item .env.example .env
```

Заполните в `.env` только необходимые секреты. Файл `.env` не должен попадать в Git.

## Основные команды

### Сбор и подготовка данных

```powershell
npm run kz:export-gz-plans
npm run kz:export-lots-nstru
npm run kz:export-lots-computers
npm run kz:dedupe-gz-plans -- --input exports/input.xlsx
```

Конфигурации находятся в `config/gz-plans*.json` и `config/gz-lots-computers.json`. Команда экспорта произвольных кодов НС ТРУ по умолчанию читает `Nstru.txt`.

### Bitrix24

```powershell
npm run bitrix:import -- --config config/bitrix-import.example.json --file exports/input.xlsx --dry-run
npm run kz:bitrix-push-gz-plans -- --input exports/gz-plans.xlsx --limit 10
npm run kz:bitrix-push-gz-deals -- --input exports/gz-plans.xlsx --limit 10
npm run kz:bitrix-push-gz-lots -- --input exports/gz-lots.xlsx --limit 10 --no-company
npm run bitrix:gz-duplicate-hygiene -- --help
npm run bitrix:backfill-gz-origin -- --help
npm run bitrix:migrate-gz-categories -- --help
```

Команды изменения CRM сначала запускайте в dry-run/preview режиме. Перед execute-проходом проверьте pipeline, ответственного и число найденных записей.

### Мониторинг и анализ спецификаций

```powershell
npm run kz:check-gz-deals-published
npm run kz:monitor-gz-published-leads -- --dry-run
npm run kz:analyze-gz-specs -- --limit 10
```

Анализатор использует OpenCode vision по умолчанию и поддерживает Anthropic как альтернативный провайдер. Отправляйте во внешнюю модель только публичные тендерные документы.

## Проверка проекта

```powershell
npm run build
npm run lint
npm test
npm run test:coverage
npm audit
```

## Структура

- `scripts/` — исполняемые команды GZ и Bitrix24;
- `src/kz/` — сбор, парсинг и экспорт госзакупок;
- `src/bitrix/` — клиент, импорт, маршрутизация и обслуживание CRM;
- `src/analysis/` — загрузка и vision-анализ технических спецификаций;
- `config/` — примеры и рабочие конфигурации пайплайна;
- `tests/` — тесты поддерживаемого контура.

Генерируемые файлы пишутся в `data/`, `exports/`, `logs/`, `tmp/` и `raw_snapshots/`; их содержимое не версионируется.

Дополнительная документация: [импорт Bitrix24](docs/bitrix-import.md) и [анализ спецификаций](docs/ai-spec-analysis.md).
