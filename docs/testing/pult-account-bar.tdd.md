# Плашка «Вы вошли как …» и кнопка «Выйти» на пульте

## Задача

Показать текущую учётную запись («Вы вошли как `<почта>` · `<роль>`») и кнопку «Выйти» на всех страницах Пульта F3 (`index.html`, `reg.html`, `fin.html`), чтобы пользователь сразу видел, под какой почтой он зашёл, и мог в один клик сменить аккаунт Cloudflare Access.

## Решения

1. **Серверная подстановка в `src/bitrix/salesPult/gate/handler.ts`:**
   - Статические варианты `_r/<вариант>/…` общие для пользователей одной роли, поэтому подставлять почту на этапе сборки нельзя.
   - В HTML-шаблоны `pult.html`, `reg.html` и `fin.html` добавлен маркер `<!--__ACCOUNT__-->` (`ACCOUNT_MARKER`) сразу вверху `<main class="page">` (над `.dateline`).
   - Когда включён `PULT_ROLES` и токен Cloudflare Access проверен (`who.email` + `role`), `handleGateRequest` на `GET`-запросах подставляет `renderAccountBar(email, role)` через callback в `String.prototype.replace` (чтобы спецсимволы вроде `$&` в почте не интерпретировались как шаблон замены) с обязательным `escapeHtml(email)`.
   - Кнопка «Выйти» ведёт на стандартный адрес выхода Cloudflare Access `/cdn-cgi/access/logout` (сбрасывает сессию приложения и команды).
   - На `HEAD`-запросах тело не читается и не подменяется; без `PULT_ROLES` маркер остаётся невидимым комментарием.
2. **Стили (`src/bitrix/salesPult/page/pult.css`):**
   - Компактная строка `.account-bar` на всю ширину контейнера (контраст текста `--ink-2`/`--ink` на `--paper` > 7:1), на телефоне (`375px`) почта переносится внутри `.account-who`, кнопка «Выйти» остаётся справа без горизонтального переполнения.
   - В ТВ-режиме (`body.tv`) плашка скрывается (`display: none !important`).

## Журнал TDD

### RED
- Создан тест `tests/bitrix/salesPultAccountBar.test.ts` (unit-тест `renderAccountBar` + экранирование XSS/`$&`, проверка `handleGateRequest` для `all`/`rop`/`rto`/`manager` и `HEAD`, Playwright на `1440px` и `375px` на всех 3 страницах и скрытие в ТВ-режиме).
- Запуск `npx vitest run tests/bitrix/salesPultAccountBar.test.ts`: **4 failed (4)** — `renderAccountBar` и `ACCOUNT_MARKER` ещё не реализованы.

### GREEN
- Обновлены `src/bitrix/salesPult/gate/handler.ts`, `src/bitrix/salesPult/page/{pult,reg,fin}.html`, `src/bitrix/salesPult/page/pult.css`.
- Проверка:
  - `npm run lint`: **0 ошибок**.
  - `npx vitest run --maxWorkers=3 tests/bitrix/salesPultAccountBar.test.ts tests/bitrix/salesPultGate.test.ts tests/bitrix/salesPultRopRole.test.ts tests/bitrix/salesPultRtoRole.test.ts tests/bitrix/salesPultManagerVariant.test.ts`: **5 passed (5), 48 passed (48)**.
  - Визуальная проверка скриншотов на `1440px` и `375px`: без переполнений и наложений.
