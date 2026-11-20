# TDD: Радар в Пульте продаж F3 и обновление статусов/сроков лотов в Bitrix24

## Контекст и цели

Сборщик лотов `config/gz-lots-computers.json` и планов `scrape2lead-gz-plans` собирает данные госзакупок в Bitrix24.
В текущей реализации:
1. `scripts/bitrix-push-gz-lots.mts` пропускает существующие сделки воронки 43 (`gz-lot:`), не обновляя статус и сроки при переходе из `Опубликован` в `Опубликован (прием заявок)`.
2. Завершённые и несостоявшиеся закупки выпадают из поисковых выборок сборщика, и открытые сделки в воронке 43 навсегда «зависают» в старых статусах.
3. В Пульте продаж F3 отсутствует единый оперативный экран («Радар») для быстрой подачи заявок, подачи замечаний по ТЗ и отработки несостоявшихся закупок («Второй шанс»).
4. В текущем клиенте Пульта есть два мелких бага: не анимируются звонки при переключении периода в `#calls`, и в реестре слипаются цифры выручки и маржи.

## Архитектура решения

1. **Обновление существующих сделок (`scripts/bitrix-push-gz-lots.mts`, `src/bitrix/gzLotDates.ts`):**
   - Выборка полей существующей сделки: `["ID", "COMPANY_ID", "STAGE_SEMANTIC_ID", "CLOSED", "DATE_CREATE", "BEGINDATE", "CLOSEDATE", "COMMENTS", "UF_CRM_6627AEBD85B4D"]`.
   - Проверка открытости сделки (`STAGE_SEMANTIC_ID !== "S" && STAGE_SEMANTIC_ID !== "F" && CLOSED !== "Y"`).
   - Сравнение статуса (`row.status`) и дат (`isPlaceholderWindow` / наличие строки `Приём заявок:` в `COMMENTS`).
   - Обновление полей в сделке Bitrix24 при `--execute` или dry-run лог.

2. **Синхронизация открытых сделок воронки 43 (`src/bitrix/gzLotSync.ts` + флаг `--sync-open`):**
   - Чтение открытых сделок воронки 43 (`STAGE_SEMANTIC_ID = "P"`, `ORIGINATOR_ID = "scrape2lead-gz-lots"`).
   - Запрос текущего статуса и дат через публичный API zakup (`/public/lots/`) с fallback на GraphQL `Lots`.
   - Обновление статуса и дат в Bitrix24 при обнаружении изменений.

3. **Модуль Радара (`src/bitrix/salesPult/radar/`):**
   - `types.ts`: интерфейсы карточки (`RadarCard`), групп (`RadarGroupView`), KPI (`RadarKpis`), сводки (`RadarView`).
   - `collect.ts`: загрузка сделок воронки 43 и планов из 9, 41, 29 через ReadOnlyBitrixClient.
   - `aggregate.ts`: категоризация по 3 колонкам (`01 Подать сегодня`, `02 Успеть с замечанием`, `03 Второй шанс`), расчет KPI, дедупликация планов и лотов, сортировка.

4. **UI Радара (`pult.html`, `radar.client.js`, `pult.client.js`, `pult.css`, `site.ts`):**
   - Навигация: ссылка «Радар» между «Сегодня» и «Выручка» (`#radar-ip` / `#radar-kt`).
   - 4 KPI плитки вверху.
   - Фильтры по менеджеру, способу закупки, поисковая строка.
   - Сетка из 3 колонок с карточками (таймер окончания, сумма, заказчик, метки рынка, ссылки на CRM и ЭГЗ).
   - Интеграция в быстрый поиск `⌘K` / `/`.

5. **Фиксы багов:**
   - Вызов `animate(document.getElementById("calls"))` в конце `renderCalls()`.
   - Форматирование подписи в блоке «03 Что и как продаём» в `register.client.js`.

---

## План TDD

### Фаза 1: RED (тесты)
1. `tests/bitrix/gzLotPushUpdate.test.ts`:
   - Тест формирования пакета обновлений существующей сделки по лоту при смене статуса.
   - Тест обновления дат и комментария `Приём заявок:`.
   - Тест неизменности сделки, если статус и даты совпадают.
   - Тест синхронизации статуса завершённого / несостоявшегося лота через zakup API.
2. `tests/bitrix/salesPultRadar.test.ts`:
   - Тест парсинга карточек из сделок лотов и планов.
   - Тест классификации товарных групп (ИП/КТ) и видов (`kind`).
   - Тест распределения по 3 колонкам (`submitToday`, `discussion`, `secondChance`).
   - Тест дедупликации лотов и планов во «Втором шансе» по номеру пункта плана `^\d+`.
   - Тест расчета KPI плиток.
3. `tests/bitrix/salesPultRadarBrowser.test.ts`:
   - Playwright-тест отображения вкладок `#radar-ip` и `#radar-kt`.
   - Проверка переключателя товаров и скрытия периодов с сохранением «Я — …».
   - Проверка 3 колонок, карточек, бейджей времени, меток рынка.
   - Проверка кнопки «Показать все».
   - Проверка быстрого поиска (`⌘K`).
   - Проверка вызова `animate` в `#calls` и текста маржи в `register.client.js`.

### Фаза 2: GREEN (реализация)
1. Исправление 2 багов (`renderCalls`, `register.client.js`).
2. Доработка `scripts/bitrix-push-gz-lots.mts` и `src/bitrix/gzLotSync.ts`.
3. Создание `src/bitrix/salesPult/radar/types.ts`, `collect.ts`, `aggregate.ts`.
4. Интеграция в `scripts/sales-pult.mts` и `SalesPultPayload`.
5. Создание `src/bitrix/salesPult/page/radar.client.js` и обновление `pult.html`, `pult.client.js`, `pult.css`, `site.ts`.

### Фаза 3: REFACTOR и верификация
1. Прогон `npm test`, `npm run lint`, `npm run build`.
2. Проверка соответствия `AGENTS.md`.

## Результаты верификации тестов

1. **`tests/bitrix/gzLotPushUpdate.test.ts`**:
   - `✓ evaluateLotDealUpdate > leaves unchanged deal alone (action: none)`
   - `✓ evaluateLotDealUpdate > links company if only companyId is missing (action: link_company)`
   - `✓ evaluateLotDealUpdate > updates deal when portal status changed`
   - `✓ evaluateLotDealUpdate > updates placeholder dates with real bid window`
   - `✓ evaluateLotDealUpdate > ignores closed deals (F or S semantic)`
   - `✓ updateLotComments > adds or replaces bid window line and status line`
   - `✓ fetchLotStatusAndWindow > extracts current portal status and offer dates from public API`
   - **Результат: 7/7 passed.**

2. **`tests/bitrix/salesPultRadar.test.ts`**:
   - `✓ parses lot deals from funnel 43 and categorizes into IP submitToday/discussion`
   - `✓ assigns secondChance for failed lots and failed plans with deduplication`
   - `✓ filters out closed deals and handles missing manager`
   - `✓ calculates radar KPIs correctly`
   - **Результат: 4/4 passed.**

3. **`tests/bitrix/salesPultRadarBrowser.test.ts`**:
   - `✓ renders 'Радар' nav link between 'Сегодня' and 'Выручка'`
   - `✓ navigates to #radar-ip, displays 4 KPI tiles, 3 columns, and controls`
   - `✓ quick search (⌘K / /) indexes radar lots`
   - `✓ calls animate(document.getElementById('calls')) on period switch so data-count animates`
   - `✓ fixes register gross/sale text formatting without glued numbers`
   - **Результат: 5/5 passed.**

4. **Регрессионное тестирование UI и браузерных тестов**:
   - `tests/bitrix/salesPultFourTabs.test.ts`: 4/4 passed (проверено адаптивное отображение 5 разделов шапки на 1440px и 375px).
   - `tests/bitrix/salesPultBrowser.test.ts`: 24/24 passed.
   - `tests/bitrix/salesPultPlansLostTo.test.ts`, `tests/bitrix/salesPultPlansFilters.test.ts`, `tests/bitrix/salesPultPlansMonitor.test.ts`, `tests/bitrix/salesPultMarketMonthSwitcher.test.ts`, `tests/bitrix/salesPultPlanWinShare.test.ts`, `tests/bitrix/salesPultMarketEducation.test.ts`, `tests/bitrix/salesPultTabs.test.ts`: 75/75 passed.

5. **Линтинг и компиляция**:
   - `npm run lint` (`tsc -p tsconfig.json --noEmit`): 0 ошибок.
   - `npm run build` (`tsc -p tsconfig.json`): 0 ошибок.

