# TDD: Пульт — группа F3 и Amanat Asia на вкладках рынка, договоры с портала и долги

## Контекст и цели
1. **Amanat Asia на вкладках рынка:**
   - До июня в ИП и до июля в КТ группа продавала только через Amanat Asia (БИН `130540000688`).
   - На пульте на вкладках «Рынок ИП» и «Рынок КТ» в графике «По месяцам» наша доля теперь разделена на две компании: F3 (`#141414`) и Amanat Asia (`#55534e`) с соответствующими квадратами в легенде.
   - Список компаний и их порядок берутся из `ourBins` в `config/market-monitor.json`.
   - В блок 01 добавлен блок «С начала года»:
     - ИП: F3 — 383,0 млн (14,9%), Amanat Asia — 95,1 млн (3,6%), группа — 478,1 млн (18,5%, 1 место).
     - КТ: F3 — 276,1 млн (1,3%), Amanat Asia — 479,5 млн (2,2%), группа — 755,6 млн (3,5%, 6 место).
   - Браузерный тест в `tests/bitrix/salesPultBrowser.test.ts`: на КТ в январе видна доля Amanat Asia (высота столбика > 0, F3 = 0), в октябре — обе компании > 0.

2. **Договоры на пульте: выигранные на портале и долги менеджеров:**
   - Договорами теперь считаются сделки:
     - перешедшие на стадию «выиграно» в CRM (`contractTransitions`);
     - ИЛИ имеющие маркер `UF_CRM_S2L_GZ_OUTCOME`, начинающийся с `won:` или `partner:`.
   - Период/дата договора определяется по дате подписания на портале (извлекается из комментариев к сделке вида `договор №... от DD.MM.YYYY`).
   - Если сделка имеет дату подписания на портале, она учитывается именно на эту дату, исключая повторный учёт в день перевода стадии в CRM.
   - У менеджера в долгах отображается `wonOnPortalNotClosed`: «выиграно на портале, не закрыто в CRM: N сделок» (сделки в работе `semantic: P` с маркером `won:` / `partner:`).
   - Сделки с маркером `won:` / `partner:`, закрытые со стадией проигрыша/дубликата (`semantic: F`), собираются в `outcomeMismatches` как ошибка CRM, формируют срочный сигнал в «02 Требует внимания» и отображаются в блоке ошибок с прямыми ссылками на сделки в CRM.
   - CRM остаётся strictly read-only: стадии сделок не изменяются.

## Ход TDD

### Фаза 1: Amanat Asia и F3 на вкладках рынка
- **RED 1**: Добавлены проверки в `tests/kz/marketAggregate.test.ts` на расчёт `ourCompanies` по месяцам (в январе только Amanat Asia, в октябре обе) и расчёт структуры `ytd` (сумма группы, доля, рейтинг среди поставщиков, разбивка по компаниям).
- **GREEN 1**:
  - `src/kz/market/types.ts`: добавлены интерфейсы `MarketCompanyItem`, `MarketMonthCompanyItem`, `MarketYtdCompanyItem`, `MarketYtdView`, обновлены `MarketMonthItem` и `MarketGroupView`.
  - `src/kz/market/aggregate.ts`: реализована функция `getOurCompaniesList`, формирование `ourCompanies` по каждому месяцу и расчёт `ytd` по текущему году.
  - `tests/kz/marketAggregate.test.ts`: 6/6 тестов прошли.
- **RED 2**: Обновлён `tests/bitrix/salesPultBrowser.test.ts`: добавлены сделки января и октября для КТ, проверки высоты столбиков `.our.our-0` (F3) и `.our.our-1` (Amanat Asia), легенды и блока YTD.
- **GREEN 2**:
  - `src/bitrix/salesPult/page/market.client.js`: отрисовка стека компаний в столбиках месяцев, легенда с цветовыми плашками, блок «С начала года».
  - `src/bitrix/salesPult/page/pult.css`: классы `.our-0`, `.our-1`, `.sq.our-0`, `.sq.our-1`.
  - В браузере добавлен ступенчатый скролл для гарантированного срабатывания `IntersectionObserver`.
  - `tests/bitrix/salesPultBrowser.test.ts`: 3/3 теста прошли в headless Chromium.

### Фаза 2: Договоры с портала, долги менеджеров и ошибки CRM
- **RED 3.1**: `tests/bitrix/salesPultMetrics.test.ts` — тест на учёт сделок `won:` и `partner:` по `portalSignDate`, дедупликацию со сделками перехода в CRM и исключение проигранных сделок `stageSemanticId: 'F'`.
- **RED 3.2**: `tests/bitrix/salesPultDebts.test.ts` — тест на форматирование долга `wonOnPortalNotClosed` с правильным склонением («1 сделка», «3 сделки», «5 сделок») в красный цвет.
- **RED 3.3**: `tests/bitrix/salesPultCollect.test.ts` — тест на функцию `parsePortalSignDate` (извлечение даты из комментариев `от DD.MM.YYYY` в `YYYY-MM-DD`), загрузку `won:`/`partner:` сделок, формирование `outcomeMismatches` и подсчёт `wonOnPortalNotClosed`.
- **RED 3.4**: `tests/bitrix/salesPultPace.test.ts` — тест на генерацию срочных красных сигналов в `buildPultSignals` для `wonOnPortalNotClosed` и `outcomeMismatches`.
- **GREEN 3**:
  - `src/bitrix/salesPult/types.ts`: расширен `DealInfo`, добавлен `WonLostMismatchDeal`, добавлен `outcomeMismatches` в `SalesPultPayload`.
  - `src/bitrix/salesPult/debts.ts`: добавлен `wonOnPortalNotClosed` в `ManagerDebts` и `EMPTY_DEBTS`.
  - `src/bitrix/salesPult/format.ts`: добавлено форматирование долга `выиграно на портале, не закрыто в CRM: N сделок`.
  - `src/bitrix/salesPult/metrics.ts`: обновлена функция `calculateDailyMetrics` для включения выигранных на портале договоров на дату их подписания без дублирования.
  - `src/bitrix/salesPult/signals.ts`: добавлены сигналы для долгов по договорам портала и ошибок закрытия сделок в проигрыш.
  - `src/bitrix/salesPult/collect.ts`: экспорт `parsePortalSignDate`, выборка сделок с `UF_CRM_S2L_GZ_OUTCOME`, пакетное чтение комментариев для выявления даты подписания, классификация `outcomeMismatches` и назначение долгов менеджерам.
  - `scripts/sales-pult.mts`: передача `outcomeMismatches` в `SalesPultPayload`.
  - `src/bitrix/salesPult/page/pult.client.js`: отображение долга в карточках и деталях менеджеров, рендеринг предупреждающего блока ошибок CRM в секции «02 Требует внимания».

### Фаза 3: Замечания ревью и доработка
- **Устранение критических замечаний (Blockers)**:
  - Добавлена вспомогательная функция `ddmm(iso)` в `src/bitrix/salesPult/page/pult.client.js`, предотвращающая `ReferenceError: ddmm is not defined`.
  - Ссылки на сделки исправлены функцией `dealUrl(id)` (`(P.portal ? P.portal.replace(/\/+$/, '') : '') + "/crm/deal/details/" + encodeURIComponent(id) + "/"`), предотвращая двойной префикс `https://https://`.
- **Согласование текста сигналов**:
  - `src/bitrix/salesPult/signals.ts`: исправлено дублирование числа в `pluralNbsp`, согласовано множественное число: `<b>Ошибка в CRM:</b> ${dealsWord} на портале, но ${closedWord}`.
  - Исправлен сигнал долга менеджера: `<b>${name}</b>: выиграно на портале, не закрыто в CRM — ${dealsWord}`.
- **Исключение дубликатов из ошибок CRM**:
  - В `src/bitrix/salesPult/collect.ts` стадии, содержащие `DUPLICATE` или `DOUBLE` (например `C41:DUPLICATE`), исключены из `outcomeMismatches`, так как дубликаты закономерно закрываются со статусом проигрыша.
- **Единицы измерения на рынке ИП**:
  - В `src/bitrix/salesPult/page/market.client.js` для ИП заголовок установлен в простой текст `"млн ₸"` без двойных спанов, исключая наложение «млн ₸млн ₸».
  - В `src/bitrix/salesPult/page/pult.css` добавлены правила сокрытия `.mobile` на десктопе и `.desktop` на мобильных экранах для `.block-head .meta`.
- **Точность извлечения даты подписания договора**:
  - В `src/bitrix/salesPult/collect.ts` парсинг даты из комментариев строго ограничен комментариями, начинающимися со слова «итог закупки», с отказом от фоллбека на `CLOSEDATE`.
- **Браузерное тестирование**:
  - Добавлен 4-й тест в `tests/bitrix/salesPultBrowser.test.ts`: проверка открытия главной вкладки пульта с `outcomeMismatches`, проверка отсутствия ошибок в консоли браузера, отрисовка блока ошибок с датой в формате `от DD.MM` и корректным одиночным `https://` в ссылках на CRM.

### Фаза 4: Устранение замечаний круга 2
- **Единицы КТ на ширине 481–760 px**:
  - В `src/bitrix/salesPult/page/pult.css` граница медиа-запроса для `.block-head .meta .mobile` / `.desktop` перенесена с `760px` на `480px`. Теперь и заголовок («млн ₸» / «млрд ₸»), и подписи столбиков синхронно переключаются ровно на 480 px (на 627 px — миллионы в обоих местах).
- **Телефон, блок «Ошибка в CRM»**:
  - Стили блока `.mismatches-box` перенесены из inline-атрибутов в `src/bitrix/salesPult/page/pult.css`.
  - Добавлены семантические классы `.box-title`, `.box-desc`, `.mismatches-list`, `.mismatch-row`, `.info`, `.deal-link`, `.mgr`, `.meta`.
  - В мобильном медиа-запросе `@media (max-width: 760px)` для `.mismatch-row` задано `flex-direction: column; align-items: flex-start; gap: 6px;`, `.meta { white-space: normal; }` и уменьшен padding карточки до `14px`.
  - Сумма и дата теперь переносятся под название сделки на узких экранах, предотвращая сужение заголовка и вылезание за край карточки на 20 px.
- **Чистка форматирования**:
  - Исправлены отступы в `src/bitrix/salesPult/signals.ts` (блок долга по договорам портала и сигнал ошибок CRM).
- **Браузерные тесты**:
  - В `tests/bitrix/salesPultBrowser.test.ts` добавлены тесты:
    1. Переключение единиц КТ: на ширине 627 px — `.desktop` («млн ₸» и миллионы на столбиках), на ширине 400 px — `.mobile` («млрд ₸» и миллиарды на столбиках).
    2. Адаптивность блока ошибок CRM на телефоне (375 px): `flexDirection: column`, блок суммы/даты строго ниже заголовка сделки, отсутствие горизонтального вылезания за пределы карточки.

## Верификация
- `npm run lint` (`tsc --noEmit`): 0 ошибок.
- `npm run build`: успешно собран dist (`tsc -p tsconfig.json`).
- `npm test`: 127 тестовых файлов прошли, 1389 тестов успешно выполнены (все 4 браузерных теста Playwright в Chromium).

## Живой прогон (29.10, `--mode site`, без выкладки)
- Договоров за октябрь на пульте стало 94 (было 89): добавились сделки с отметкой `won:`/`partner:`, подписанные на портале в октябре. Сделки, подписанные раньше, ушли в месяц подписания.
- У всех 28 сделок `won:`/`partner:` дата подписания найдена в комментарии «Итог закупки»; до октября подписана большая часть суммы, поэтому октябрь вырос мало.
- Ошибка в CRM одна: сделка с действующим договором на портале стоит на стадии проигрыша. Две сделки на стадии «Дубликат» в список не попали.
- Долг «выиграно на портале, не закрыто в CRM» есть у четырёх менеджеров, всего 12 сделок.
