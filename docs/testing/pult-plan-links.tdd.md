# Ссылки «План ↗» в «Планах» и «Радаре» ведут на procurement.gov.kz

Дата: 13.11.2026. База: `origin/main`, `69a8772`. Ветка: `fix/pult-plan-links`.

## Зачем

Портал в августе 2026 переехал с goszakup.gov.kz на procurement.gov.kz (пути те же, см.
`src/kz/goszakupOrigin.ts`). Старый домен отдаёт 404. В «Планах» ссылка на план берётся из поля
сделки `UF_CRM_PLAN_LINK`, а у сделок, созданных до переезда, там старый домен — 1141 ссылка из
2538. В «Радаре» так же вели ссылки из старых комментариев к лотам и из сделок плана.

## Решения

- `toCurrentPortalUrl` в `src/kz/goszakupOrigin.ts`: `goszakup.gov.kz` и `www.goszakup.gov.kz` →
  текущий домен с тем же путём, запросом и якорем. Поддомены `ows.`, `v3bl.` (они не переезжали) и
  чужие хосты не трогаются.
- Применяется только к ссылкам для показа: `normalizePlanDeal` (ссылка на план) и `httpsUrl` в
  `radar/aggregate.ts` (лот, объявление, план). Поля сделок в Битриксе и SQLite не меняются: по
  хранимой ссылке идёт дедупликация.

## RED

`npx vitest run tests/kz/goszakupOrigin.test.ts tests/bitrix/salesPultPlansRepeatedDeals.test.ts tests/bitrix/salesPultRadar.test.ts`:
**4 failed** (функции нет; план и «Радар» отдают старый домен).

## GREEN

- Те же файлы: **25 passed**. `npm run lint` чистый.
- Реальные сделки «Планов» из локальной сборки: после замены все 2538 ссылок на procurement.gov.kz,
  переписано 1141; три случайные переписанные ссылки открываются (HTTP 200), старый адрес — 404.
