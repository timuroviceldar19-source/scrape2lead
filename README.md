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

### Ежедневная автоматизация

Подготовить новый запуск вручную:

```powershell
npm run automation:prepare
```

Команда собирает планы и лоты за текущие шесть месяцев, выполняет Bitrix
dry-run и сохраняет пакет в `runs/<run-id>/`. Она не изменяет CRM и не
запускает AI. Результат смотрите в `summary.txt` и `manifest.json`.

Подготовить и сразу загрузить новый запуск (полный Bitrix-workflow без AI):

```powershell
npm run automation:run
```

Команда выполняет `prepare`, а затем, если dry-run прошёл без критических
ошибок, автоматически отправляет планы и лоты в Bitrix. AI-анализ не
запускается. Успешный запуск получает статус `pushed`. Для загрузки нужен
только `BITRIX24_WEBHOOK_URL`.

Проверить состояние и, при необходимости, дозагрузить или проанализировать
конкретный пакет:

```powershell
npm run automation:status -- --run 20260712-100000
npm run automation:push -- --run 20260712-100000
npm run automation:approve -- --run 20260712-100000
```

`push` сверяет SHA-256 артефактов и загружает планы и лоты. Если планы уже
загружены, а лоты — нет (частичный сбой), повторный `push` продолжит с лотов
без повторной отправки планов. Повторная загрузка полностью выгруженного
запуска запрещена.

`approve` также сверяет SHA-256 артефактов. Для запуска со статусом `pushed`
он выполняет только ручной AI-анализ лотов. Для запуска `ready` он применяет
планы, лоты и AI. Повторный approval завершённого запуска запрещён; после
ошибки AI та же команда продолжит только AI-этап.

Установить или обновить ежедневное задание Windows на 10:00:

```powershell
npm run automation:install-task
```

Параметры находятся в `config/automation.json`. Планировщик запускает полный
Bitrix-workflow (`automation:run`): prepare, а затем автоматическую загрузку
планов и лотов. AI-анализ остаётся ручным. Лог планировщика записывается в
`runs/scheduler.log` вместе с итоговым статусом и кодом возврата. Если планы
или лоты не собраны либо dry-run содержит критическую ошибку, запуск получает
статус `failed` и загрузка не выполняется.

Установить или обновить ежедневное задание Windows для PK-планов на 11:00:

```powershell
npm run automation:install-pk-task
```

Задание `Scrape2Lead Daily PK Plans` работает по `config/automation.pk.json` в
режиме `"workflow": "plans-only"`: собирает только планы по
`config/gz-plans.pk.json`, выполняет dry-run и отправляет планы в Bitrix.
Лоты и AI-анализ в этом режиме не запускаются, а `automation:approve` для
такого запуска отклоняется с ошибкой — планы отправляются через
`automation:push`. Запуски хранятся в `runs/pk/`, лог — `runs/pk/scheduler.log`.
PK-ключевые слова маршрутизируются в Bitrix category `9` / stage `C9:NEW`
согласно `config/bitrix-gz-routing.json`.

Оба задания используют общий lock `runs/prepare.lock`, поэтому сбор никогда не
идёт параллельно. Если в 11:00 задание на 10:00 ещё работает, PK-запуск
завершается без сбора и без записи в Bitrix24 и повторяется на следующий день.

Любой запуск можно выполнить вручную с явным конфигом:

```powershell
npm run automation:run -- --config config/automation.pk.json
```

### Сбор и подготовка данных

```powershell
npm run kz:export-gz-plans
npm run kz:export-lots-nstru
npm run kz:export-lots-computers
npm run kz:export-gz-contracts -- --config config/gz-contracts-panels.json
npm run kz:dedupe-gz-plans -- --input exports/input.xlsx
```

Экспорт договоров ищет каждый код ЕНС ТРУ отдельно в публичном реестре за период с
`2026-01-01` по текущую локальную дату. Результат сохраняется в `exports/` и содержит
БИН заказчика, название заказчика, БИН/ИИН поставщика, название поставщика и код поиска.
Параметры запуска: `--from`, `--to`, `--out`, `--limit`, `--max-pages`, `--headful` и `--dry-run`.

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
npm run kz:check-gz-deals-published -- --limit 10
npm run kz:check-gz-deals-published -- --limit 10 --execute
npm run kz:monitor-gz-published-leads -- --dry-run
npm run kz:analyze-gz-specs -- --limit 10
```

Монитор публикаций обновляет только статус сделки: у сделок со статусом «Утвержден», опубликованных на Goszakup, он записывает «Опубликован» в `UF_CRM_PLAN_STATUS` и в устаревшее совместимое поле, а при первом обнаружении — дату в `UF_CRM_S2L_GZ_PUBLISHED_AT`. Стадии и воронки Bitrix не изменяются, `STAGE_ID` никогда не передаётся. Сделки с другим, пустым или уже опубликованным статусом попадают в отчёт как пропущенные.

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
