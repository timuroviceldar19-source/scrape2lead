# Роль РОП на пульте (полный пульт продаж без «Финансов»)

## Задача

Добавить в систему ролей пульта (`PULT_ROLES`) отдельную роль **`rop`** для руководителя отдела продаж: полный доступ ко всей команде, «Радару», «Выручке» (с бонусом РОП, сверкой с порталом и дисциплиной реестра), «Планам», «Рынку» и «Конкурентам» — но **полностью без страницы «Финансы»** и без финансовых сигналов в «Утреннем пульсе».

## Решения

1. **Конфиг и гейт (`src/bitrix/salesPult/gate/config.ts`, `handler.ts`):**
   - `PultRole` расширен ролью `{ kind: "rop" }`, `parseGateConfig` принимает строковое значение `"rop"`, `variantOf` возвращает `"rop"`.
   - `handler.ts` автоматически отдаёт `_r/rop/index.html`, `_r/rop/reg.html` и `_r/rop/market/…`, а на `/fin` и `/fin.html` отвечает `403 «Эта страница вам недоступна»` (поскольку `_r/rop/fin.html` не собирается).
2. **Фильтрация пульса (`src/bitrix/salesPult/pulse.ts`):**
   - Добавлены `isFinancePagePulseItem` и `buildRopPulse`: убирают из пульса все пункты с `area ∈ {"cash", "debt", "stock"}` или `href`, начинающимся с `./fin.html`, а также заметки `Финансы: …` из `missing`.
   - Пункты из реестра ОП (`margin`), радара (`tender`), CRM (`crm`) и конкурентов (`losses`) для РОП сохраняются.
3. **Сборка варианта (`src/bitrix/salesPult/variants/rop.ts`, `scripts/pult-variants.mts`):**
   - `buildRopVariant` помечает `pult` (включая `closedMonths`) и `reg` как `viewer: { kind: "rop" }`, очищает `pulse` через `buildRopPulse`.
   - `deployPultVariants` проверяет `payload.stock` через `parsePayloadStock` (только штуки, без цен и компаний), собирает `_r/rop/{index,reg}.html` и копирует `_r/rop/market/…` без `fin.html`.
4. **Клиентский UI (`pult.client.js`, `reg.client.js`, `register.client.js`):**
   - `VIEWER` для ограничений одного менеджера (скрытие команды, «Конкурентов», «Бонуса РОП» и `portalMissing`) проверяет `viewer.kind === "manager"`.
   - Ссылка `<a href="./fin.html">` и любые пункты пульса с `href="./fin.html..."` скрываются при любом `viewer` (и для `rop`, и для `manager`).

## Журнал TDD

### RED
- Создан тест `tests/bitrix/salesPultRopRole.test.ts` (конфиг `parseGateConfig`, `buildRopPulse`, сборка `deployPultVariants`, проверка `handleGateRequest` на `/`, `/reg`, `/market/...`, `/fin`, `/fin.html`, плюс Playwright на `1440px` и `375px`).
- Запуск `npx vitest run tests/bitrix/salesPultRopRole.test.ts`: падение — модуль `src/bitrix/salesPult/variants/rop.ts` ещё не создан.

### GREEN
- Реализованы `gate/config.ts`, `types.ts`, `pulse.ts`, `variants/rop.ts`, `variants/manager.ts`, `scripts/pult-variants.mts`, `page/{pult,reg,register}.client.js`, обновлён `AGENTS.md`.
- Проверка:
  - `npm run lint` (`tsc -p tsconfig.json --noEmit`): **0 ошибок**.
  - `npx vitest run --maxWorkers=3 tests/bitrix/salesPultRopRole.test.ts tests/bitrix/salesPultGate.test.ts tests/bitrix/salesPultManagerVariant.test.ts tests/bitrix/salesPultMorningPulse.test.ts tests/bitrix/salesPultMorningPulseBrowser.test.ts tests/bitrix/salesPultFinanceSite.test.ts tests/bitrix/salesPultWave1Finance.test.ts`: **7 passed (7), 85 passed (85)**.
