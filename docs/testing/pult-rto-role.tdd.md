# Роль РТО на пульте (без «Финансов» и «Выручки»)

## Задача

Добавить в систему ролей пульта (`PULT_ROLES`) роль **`rto`** для руководителя тендерного отдела: полный доступ к «Сегодня», «Радару», «Планам», «Рынку» и «Конкурентам» — но **полностью без страниц «Финансы» (`fin.html`) и «Выручка» (`reg.html`)** и без их пунктов в «Утреннем пульсе».

## Решения

1. **Конфиг и гейт (`src/bitrix/salesPult/gate/config.ts`, `handler.ts`):**
   - `PultRole` расширен ролью `{ kind: "rto" }`, `parseGateConfig` принимает `"rto"`, `variantOf` возвращает `"rto"`.
   - `handler.ts` отдаёт `_r/rto/index.html` и `_r/rto/market/…`, а на `/reg`, `/reg.html`, `/fin` и `/fin.html` отвечает `403 «Эта страница вам недоступна»`, поскольку `reg.html` и `fin.html` для `rto` не собираются.
2. **Фильтрация пульса (`src/bitrix/salesPult/pulse.ts`):**
   - Добавлены `isRegisterPagePulseItem` (`area === "margin"` или `href.startsWith("./reg.html")`) и `buildRtoPulse`: убирают из пульса и финансовые, и реестровые пункты + пометки `Финансы:` / `Реестр:` из `missing`, оставляя тендеры (`#radar-*`), CRM (`#signals`) и конкурентов (`#competitors-*`).
3. **Сборка варианта (`src/bitrix/salesPult/variants/rto.ts`, `scripts/pult-variants.mts`):**
   - `buildRtoVariant` помечает `pult` (включая `closedMonths`) как `viewer: { kind: "rto" }` и очищает `pulse` через `buildRtoPulse`.
   - `deployPultVariants` проверяет `payload.stock` через `parsePayloadStock`, собирает только `_r/rto/index.html` и `_r/rto/market/…` (без `reg.html` и `fin.html`).
4. **Клиентский UI (`src/bitrix/salesPult/page/pult.client.js`):**
   - При `viewer.kind === "rto"` убираются ссылки `<a href="./fin.html">` и `<a href="./reg.html">`, а также защитно отфильтровываются любые пункты пульса на `./fin.html` и `./reg.html`. В меню остаются 5 вкладок: «Сегодня», «Радар», «Планы», «Рынок», «Конкуренты».

## Журнал TDD

### RED
- Создан тест `tests/bitrix/salesPultRtoRole.test.ts` (конфиг, `buildRtoPulse`, `deployPultVariants`, гейт `handleGateRequest` на `/`, `/market/...`, `/reg`, `/reg.html`, `/fin`, `/fin.html`, Playwright на `1440px` и `375px`).
- Запуск `npx vitest run tests/bitrix/salesPultRtoRole.test.ts`: падение — модуль `src/bitrix/salesPult/variants/rto.ts` отсутствует.

### GREEN
- Реализованы `gate/config.ts`, `types.ts`, `pulse.ts`, `variants/rto.ts`, `scripts/pult-variants.mts`, `page/pult.client.js`, обновлён `AGENTS.md`.
- Проверка:
  - `npm run lint` (`tsc -p tsconfig.json --noEmit`): **0 ошибок**.
  - `npx vitest run --maxWorkers=3 tests/bitrix/salesPultRtoRole.test.ts tests/bitrix/salesPultRopRole.test.ts tests/bitrix/salesPultGate.test.ts tests/bitrix/salesPultManagerVariant.test.ts tests/bitrix/salesPultMorningPulse.test.ts tests/bitrix/salesPultMorningPulseBrowser.test.ts`: **6 passed (6), 70 passed (70)**.
