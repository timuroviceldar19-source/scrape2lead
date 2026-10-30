# TDD: История отчётов ОП на странице «Реестр ОП» пульта продаж (Этап 2)

## Цель этапа
Расширить страницу `reg.html` пульта продаж F3:
1. Поддержка старых форматов Excel в `parseExcel.ts` (заголовок «Дата договора», файлы без колонки «ИТОГО вал»).
2. Выбор итоговых файлов прошлых месяцев по дате в имени и `UPDATE_TIME` в `diskClient.ts` с кэшированием в Actions (`data/register/history.json`).
3. Блок «По месяцам» (с июля 2026): выручка, вал, маржа, договоры, планы из файлов, по менеджерам.
4. Блок «Есть на портале, нет в реестре»: сверка договоров F3 и партнёров с Zakup API за текущий и прошлый месяцы (три прохода, см. итерацию 6).
5. Блок «Дисциплина реестра»: пропущенные рабочие дни, запоздалые строки (правило — в итерации 6), изменения задним числом, продажи ниже закупа.
6. Сверка с CRM по месяцам: договоры реестра без выигранной сделки за все месяцы (два прохода, см. итерацию 6).
7. Изоляция: данные реестра выводятся строго на `reg.html` (не попадают в payload пульта `index.html` и ТВ `tv.html`).
8. Проверка на контрольных данных и скриншоты десктопной и мобильной версий.

---

## Итерация 1: Разбор старых форматов (`parseExcel.ts`)

### RED
Добавлены тесты в `tests/bitrix/salesPultRegisterParse.test.ts`:
- Тест 1: заголовок «Дата договора» вместо «Дата подписания договора» (формат 01.10–09.10) — парсинг должен успешно находить строку заголовков и дату.
- Тест 2: отсутствие колонки «ИТОГО вал» (формат сентября) — `hasValColumn === false`, `val === null`, маржа не вычисляется спекулятивно.
- Тест 3: сохранение обратной совместимости для стандартного формата (`hasValColumn === true`, `val` число).

### GREEN
- `src/bitrix/salesPult/register/types.ts`: `val: number | null` в `RegisterRow`, `RegisterContract`, `RegisterManagerSummary`, `RegisterMixItem`, `RegisterChannelItem`, `RegisterGroupItem`, `RegisterTotal`. В `RegisterTotal` добавлены `hasVal?: boolean` и `margin?: number | null`.
- `src/bitrix/salesPult/register/parseExcel.ts`:
  - поиск строки заголовка расширен: `val.includes("дата подписания договора") || val === "дата договора" || val.includes("дата договора")`;
  - поиск колонки даты: `findCol("дата подписания договора", "дата договора")`;
  - `hasValColumn: boolean` возвращается в `ParsedRegisterResult`;
  - если колонка вала отсутствует, `val` строк равен `null`, без спекулятивного расчёта «продажа − закуп».
- `src/bitrix/salesPult/register/buildView.ts` и `matchCrm.ts`: адаптированы под `val: number | null`.
- Проверка: `npm run lint` без ошибок, тесты пройдены.

---

## Итерация 2: Модуль истории реестра (`history.ts` и `diskClient.ts`)

### RED
Создан файл тестов `tests/bitrix/salesPultRegisterHistory.test.ts`:
- Тест 1: `getLastDayOfMonth` возвращает точный календарный последний день (28/30/31).
- Тест 2: `buildRegisterMonthSummary` считает итоги месяца, маржу и берёт план из файла.
- Тест 3: `buildRegisterMonthSummary` без колонки вала возвращает `val === null`, `margin === null`, `hasVal === false`.
- Тест 4: `matchPortalContracts1to1` выполняет сопоставление 1-к-1 с порталом, не допуская повторного сопоставления одной строки реестра.
- Тест 5: `detectRegisterDiscipline` вычисляет пропущенные рабочие дни (с учётом праздников), лаг внесения >= 2 рабочих дней и продажи ниже закупа.
- Тест в `salesPultRegisterParse.test.ts`: `pickMonthlyFinalRegisterFiles` выбирает финальные файлы каждого месяца.

### GREEN
- `src/bitrix/salesPult/register/diskClient.ts`: реализованы `pickMonthlyFinalRegisterFiles`, `fetchRegisterFilesFromDisk`, `getFileRevision`.
- `src/bitrix/salesPult/register/history.ts`:
  - `getLastDayOfMonth`: вычисление последнего дня месяца через `Date.UTC(y, m, 0)`;
  - `buildRegisterMonthSummary`: агрегация показателей месяца с декомпозицией по менеджерам и планами из файла;
  - `matchPortalContracts1to1`: сопоставление договоров портала с договорами реестра строго 1-к-1;
  - `detectRegisterDiscipline`: вычисление рабочих дней без отчёта, задержек внесения, продаж ниже себестоимости и правок задним числом.
- Проверка: тесты `salesPultRegisterHistory.test.ts` и `salesPultRegisterParse.test.ts` пройдены, `npm run lint` чистый.

---

## Итерация 3: Подключение истории к `loadRegisterView`, CLI и изоляция данных

### RED
Добавлены тесты в `tests/bitrix/salesPultRegisterHistory.test.ts`:
- Тест: `loadRegisterView` при наличии кэша `historyCachePath` прикрепляет его к `view.history`.
- Тест: строгая изоляция payload — `renderPultHtml` ни при каких условиях не включает данные реестра в DOM и `__PAYLOAD__`, `renderRegisterHtml` корректно отображает `register` и `history`.

### GREEN
- `src/bitrix/salesPult/register/load.ts`:
  - добавлены параметры: `refreshHistory`, `historyCachePath`, `holidays`, `outcomesConfigPath`, `orgsCachePath`, `fetchPortal`;
  - при `refreshHistory` или первом запуске без кэша формируется история и сохраняется в `historyCachePath` (`data/register/history.json`);
  - в регулярных вызовах данные читаются из кэша с graceful fallback при его отсутствии;
- `scripts/sales-pult.mts`:
  - добавлены CLI-флаги `--refresh-history`, `--history-cache`;
  - передача параметров в `loadRegisterView`.
- Проверка: тесты пройдены, `npm run lint` без ошибок.

---

## Итерация 4: Отображение 4 новых блоков на `reg.html` (`register.client.js`, `pult.css`)

### Реализация
- `src/bitrix/salesPult/page/register.client.js`:
  - Блок 06 «История по месяцам»: таблица помесячно (выручка, вал, маржа, договоры, план из файла, % плана) с интерактивным раскрытием разбивки по менеджерам каждого месяца.
  - Блок 07 «Есть на портале, нет в реестре»: плашки с помесячными счётчиками F3 и партнёров и таблица пропущенных договоров за текущий и прошлый месяцы с реквизитами.
  - Блок 08 «Дисциплина ведения реестра»: карточки сводных метрик (пропуски рабочих дней, запоздалые строки, продажи ниже закупа, правки задним числом), чипсы пропущенных дат, разбивка задержек по менеджерам, таблицы убыточных сделок и правок.
  - Блок 09 «Сверка с CRM за прошлые месяцы»: помесячная детализация договоров реестра прошлых месяцев, не найденных в CRM в статусе «Выигран».
- `src/bitrix/salesPult/page/pult.css`:
  - Стили для таблиц `.hist .r`, `.portal-miss .r`, карточек дисциплины и чипсов.
  - Адаптивные правила для мобильных экранов (`@media (max-width: 760px)`).
- `src/bitrix/salesPult/page/reg.client.js`:
  - Обработчик клика расширен для аккордеонов строк `.r.body[role="button"]`.

---

## Итерация 5: Синтетический контрольный пример и скриншоты

### Синтетический контрольный пример
Контрольная проверка на синтетическом тестовом наборе. Правила сопоставления с порталом и опоздания строк, действовавшие на этой итерации, позже заменены — действующие описаны в итерации 6.
- **Месяц 1** (`ОП Синтетик 1.xlsx`): Выручка 10 000 000 ₸, Вал 2 500 000 ₸, маржа 25%, план 12 000 000 ₸.
- **Месяц 2** (`ОП Синтетик 2.xlsx`): Выручка 15 000 000 ₸, Вал null (отсутствует колонка в файле), план 15 000 000 ₸.
- **Портал Zakup API помесячно (синтетический пример)**:
  - Тестовый поставщик 1: 5 договоров, Тестовый партнёр: 2 договора.
  - Сопоставление 1-к-1: допуск по сумме <= 3%, тот же или соседний месяц.
- **Дисциплина ведения реестра**:
  - Пропущено рабочих дней: 1 день.
  - Запоздалые строки (лаг >= 2 рабочих дней): 2 строки.
  - Продажи ниже себестоимости: 1 сделка.
  - Правок задним числом: 3 изменения.

### Скриншоты
С использованием Playwright сформированы скриншоты страницы `reg.html`:
- Десктопная версия (1440x900): `exports/sales-pult/reg-desktop.png`
- Мобильная версия (375x812): `exports/sales-pult/reg-mobile.png`

На этой итерации прошли все тесты (130 файлов, 1442 теста), включая Playwright-тесты в браузере (`salesPultBrowser.test.ts`).

---

## Итерация 6: Правила сверки после проверки на живых данных

Первые версии на живых данных давали ложные расхождения:
- сделку следующего месяца забирал договор прошлого;
- одна строка реестра не сводилась с несколькими договорами портала;
- строка считалась опоздавшей, когда за пропущенные дни просто не было файла.

Ниже — правила, которые действуют сейчас. Живые суммы и названия в репозиторий не попадают, все примеры придуманы.

### Блок 09: сверка реестра с CRM по месяцам
- Выигранная сделка — это переход в стадию договора из `stages.contracts` (`C9:WON`, `C41:WON`, `C43:WON`) по `crm.stagehistory.list` через `listAllBatched`, без потолка в 50 сделок.
  - Месяц сделки — месяц перехода по времени Алматы.
  - Переходы в другие воронки (`C1:WON`, `C29:WON`) не считаются.
  - Набор сделок и сопоставитель те же, что в блоке 04, поэтому текущий месяц в блоке 09 совпадает с блоком 04.
- Сверка идёт в два прохода (`reconcileRegisterWithCrmAcrossMonths`):
  1. договоры месяца M сопоставляются только со сделками месяца M;
  2. оставшиеся договоры месяца M — с оставшимися сделками месяца M+1. Например, договор от 30.09 закрывается сделкой от 02.10, если её не забрал октябрьский договор.
- Если файла реестра за M+1 ещё нет (первые дни месяца), сделки M+1 всё равно берутся из CRM: месяц сегодняшнего дня по Алматы всегда входит в выборку (`load.ts`).
- Пару запрещают разные номера учреждения в названиях: «Ясли-сад №5» не сводится со сделкой «Ясли-сад №14».
  - Номер берётся после `№`, `#`, отдельной заглавной латинской `N` или после слов «школа», «ясли-сад», «гимназия», «лицей» и подобных, даже без знака.
  - Границы номера — `(?<![\p{L}\d])…(?![\p{L}\d])` с флагом `u`: `\b` в JS не видит границ кириллических слов, а «n 2026» номером не считается.

### Блок 07: договоры портала, которых нет в реестре
- Договоры F3 и партнёров берутся из открытого API `zakup.gov.kz` по организации поставщика.
  - Организация ищется по точному совпадению БИН из `config/gz-deal-outcomes.json` (`ourBins`, `partnerBins`); первый результат поиска без проверки БИН не берётся.
  - Договоры в статусах ЭГЗ 455 «Изменен», 350 и 340 «Расторгнут» исключаются по справочнику статусов. Справочник не загрузился — построение прерывается.
  - F3 и партнёр считаются по организации, а не по названию.
- Сопоставление идёт в три прохода (`matchPortalContracts1to1`). Сумма договора портала должна отличаться от суммы реестра, умноженной на 1; 1,12 или 1,16 (НДС), не больше чем на 3 %.
  1. **1-к-1 в том же месяце**, схожесть названия заказчика ≥ 0,5. Из нескольких кандидатов берётся пара с меньшим отклонением, затем с ближайшей датой.
  2. **По сумме заказчика на остатках.** Договоры портала одного заказчика (схожесть ≥ 0,75) в окне 14 дней собираются в группу. Сумма группы сравнивается с суммой строк реестра того же заказчика в этом окне или с одной такой строкой. Проход срабатывает, только если хотя бы с одной стороны больше одного документа.
  3. **1-к-1 с соседним месяцем** на том, что осталось.
- Соседний месяц идёт последним, потому что иначе договор следующего месяца с отклонением в 1–2 % забирает строку, которую точно закрывает группа договоров её собственного месяца. Пример из теста:
  - строка реестра от 15.09 на 500 000;
  - три договора от 16.09: 100 000 + 280 000 + 200 000 = 580 000 = 500 000 × 1,16;
  - договор от 13.10 на 553 000 подходит к этой строке с отклонением 1,25 % (×1,12).

  Строка закрывает три сентябрьских договора, а октябрьский остаётся для своего прохода.

### Блок 08: запоздалые строки
- Строка с датой D опоздала, только если есть файл реестра с датой от следующего рабочего дня после D до дня, когда строка впервые появилась, и в этом файле строки нет. Если промежуточных файлов нет, опоздание не засчитывается: такой день уже виден как пропущенный рабочий день.
- Не считаются:
  - строки первого файла истории — это база;
  - правленые строки: тот же заказчик и товар с новой суммой;
  - строки старше прошлого месяца.

### Кэш истории и ошибки
- История шифруется AES-256-GCM ключом из секрета `REGISTER_HISTORY_KEY` и хранится в `data/register/history.json` (кэш Actions). Без ключа история не строится, в логе — предупреждение.
- История перестраивается, если:
  - кэша нет;
  - кэш старше 20 часов;
  - это первый запуск после 08:00 Алматы, а кэш собран до 08:00;
  - передан флаг `--refresh-history`.

  В остальные 15-минутные прогоны кэш только читается.
- Сбой CRM, справочника статусов или портала прерывает построение истории:
  - старый кэш не перезаписывается;
  - попытка с текстом ошибки записывается в `data/register/last_attempt.json`;
  - повтор — не раньше чем через час, а пока он отложен, ошибка видна на странице рядом с датой кэша (по Алматы).
- Файл на Диске без `DOWNLOAD_URL` попадает в `failedFiles` и не пропадает молча.

### RED
Тесты, добавленные под эти правила (по одному на правило):
- `tests/bitrix/salesPultFetchCrmWon.test.ts`:
  - `fetches > 50 won deals using listAllBatched and stages.contracts without 50-limit capping`;
  - `ignores transitions into stages not in stages.contracts (e.g. C1:WON, C29:WON)`;
  - `throws an error when crm.stagehistory.list fails for any stage`;
  - `deal from October whose amount is close to September contract goes to October when October contract exists`;
  - `deal from 02.10 closes contract from 30.09 if no October contract exists`;
  - `matches contracts of month M with deals of month M+1 even when month M+1 has no register file yet (Block 09)`;
  - `gives identical matching result for October as block 04 when given October transitions`.
- `tests/bitrix/salesPultRegisterMatch.test.ts`:
  - `does not match when both customer and deal have institution numbers that do not match (e.g. Ясли-сад №5 vs Ясли-сад №14)`;
  - `extracts institution number from named entity without № symbol (e.g. школа 5)`;
  - `does not treat latin lowercase n in words or 'n 2026' as entity number`.
- `tests/bitrix/salesPultRegisterHistory.test.ts`:
  - `closes two portal contracts against one register row when their sum equals row * 1.16`;
  - `leaves customer portal contracts unmatched when their sum is outside 3% tolerance`;
  - `does not group or sum contracts of different customers even if sum matches`;
  - `prioritizes customer sum match over next-month 1-to-1 match (Block 07 Pass Order)`;
  - `rejects portal contract match when register row is 2 months apart`;
  - `does not flag row as late when files for intermediate working days are missing and row first appears later`;
  - `flags row as late when an intermediate working day file exists and row was absent in it`;
  - `searchOrganizationByBin matches exact BIN only, returns null on inexact match without taking results[0]`;
  - `fetchPortalContractsForMonths throws an exception when contract statuses dictionary fails to load`;
  - `loadRegisterView: does not overwrite cache when CRM/portal throws, records attempt as failed, and shows old cache with error`;
  - `loadRegisterView: displays error from last_attempt.json when retry is suppressed (< 1 hour)`;
  - `fetchRegisterFilesFromDisk captures candidate files without DOWNLOAD_URL into failedFiles`;
  - `calculates default todayAlmaty in Asia/Almaty (UTC+5) rather than UTC`.

### GREEN
- `fetchCrmWon.ts`: выигрыши по `crm.stagehistory.list` и стадиям договоров; ошибка по любой стадии пробрасывается.
- `matchCrm.ts`: `extractEntityNumbers`, `hasConflictingEntityNumbers`, запрет пары с разными номерами.
- `history.ts`:
  - `reconcileRegisterWithCrmAcrossMonths` — два прохода;
  - `matchPortalContracts1to1` — три прохода;
  - `getNextWorkingDay` и правило промежуточного файла в `detectRegisterDiscipline`;
  - точный БИН в `searchOrganizationByBin`.
- `load.ts`: месяц сегодняшнего дня в выборке CRM, `getAlmatyToday`, ошибка последней попытки на странице.
- `crypto.ts`: правило перестройки кэша и запись `last_attempt.json`.
- `diskClient.ts`: файлы без `DOWNLOAD_URL` — в `failedFiles`.

### Проверка
- `npm run lint` — без ошибок.
- `npx vitest run` — 130 файлов, 1480 тестов (9 пропущены).
- `scripts/sales-pult.mts --mode site` с тестовым ключом на живых данных (Bitrix и портал только на чтение): без кэша около 2 минут, с кэшем около 1,5 минуты. Цифры по блокам остаются локально и в репозиторий не записываются.

---

## Исправление 30.10.2026: поиск организации поставщика по БИН

- Первый прогон в Actions после слияния завершился ошибкой «Не найдена организация поставщика группы F3 (БИН …) на портале zakup.gov.kz». Локально ошибки не было: id организаций F3 и партнёра брались из `data/market/orgs.json`, и поиск по БИН не вызывался.
- Причина: `searchOrganizationByBin` ждал страницу `{ results: [...] }` с полем `bin`, а `/public/organizations/?q=<БИН>` отвечает массивом, и БИН лежит в поле `iin_bin`. Функция всегда возвращала `null`.
- RED: тест `searchOrganizationByBin reads the live response shape: a plain array with the BIN in iin_bin` на ответе в живом формате (данные придуманы) — `expected null to be 12345`.
- GREEN: функция принимает массив, а на случай пагинации и страницу, и сравнивает БИН по `iin_bin`. Старый тест переведён на поле `iin_bin`.
- Проверка на живом API без кэша организаций: `resolveGroupSupplierOrgIds` находит F3 и партнёра.
