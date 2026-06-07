# Техническое задание (ТЗ) v2

## Платформа обогащения компаний Казахстана по БИН: stat.gov.kz + закупки

**Проект:** Scrape2Lead → **KZ Company Intelligence** (рабочее имя)
**Версия ТЗ:** 2.0
**Дата:** 2026-06-07
**Стек:** Node.js v20+, TypeScript, Playwright, SQLite / PostgreSQL
**Предыдущее ТЗ:** `scrape2lead_tz_v1.7.md` — **не отменяется**, но **не является приоритетом** для текущей разработки

---

## 0. Контекст и смена фокуса

### 0.1. Почему v2

ТЗ v1.7 описывает **платформу сбора лидов из 2GIS** (гео + категория → контакты). В ходе разработки продуктовый фокус сместился:

| Было (v1.7) | Стало (v2) |
|---|---|
| 2GIS — основной источник | **stat.gov.kz + закупки** — основной источник |
| Лид = карточка из каталога | **Компания = юрлицо по БИН** |
| Ценность = телефон/email для обзвона | Ценность = **верифицированный реестр + активность в закупках** |
| MVP = 500–1000 карточек 2GIS | MVP = **N БИН → юрданные + тендеры → единая карточка компании** |

Модули v1.7 (2GIS/Kaspi adapter, enrichment, scoring, export) **остаются в репозитории** как вспомогательный слой для **получения списка БИН/названий**, но не входят в критерии приёмки v2.

### 0.2. Назначение системы v2

Автоматический сбор и нормализация **публичных данных о юридических лицах и ИП Республики Казахстан** по списку БИН, с последующим обогащением данными о **государственных и квазигосударственных закупках**.

**Целевой пользователь:** B2B-продажи, тендерный мониторинг, due diligence, лидогенерация по активным заказчикам.

### 0.3. Объём первой поставки (MVP Scope v2)

**Входит в MVP v2:**

- CLI-пайплайн: входной CSV с БИН → stat.gov.kz → закупки → экспорт.
- Коллектор **stat.gov.kz** (авторизация через egov mobile, сессия, парсинг кабинета).
- Коллектор **zakup.sk.kz** (Самрук-Казына) — Playwright + перехват API.
- Коллектор **goszakup.gov.kz** — REST API по БИН (при наличии Bearer token).
- Единая схема хранения: `companies` (или расширенная `leads`), `stat_gov_data`, `tender_data`.
- Связка записей по БИН; опциональный матчинг по названию при отсутствии БИН у feeder-источника.
- Экспорт XLSX/CSV: карточка компании + лист закупок + сводка.
- Миграции БД, `.env.example`, документация, unit-тесты на парсеры и нормализацию.
- Логирование, raw snapshots при ошибках, rate limiting между запросами.

**Не входит в MVP v2 (отдельные этапы):**

- Telegram-бот и push-уведомления о новых закупках.
- Веб-дашборд и CRM-интеграции.
- Парсинг 2GIS/Kaspi как самостоятельный продукт (уже есть, не в scope приёмки).
- Lead scoring / AutoService Radar KZ как коммерческий пакет.
- Обход CAPTCHA сторонними solver-сервисами.
- Массовый мониторинг всего реестра stat.gov (только список БИН на входе).

**Правило приоритета:** при противоречии с v1.7 для задач stat.gov/tenders приоритет имеет **настоящий документ (v2)**.

---

## 1. Источники данных

### 1.1. stat.gov.kz (обязательный, primary)

| Параметр | Значение |
|---|---|
| URL | `https://stat.gov.kz/ru/cabinet/juridical/by/bin/` |
| Метод | Playwright + сохранённая сессия (`storageState`) |
| Авторизация | QR-код через **egov mobile** (ручной шаг оператора) |
| Вход | БИН (12 цифр) |
| Частота сессии | Переавторизация при 401/редиректе на логин или по таймауту (рекомендуется ≤ 60 мин) |

**Обязательные поля (MVP):**

| Поле | Описание | Нормализация |
|---|---|---|
| `bin` | БИН | 12 цифр, валидация checksum (опционально этап 2) |
| `name` | Полное наименование | trim, сохранять оригинал |
| `registration_date` | Дата регистрации | `DD.MM.YYYY` → ISO `YYYY-MM-DD` |
| `oked` | Код ОКЭД | строка |
| `oked_name` | Наименование вида деятельности | строка |
| `director` | ФИО руководителя | строка; **только B2B-контекст**, не персональные данные для рассылок |
| `legal_status` | Статус юрлица | enum: `active`, `inactive`, `liquidated`, `reorganizing`, `unknown` |

**Дополнительные поля (входит в MVP, не блокирует приёмку при частичном отсутствии на странице):**

| Поле | Описание |
|---|---|
| `address` | Юридический адрес |
| `krp_code`, `krp_name` | Класс субъекта предпринимательства |
| `kfs_code`, `kfs_name` | Форма собственности |
| `sector_code`, `sector_name` | Сектор экономики |
| `company_age_years` | Вычисляемое от `registration_date` |
| `legal_form` | ТОО / АО / ИП и т.д. (парсинг из `name` или отдельное поле) |

> **Важно:** `kfs_name` (форма собственности) **не является** `legal_status`. В v2 эти поля разделены явно.

### 1.2. zakup.sk.kz — Самрук-Казына (обязательный для MVP)

| Параметр | Значение |
|---|---|
| URL | `https://zakup.sk.kz/#/lots` |
| Метод | Playwright + перехват XHR (`/eprocsearch/api/external/4dv3rts/filter`) |
| Авторизация | Не требуется для публичного поиска |
| Вход | **Название компании** (нормализованное из stat.gov) + привязка к БИН |
| Ограничение | Прямого поиска по БИН нет — поиск по тексту названия |

**Обязательные поля закупки:**

| Поле | Источник API (текущий) |
|---|---|
| `source` | константа `zakup.sk.kz` |
| `bin` | из входного списка / stat.gov |
| `tender_number` | `number` |
| `tender_name` | `nameRu` / `nameKk` |
| `customer_name` | из stat.gov `name` |
| `budget_amount` | `sumTruNoNds` |
| `currency` | `KZT` |
| `start_date` | `acceptanceBeginDateTime` |
| `end_date` | `acceptanceEndDateTime` |
| `status` | `advertStatus` |
| `method` | `tenderType` |
| `url` | `https://zakup.sk.kz/#/lots/{number}` |
| `parsed_at` | ISO timestamp |

### 1.3. goszakup.gov.kz — госзакупки (обязательный при наличии токена)

| Параметр | Значение |
|---|---|
| API | `GET https://ows.goszakup.gov.kz/trd-buy/biin/{BIN}` |
| Авторизация | `Authorization: Bearer {GOSZAKUP_TOKEN}` |
| Получение токена | Письмо в Минфин РК (шаблон в `docs/TENDERS.md`) |
| Вход | БИН (12 цифр) — **прямой поиск** |

**Поведение при отсутствии токена:**

- Пайплайн **не падает**; источник помечается `skipped: no_token`.
- В лог и отчёт экспорта попадает предупреждение.
- MVP считается принятым, если zakup.sk.kz + stat.gov работают; goszakup — **условный критерий** до получения токена.

**Обязательные поля закупки:** аналогично п. 1.2, `source = goszakup.gov.kz`.

### 1.4. Feeder-источники (опционально, вне MVP v2)

| Источник | Роль |
|---|---|
| 2GIS / Kaspi | Получение списка названий → последующий матчинг с stat.gov по БИН |
| Ручной CSV | Основной вход MVP: один БИН на строку |

---

## 2. Целевая архитектура

### 2.1. Принцип

Единый CLI и единый storage contract. Скрипты в `scripts/` — **временная реализация**; целевое состояние — модули в `src/`.

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  bins.csv   │────▶│  Pipeline CLI    │────▶│  IStorage       │
│  (вход)     │     │  kz-enrich       │     │  sqlite/postgres│
└─────────────┘     └────────┬─────────┘     └────────┬────────┘
                             │                        │
              ┌──────────────┼──────────────┐         │
              ▼              ▼              ▼         ▼
        StatGovAdapter  ZakupAdapter  GoszakupAdapter  Export
```

### 2.2. Модули (целевая структура)

```
src/
  adapters/
    statgov/          StatGovAdapter — сессия, поиск по БИН, парсинг HTML
    zakup/            ZakupAdapter — Playwright + API capture
    goszakup/         GoszakupAdapter — HTTP client, Bearer auth
  kz/
    pipeline.ts       Оркестрация: stat → tenders → merge
    nameNormalize.ts  Нормализация названия для поиска zakup
    legalStatus.ts    Маппинг статуса юрлица
  storage/            IStorage + миграции (companies, tender_data)
  export/             KZ export (company + tenders sheets)
  cli.ts              Команда `kz-enrich` или подкоманды
```

### 2.3. Контракт адаптера закупок (новый)

```typescript
interface ITenderSourceAdapter {
  readonly source: "zakup.sk.kz" | "goszakup.gov.kz";
  readonly requiresAuth: boolean;
  isAvailable(): boolean;  // false если нет токена / сессии
  fetchTendersByBin(bin: string, companyName?: string): Promise<TenderRecord[]>;
}
```

### 2.4. Контракт адаптера stat.gov

```typescript
interface IStatGovAdapter {
  ensureSession(): Promise<void>;   // загрузка или интерактивный login
  fetchByBin(bin: string): Promise<StatGovRecord | null>;
}
```

---

## 3. Модель данных

### 3.1. StatGovRecord

```typescript
interface StatGovRecord {
  bin: string;
  name: string;
  registration_date: string | null;  // ISO date
  oked: string | null;
  oked_name: string | null;
  address: string | null;
  director: string | null;
  legal_status: "active" | "inactive" | "liquidated" | "reorganizing" | "unknown";
  krp_code: string | null;
  krp_name: string | null;
  kfs_code: string | null;
  kfs_name: string | null;
  sector_code: string | null;
  sector_name: string | null;
  company_age_years: number | null;
  legal_form: string | null;
  updated_at: string;  // ISO timestamp
  raw_snapshot_path: string | null;
}
```

### 3.2. TenderRecord

```typescript
interface TenderRecord {
  source: "zakup.sk.kz" | "goszakup.gov.kz";
  bin: string;
  tender_number: string;
  tender_name: string;
  customer_name: string | null;
  budget_amount: string | null;  // decimal string, KZT
  currency: "KZT";
  start_date: string | null;
  end_date: string | null;
  status: string;
  method: string | null;
  url: string;
  parsed_at: string;
}
```

**Уникальный ключ:** `(source, bin, tender_number)`.

### 3.3. CompanyCard (агрегат для экспорта)

Объединение stat.gov + агрегаты по тендерам:

| Поле | Источник |
|---|---|
| Все поля StatGovRecord | stat.gov |
| `tender_count_total` | COUNT tender_data |
| `tender_count_active` | COUNT WHERE status IN (активные статусы) |
| `tender_budget_sum` | SUM budget_amount |
| `tender_sources` | DISTINCT source |
| `last_tender_date` | MAX end_date |

### 3.4. Таблицы БД (целевая схема)

Миграции **обязательно** в `src/storage/migrations.ts` (не `CREATE TABLE` в скриптах).

```sql
-- stat_gov_data (расширить текущую)
ALTER ... ADD COLUMN legal_status TEXT;
ALTER ... ADD COLUMN raw_snapshot_path TEXT;

-- tender_data (унифицировать)
CREATE TABLE tender_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  bin TEXT NOT NULL,
  tender_number TEXT NOT NULL,
  tender_name TEXT NOT NULL,
  customer_name TEXT,
  budget_amount TEXT,
  currency TEXT DEFAULT 'KZT',
  start_date TEXT,
  end_date TEXT,
  status TEXT,
  method TEXT,
  url TEXT,
  parsed_at TEXT NOT NULL,
  UNIQUE(source, bin, tender_number)
);

CREATE INDEX idx_tender_data_bin ON tender_data(bin);
CREATE INDEX idx_stat_gov_bin ON stat_gov_data(bin);
```

Связь с legacy-таблицей `leads` (если используется feeder): поле `leads.bin` + матчинг по `nameNormalizer` с порогом ≥ 0.7.

---

## 4. CLI и сценарии использования

### 4.1. Команды (целевые)

```bash
# 1. Авторизация stat.gov (интерактивно, один раз)
npm run kz:login
# или: npx tsx src/cli.ts kz login

# 2. Полный пайплайн по CSV
npm run kz:enrich -- bins.csv
# Флаги:
#   --skip-stat-gov      только тендеры (stat уже в БД)
#   --skip-tenders       только stat.gov
#   --sources zakup,goszakup
#   --delay-ms 2000
#   --export xlsx

# 3. Только stat.gov
npm run kz:stat -- bins.csv

# 4. Только тендеры
npm run kz:tenders -- bins.csv

# 5. Экспорт без сбора
npm run kz:export -- --format xlsx --out exports/kz-report.xlsx
```

### 4.2. Формат входного файла

```text
# bins.csv — одна колонка или первая колонка, без заголовка или с заголовком "bin"
220540025781
010140001234
```

Валидация: `/^\d{12}$/`. Невалидные строки — warning в лог, пропуск.

### 4.3. Порядок обработки одного БИН

1. Проверить кэш в `stat_gov_data` (TTL настраиваемый, по умолчанию 7 дней).
2. Если нет / устарело → запрос stat.gov → сохранить + raw HTML snapshot.
3. Нормализовать `name` для zakup (убрать ТОО/АО/ИП, кавычки, скобки).
4. Параллельно или последовательно:
   - zakup.sk.kz по названию;
   - goszakup.gov.kz по БИН (если токен есть).
5. Upsert в `tender_data`.
6. Обновить агрегаты / связь с `leads` (если feeder включён).

### 4.4. Rate limiting

| Источник | Минимальная пауза между запросами |
|---|---|
| stat.gov.kz | 2000 ms (настраиваемо) |
| zakup.sk.kz | 2000 ms + полный цикл браузера |
| goszakup.gov.kz | 1000 ms |

При HTTP 429 / soft block — exponential backoff, max 3 попытки, запись в `parse_attempts` или аналог.

---

## 5. Нормализация и матчинг

### 5.1. Название для zakup.sk.kz

Правила (уже частично в `zakup-collector.ts`):

1. Удалить: `ТОО`, `ТОВАРИЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ`, `АО`, `АКЦИОНЕРНОЕ ОБЩЕСТВО`, `ИП`, `ИНДИВИДУАЛЬНЫЙ ПРЕДПРИМАТЕЛЬ`.
2. Удалить кавычки `«»"'` и содержимое в `(...)`.
3. Trim, схлопнуть пробелы.
4. Минимальная длина для поиска: 3 символа.

### 5.2. Матчинг stat.gov ↔ leads (feeder)

- Приоритет 1: точное совпадение `bin`.
- Приоритет 2: `matchNames(stat.name, lead.company_name)` ≥ 0.7 (`src/utils/nameNormalizer.ts`).
- При конфликте (один stat → несколько leads) — `manual_review` flag, не авто-апдейт.

### 5.3. legal_status

Маппинг с русскоязычных меток страницы stat.gov (уточнить по HTML-снимкам):

| Текст на странице | `legal_status` |
|---|---|
| Действующий / Зарегистрирован | `active` |
| Недействующий | `inactive` |
| Ликвидирован / Прекращён | `liquidated` |
| Реорганизация | `reorganizing` |
| Не найдено | `unknown` |

---

## 6. Экспорт

### 6.1. Форматы

- **XLSX** (основной): exceljs.
- **CSV** (опционально): по одному файлу на сущность.

### 6.2. Листы XLSX

| Лист | Содержимое |
|---|---|
| `Companies` | StatGovRecord + агрегаты тендеров |
| `Tenders` | Все закупки, flat list |
| `Summary` | Всего компаний, с тендерами, по источникам, по статусам закупок |
| `Errors` | БИН с ошибками, причина, timestamp |

### 6.3. Заголовки

Русские заголовки для бизнес-пользователя; внутренние ключи — английские (как в `exporter.ts` v1.7).

---

## 7. Нефункциональные требования

### 7.1. Надёжность

- Сбой одного БИН не останавливает batch.
- Сбой одного источника (goszakup без токена) не останавливает остальные.
- Raw snapshots: HTML stat.gov, JSON API zakup — в `data/debug/` или `raw_snapshots/`.

### 7.2. Безопасность

- `GOSZAKUP_TOKEN`, session files — **только** `.env` / `data/`, в `.gitignore`.
- `.env.example` без реальных значений.
- Не коммитить `data/stat-gov-session.json`.

### 7.3. Compliance

- Только **публичные B2B-данные** и данные из официальных реестров/порталов.
- ФИО директора — из госреестра, использование для B2B due diligence, не для массовых рассылок физлицам.
- Opt-out: по запросу организации — удаление из БД в течение 48 ч (процедура в `docs/`).
- Без обхода CAPTCHA и без нарушения ToS порталов.

### 7.4. Тестирование

| Тип | Что покрывает |
|---|---|
| Unit | `parseHtmlResponse`, `normalizeCompanyName`, `mapLegalStatus`, валидация БИН |
| Fixture | HTML из `data/debug/stat-gov-*.html`, JSON zakup API |
| Integration | SQLite round-trip stat + tender upsert |
| Contract | `ITenderSourceAdapter`, `IStatGovAdapter` |
| E2E (manual) | login → 1 БИН → export (не в CI без секретов) |

Целевой порог: ≥ 90% unit/integration pass; E2E — чеклист в `docs/manual-verification-playbook.md`.

---

## 8. Этапы реализации

### Этап 1 — Консолидация (текущий код → платформа)

- [ ] Унифицировать `tender_data` (колонка `source` везде).
- [ ] Объединить `zakup-collector` + `tenders-collector` → один `kz:tenders`.
- [ ] Перенести CREATE TABLE в `src/storage/migrations.ts`.
- [ ] Добавить парсинг `legal_status` в stat.gov collector.
- [ ] Исправить merge: не путать `kfs_name` и `legal_status`.

**Критерий:** один CSV → одна команда → XLSX без ручных шагов между скриптами.

### Этап 2 — Адаптеры и CLI

- [x] `StatGovAdapter`, `ZakupAdapter`, `GoszakupAdapter` в `src/adapters/`.
- [x] Команда `kz enrich` в `cli.ts`.
- [x] Кэш stat.gov с TTL.
- [x] Агрегаты тендеров на карточке компании.
- [x] XLSX export: Companies / Tenders / Summary / Errors.

### Этап 3 — goszakup production

- [x] Получить `GOSZAKUP_TOKEN`.
- [x] Пагинация API при > 1 страницы результатов.
- [x] Фильтр «только активные закупки».

### Этап 4 — Продуктовый слой (post-MVP)

- [ ] Связь с `leads` / feeder 2GIS.
- [ ] Telegram-уведомления о новых закупках.
- [ ] Postgres как production backend.
- [ ] Scheduled re-run (cron / Celery-аналог).

---

## 9. Переменные окружения

| Переменная | Обязательность | Описание |
|---|---|---|
| `GOSZAKUP_TOKEN` | Для goszakup | Bearer token Минфина РК |
| `STAT_GOV_SESSION_PATH` | Опц. | Путь к session JSON (default: `data/stat-gov-session.json`) |
| `STORAGE_BACKEND` | Опц. | `sqlite` (default) / `postgres` |
| `POSTGRES_CONNECTION_STRING` | При postgres | Connection string |
| `KZ_ENRICH_DELAY_MS` | Опц. | Пауза между БИН (default: 2000) |
| `STAT_GOV_CACHE_TTL_DAYS` | Опц. | default: 7 |

---

## 10. Критерии приёмки MVP v2

Проект v2 считается принятым, если:

1. Оператор выполняет `kz login` и получает валидную сессию stat.gov.
2. На входе CSV из ≥ 10 реальных БИН (тестовый набор согласуется).
3. **stat.gov:** для ≥ 80% БИН успешно заполнены `bin`, `name`, `oked`, `oked_name`, `director`, `legal_status`.
4. **zakup.sk.kz:** для ≥ 70% компаний с непустым названием выполняется поиск; найденные закупки сохраняются с `source=zakup.sk.kz`.
5. **goszakup.gov.kz:** при наличии токена — данные по БИН сохраняются; без токена — graceful skip с логом.
6. Дедупликация закупок по `(source, bin, tender_number)`.
7. Экспорт XLSX открывается в Excel/LibreOffice; листы `Companies`, `Tenders`, `Summary` заполнены.
8. Миграции БД версионированы; чистый клон + `npm install` + миграции → рабочая схема.
9. Unit-тесты парсеров проходят (`npm test`).
10. README / `docs/TZ_v2.md` / `docs/TENDERS.md` актуальны.
11. В репозитории нет секретов и session-файлов.

---

## 11. Текущее состояние (gap analysis)

Снимок на 2026-06-07 — что уже есть vs что требует v2:

| Требование v2 | Статус | Где сейчас |
|---|---|---|
| stat.gov login | ✅ | `scripts/stat-gov-login.ts` |
| stat.gov collect | ✅ частично | `scripts/stat-gov-collector.ts` — нет `legal_status` |
| zakup collect | ✅ | `scripts/zakup-collector.ts` |
| goszakup collect | ✅ код | `scripts/tenders-collector.ts` — нужен token |
| unified tenders CLI | ❌ | два скрипта, разные схемы |
| migrations for kz tables | ❌ | CREATE TABLE в скриптах |
| legal_status parse | ❌ | поле в types, не в collector |
| merge stat → leads | ✅ частично | `merge-stat-gov-data.ts` — баг с legal_status |
| export kz package | ❌ | legacy exporter для 2GIS leads |
| platform adapters | ❌ | только scripts |
| tests for kz parsers | ❌ | нет dedicated tests |

---

## 12. Связь с ТЗ v1.7

| Компонент v1.7 | Статус в v2 |
|---|---|
| 2GIS Adapter | Feeder / legacy, не в MVP |
| Kaspi + enrichment | Feeder / legacy |
| JobManager, Queue | Переиспользовать для batch БИН (этап 2+) |
| IStorage, migrations | **Обязательно** расширить под v2 |
| Proxy rotator | Для zakup Playwright при блокировках |
| Telemetry | Расширить метриками kz pipeline |
| Lead scoring / CRM | Вне scope v2 |

---

## 13. Definition of Done (задача)

Каждая задача по v2 считается завершённой при:

- код в `src/` (не только `scripts/`), кроме явно помеченных spike;
- миграция БД при изменении схемы;
- unit-тест на парсер/нормализатор;
- обновление `docs/` при смене CLI или env;
- commit в `develop` (Conventional Commits);
- `npm test` и `npm run lint` без новых ошибок.

---

## 14. Глоссарий

| Термин | Определение |
|---|---|
| БИН | Бизнес-идентификационный номер, 12 цифр |
| ОКЭД | Общий классификатор видов экономической деятельности |
| Feeder | Источник списка компаний (2GIS/Kaspi), не основной реестр |
| CompanyCard | Агрегат stat.gov + метрики закупок |
| Session | Playwright `storageState` после egov QR |

---

*Документ подготовлен на основе фактического состояния репозитория Scrape2Lead и продуктового pivot на stat.gov.kz + tenders. Версия 2.0 заменяет приоритеты разработки v1.7, но не удаляет код и документацию предыдущей версии.*
