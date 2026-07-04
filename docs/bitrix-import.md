# Универсальный импорт в Bitrix24

CLI `npm run bitrix:import` заливает лиды или сделки в Bitrix24 из любого XLSX/CSV
по декларативному JSON-конфигу маппинга — без правки кода под каждого клиента.

Возможности:

- **Идемпотентность** — каждая строка получает `ORIGIN_ID` по шаблону; повторный
  запуск не создаёт дубликатов (`existing` / `--update-existing`).
- **Preflight и dry-run по умолчанию** — без `--execute` ничего не пишется,
  только отчёт: `create / update / existing / duplicate / skipped`.
- **Детект дубликатов** — настраиваемые проверки по любым полям CRM
  (телефон, БИН + сумма, ссылка и т.д.) до создания записи.
- **Привязка компаний** — поиск по кастомному полю (например, БИН),
  find-or-create с собственным `ORIGIN_ID`.
- **Трансформации значений** — `money`, `bin`, `email`, `phone`, `url`, `digits`, `trim`;
  мультиполя `PHONE`/`EMAIL`/`WEB`/`IM` оборачиваются в формат Bitrix автоматически.
- **Rate limiting и ретраи** — пауза между запросами (лимит Bitrix ~2 rps),
  повтор при 429/5xx/`QUERY_LIMIT_EXCEEDED` с экспоненциальной задержкой.

## Быстрый старт

```bash
# 1. Скопируйте и отредактируйте конфиг маппинга
cp config/bitrix-import.example.json config/bitrix-import.client-x.json

# 2. Dry-run: проверка маппинга, обязательных полей и дубликатов
npm run bitrix:import -- --config config/bitrix-import.client-x.json --input data/rows.xlsx

# 3. Реальная запись
npm run bitrix:import -- --config config/bitrix-import.client-x.json --input data/rows.xlsx --execute
```

Вебхук берётся из `BITRIX24_WEBHOOK_URL` (`.env`) или флага `--webhook-url`.
Прочие флаги: `--update-existing`, `--limit N`, `--delay-ms N`, `--help`.

## Конфиг маппинга

См. [config/bitrix-import.example.json](../config/bitrix-import.example.json). Структура:

| Секция | Назначение |
|---|---|
| `entity` | `lead` или `deal` |
| `originatorId` / `originIdTemplate` | ключ идемпотентности: `order:{orderId}` |
| `columns` | колонки источника: по заголовку (`header`) или номеру (`index`) |
| `required` | колонки, без которых строка попадает в `skipped` |
| `fields` | Bitrix-поле ← `column` / `template` / `value` (+ `transform`) |
| `duplicateChecks` | фильтры `crm.*.list` для поиска дубликатов до записи |
| `defaults` | `assignedById`, `categoryId`, `stageId`, `statusId`, `sourceId` |
| `company` | привязка/создание компании по поисковому полю (например, БИН) |

Конфиг валидируется zod-схемой ([importConfig.ts](../src/bitrix/importConfig.ts)):
ссылки на несуществующие колонки, дубли ключей и противоречивые спецификации
полей отклоняются до первого обращения к API.

## Модуль `src/bitrix/`

- [client.ts](../src/bitrix/client.ts) — универсальный REST-клиент (webhook, троттлинг, ретраи)
- [importConfig.ts](../src/bitrix/importConfig.ts) — схема и загрузка конфига
- [importPlanner.ts](../src/bitrix/importPlanner.ts) — чистая логика: маппинг, трансформации, план действий
- [importRunner.ts](../src/bitrix/importRunner.ts) — оркестрация preflight → запись
- [xlsxRowReader.ts](../src/bitrix/xlsxRowReader.ts) — чтение XLSX/CSV по конфигу колонок

Тесты: `tests/bitrix/` (`npm test`).
