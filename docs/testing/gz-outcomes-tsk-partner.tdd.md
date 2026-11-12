# «Торговая сеть Казахстана» — партнёр в итогах закупок

Дата: 12.11.2026. База: `origin/main`, `4051450`. Ветка: `fix/tsk-partner-outcomes`.

## Зачем

На «Рынке» (`config/market-monitor.json`) БИН 170240035230 уже считается компанией группы
F3, а в `config/gz-deal-outcomes.json` его не было. Робот итогов закупок писал договоры этой
компании как проигрыш конкуренту (`lost:`), поэтому на «Планах» она стояла в «Кому проиграли»,
а доля побед по КТ была занижена.

## Решения

- **`partnerBins`** дополнен БИН 170240035230. Робот `deal-outcomes` каждое утро перепроверяет
  открытые сделки и меняет `lost:` на `partner:` (`shouldReplaceGzOutcomeKey`), с комментарием
  «выиграл наш партнёр». Закрытые сделки он не перепроверяет.
- **«Планы» при чтении:** `attachLostWinners` получает `partnerBins`; если в последнем
  комментарии робота победитель — партнёр группы, сделка считается выигранной и не попадает в
  «Кому проиграли». Так исправляются и закрытые сделки, без записи в Битрикс.
- **Сверка «Есть на портале, нет в реестре»** берёт новый ключ `registerPartnerBins` (только
  Amanat Asia, как раньше), иначе `partnerBins`. Попадают ли продажи второй компании в реестр ОП,
  не выяснено; без этого разделения около 20 её договоров в месяц сразу попали бы в сверку.

## RED

`npx vitest run tests/bitrix/gzDealOutcome.test.ts tests/bitrix/salesPultRegisterHistory.test.ts`:
**2 failed**. `npx vitest run tests/bitrix/salesPultPlansLostTo.test.ts`: **2 failed**.

## GREEN

Те же файлы и `tests/bitrix/salesPultPlans*`: 185 passed. `npm run lint` чистый.
`npx vitest run`: 2044 passed, 1 failed — `kgdReport` (локально нет python с reportlab).
