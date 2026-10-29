# Пульт продаж: исходы закупок в долгах, прошедший месяц плана, единый порядок, 30+ дней и контроль связи после срока (TDD)

## Контекст

По итогам аудита пульта продаж (этап 1) выявлены 6 точек расхождения между данными портала / CRM и отображением долгов и реестра на пульте:

1. **Итог закупки в долгах (`debts.ts`, `collect.ts`):** открытые сделки, по которым на портале госзакупок закупка уже завершилась проигрышем, не состоялась, отменена, перепрофилирована или расторгнута (`lost`, `failed`, `cancelled`, `repurposed`, `terminated` в `UF_CRM_S2L_GZ_OUTCOME`), оставались в `overdue`, `new` и `Top-5` срочных задач. При этом статус «Проект договора» уже переводил дело в `passed` («Пора закрыть»), а `won` / `partner` отдельно считались в `wonOnPortalNotClosed`.
2. **Прошедший месяц плана (`debts.ts`, `collect.ts`, `pult.client.js`):** для сделок со статусом плана «Утвержден», у которых месяц в поле `UF_CRM_1715597726664` («Планируемый срок закупки», русское название месяца) раньше текущего месяца, не было визуальной метки, и такие дела конкурировали наравне с актуальными планами текущего/будущих месяцев.
3. **Единый порядок сортировки (`debts.ts`, `pult.client.js`):** `debts.ts` отбирал `Top-5` по правилу `группа → сумма DESC → срок ASC`, а клиентский `pult.client.js` пересортировывал карточки по `overdueDays DESC`, из-за чего порядок задач в блоке «Что сделать сегодня» расходился с правилом отбора.
4. **Дела старше 30 дней (`debts.ts`, `pult.client.js`, `pult.css`):** в карточке менеджера отображалось только число в ячейке «30+ дней», без возможности развернуть список таких сделок.
5. **Метка «Связался после срока» (`collect.ts`, `debts.ts`, `pult.client.js`):** если по просроченному делу менеджер уже позвонил (`VOXIMPLANT_CALL`) или оставил комментарий вручную после `DEADLINE`, но забыл закрыть дело или передвинуть срок, карточка выглядела как обычная просрочка без контакта.
6. **Менеджер из реестра ОП на пульте (`config/sales-pult.json`, `register/matchCrm.ts`):** один менеджер отсутствовал в `sales-pult.json`, а его имя в Excel-реестре ОП и в профиле Bitrix24 отличается одной буквой. Из-за этого его сделки и договоры не попадали в группу отдела продаж и числились в «нет в CRM» при сверке реестра.

---

## Цикл RED → GREEN → REFACTOR

### RED (падающие тесты на вымышленных данных)

Добавлены модульные и браузерные тесты (только синтетические ID и названия):

- `tests/bitrix/salesPultDebts.test.ts`:
  - классификация кандидатов с исходами `lost`, `failed`, `cancelled`, `repurposed`, `terminated` в `passed` (попадают в `readyToCloseDealIds`, не попадают в `overdue`, `newDeals`, `topTasks`), в то время как `won`, `partner`, `published`, `contract-draft`, `plan-renumbered`, `plan-moved` остаются активными;
  - генерация метки `passedPlanMonthNote = "план на <месяц> прошёл"` для `planStatus = "Утвержден"` при прошедшем месяце в `planMonth` (включая переход года: январь и план «Декабрь»), отсутствие метки для текущего/будущего месяца и нераспознанных строк, а также понижение приоритета внутри своей группы (`1..4`);
  - формирование массива `overdueOverMonthTasks` для дел с просрочкой `> 30` дней отдельно от `topTasks`;
  - генерация метки `contactedAfterDeadlineNote = "связался — закрыть дело / поставить следующий шаг"` для просроченных задач с `hasContactAfterDeadline = true`.
- `tests/bitrix/salesPultCollect.test.ts`:
  - передача `UF_CRM_1715597726664` и `UF_CRM_S2L_GZ_OUTCOME` из сделки в расчёт долгов;
  - пакетная (`batch`) загрузка `crm.timeline.comment.list` и `crm.activity.list (PROVIDER_ID=VOXIMPLANT_CALL)` для сделок из `Top-5`: игнорирование комментариев робота вебхука (`extractWebhookUserId(webhookUrl)`) и сервисных сообщений с префиксом `[`, выставление метки при комментарии живого пользователя или звонке после `DEADLINE`.
- `tests/bitrix/salesPultDebtsSite.test.ts` и `tests/bitrix/salesPultBrowser.test.ts`:
  - проверка единого порядка сортировки в `pult.client.js` (без пересортировки по `overdueDays`);
  - рендер свёрнутого списка `<details class="old-tasks">` под счётчиком «30+ дней», его раскрытие по клику и скрытие в режиме ТВ (`body.tv .old-tasks { display: none !important; }`);
  - рендер тегов `.tag.warn` (`passedPlanMonthNote`) и `.tag.good` (`contactedAfterDeadlineNote`).
- `tests/bitrix/salesPultRegisterMatch.test.ts`:
  - сопоставление имени из реестра с именем в CRM, отличающимся одной буквой, через `managerAliases` (на вымышленной паре имён; реальный `config/sales-pult.json` тестом не читается).

### GREEN (реализация)

1. **`src/bitrix/salesPult/debts.ts`:**
   - Импортирован тип `GzDealOutcome` из `../gzDealOutcome.js`. Через исчерпывающий словарь `PASSED_OUTCOME_BY_KIND: Record<GzDealOutcomeKind, boolean>` определена функция `isOutcomePassed(outcome)`.
   - Добавлен разбор русских названий месяцев `parsePlanMonthNumber` и функция `getPassedPlanMonthNote(planStatus, planMonth, now)` с учётом перехода года (в январе «Декабрь» считается прошедшим).
   - В `rankDebtTopTasks` добавлен вторичный ключ сортировки внутри группы: сначала задачи без `passedPlanMonthNote`, затем с `passedPlanMonthNote`, далее по убыванию суммы (`amount DESC`) и возрастанию срока (`deadline ASC`).
   - В `ManagerDebts` добавлено поле `overdueOverMonthTasks: OverdueOverMonthTask[]`, сортируемое по убыванию дней просрочки и суммы.
   - Добавлена функция `getContactedAfterDeadlineNote(isOverdue, hasContactAfterDeadline)`.
2. **`src/bitrix/salesPult/collect.ts`:**
   - Поле `"UF_CRM_1715597726664"` добавлено в `DEAL_SELECT_FIELDS`.
   - Последовательный цикл одиночных запросов `crm.timeline.comment.list` заменён на пакетную загрузку через `callBatch`: один пакет для `crm.timeline.comment.list` по всем сделкам из `Top-5` и один пакет для `crm.activity.list` (`PROVIDER_ID: "VOXIMPLANT_CALL"`) по просроченным сделкам из `Top-5`.
   - ID пользователя вебхука извлекается через `extractWebhookUserId(options.webhookUrl)` без жёстко заданных констант в коде.
3. **`src/bitrix/salesPult/page/pult.client.js` и `pult.css`:**
   - В `managerDetail(m)` под счётчиком «30+ дней» добавлен свёрнутый блок `<details class="old-tasks">`, скрытый в ТВ-режиме (`body.tv .old-tasks { display: none !important; }`).
   - В `taskRow(t, m, own)` добавлены бейджи `passedPlanMonthNote` (`.tag.warn`) и `contactedAfterDeadlineNote` (`.tag.good`).
   - В `renderTasks()` удалена пересортировка по `overdueDays`: общий список «Все» использует тот же компаратор, что и `rankDebtTopTasks` в `debts.ts`, а вкладка конкретного менеджера сохраняет порядок `m.topTasks`.
4. **`config/sales-pult.json`:**
   - Менеджер добавлен в группу `"sales"`; `stages.contracts` не менялся.
   - В `register.managerAliases` добавлено сопоставление имени из реестра с именем в CRM.
