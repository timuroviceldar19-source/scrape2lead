# Сроки лотов: zakup и часовой пояс

## Отдельная ветка перед слиянием, 30.10.2026

`feat/zakup-lot-windows-v2` создана от исправленной `feat/zakup-deal-outcomes`. Перенесены только коммиты лотов: тест, адаптер, отсев неоднозначности, восстановление через объявление, две проверки идентичности и журнал сверки. Исходная `feat/zakup-lot-windows` сохранена без изменений. Статус и товар не включены. Проверки CLI лотов вынесены в отдельный тест, чтобы ветка не зависела от проверок команд статуса и товара.

`npm test -- tests/kz/goszakupLotWindow.test.ts tests/automation/gzZakupSources.test.ts`, `npm run lint`, `npm run build` успешны (`tmp/zakup-review-20261030/lots-tests.txt`, `lots-lint.txt`, `lots-build.txt`). Внешние действия не выполнялись.

Сначала `/public/lots/?lot_number=...&system_id=1`, ows только при ошибке и заданном токене. Если индекс лота пуст или без дат, известное объявление ищется по точному номеру; его дочерние лоты подтверждают точный номер, `system.id=1` и отсутствие удаления. Поля начала/конца берутся из объявления. Без доказанной связи отсутствие оставляет даты незаполненными. UTC преобразуется в UTC+5 независимо от часового пояса Node, включая переход даты и года.

Один номер лота встречается в разных объявлениях. Поэтому импорт передаёт номер объявления из ссылки выгрузки, а backfill — из комментария сделки. Выбирать просто максимальный или минимальный id нельзя. Без номера объявления разные сроки считаются неоднозначностью, а не поводом выбрать произвольную запись.

У реального объявления встречается `system_id=4`, хотя его дочерние лоты относятся к ЭГЗ (`system.id=1`). Поиск объявления не ограничивается системой; система обязательно проверяется у точного дочернего лота. Это не разрешение смешивать системы. Неполные пагинированные дочерние ответы отклоняются. Резерв ows также проверяет объявление и неоднозначность.

## RED / GREEN

Все файлы вывода лежат вне Git: `F:\Temp\zakup-migration-evidence`.

| Проверка | Команда | Вывод |
|---|---|---|
| RED: без токена и перевод часового пояса | `npx vitest run tests/kz/goszakupLotWindow.test.ts` | `lots-red.txt` |
| RED: неоднозначное объявление | та же команда | `lots-announcement-red.txt` |
| GREEN: адаптер и прежняя защита ручных дат | `npx vitest run tests/kz/goszakupLotWindow.test.ts tests/bitrix/gzLotDates.test.ts` | `lots-announcement-green.txt` |
| Сверка часов, с объявлением из сделки | `node --import ./tmp/zakup-readonly.mjs --import tsx tmp/validate-zakup-lots.mts` | `lot-comparison-context.txt`, `lot-comparison-private.json` |
| RED/GREEN: лот через дочерние данные объявления | `npx vitest run tests/kz/goszakupLotWindow.test.ts` | `lot-announcement-recovery-red.txt`, `lot-announcement-recovery-green.txt` |
| RED/GREEN: система объявления отличается от системы лота | та же команда | `lot-system-red.txt`, `lot-system-green.txt`, `lot-child-system-red.txt`, `lot-child-system-green.txt` |
| Финальная сверка без HTTP-кэша | `node --import ./tmp/zakup-readonly-fresh.mjs --import tsx tmp/validate-zakup-lots.mts` | `lot-validation-verified.txt`, `lot-validation-verified-metrics.json` |
| Оба отличия против официальных объявлений | `node F:/Temp/zakup-migration-evidence/verify-lot-portal.mjs` | `lot-differences-portal.txt` |

Проверено 30 лотов из 298 сделок с сохранёнными сроками до минуты: 28 совпали, 2 отличаются, ошибок поиска 0. Запросов 39, время 3,861 с, HTTP-кэш 0 (`lot-validation-verified.txt`). Ранее отсутствовавшие лоты дочитаны через объявления.

Оба отличия подтверждаются текущими официальными карточками (`lot-differences-portal.txt`): объявление `17774066` содержит срок 19.10.2026 09:00 — 27.10.2026 09:00, `17784719` — 22.10.2026 09:00 — 30.10.2026 09:00. Это согласие двух текущих источников; время изменения относительно старого комментария CRM не установлено. HTML-свидетельства: `lot-announcement-17774066.html`, `lot-announcement-17784719.html`.

Промежуточные прогоны без выбора объявления (`lot-comparison.txt`, `lot-comparison-final.txt`) не являются финальной сверкой. Тестовые фикстуры синтетические. CRM-идентификаторы и данные сделок не добавляются в репозиторий.

Общие финальные проверки: `final-tests.txt` (1503 пройдены, 9 пропущены), `final-lint.txt`, `final-build.txt`; команды и коды выхода — в частном отчёте вне Git. Записи дат в CRM не выполнялись.
