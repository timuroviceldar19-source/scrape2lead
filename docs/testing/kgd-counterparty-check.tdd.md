# TDD evidence: KGD counterparty checks

## Source and journeys

Требования получены из пользовательского ТЗ «Интерактивная выгрузка рисков контрагентов КГД».

- Пользователь загружает CSV/XLSX, сохраняет порядок уникальных БИН и ограничивает объём `--limit`.
- Пользователь вручную проходит CAPTCHA, может прервать запуск и продолжить завершённые этапы без повторной проверки.
- Пользователь получает консервативный светофор с накопленными пояснениями, Excel и единый PDF.
- Bulk-списки загружаются без браузера, точно сверяются по 12 цифрам и подчиняются политике кэша 24 часа / 7 дней.

## RED / GREEN evidence

RED checkpoints: `6052a9e`, `e7105b1`, `b343f0f`. Новые тесты были выполнены и падали из-за отсутствующих модулей до добавления production-кода.

| Гарантия | Тест | Тип | Результат |
|---|---|---|---|
| CSV/XLSX, aliases БИН, порядок, дедупликация, лимит и ошибки | `tests/kz/kgdCounterpartyInput.test.ts` | unit/integration | PASS |
| Приоритет red → gray → yellow → green и накопление пояснений | `tests/kz/kgdTrafficLight.test.ts` | unit | PASS |
| Реальные aliases payload, `esfRestrinctions`, причины неблагонадёжности | `tests/kz/kgdParser.test.ts` | unit | PASS |
| XLS/XLSX, все листы, многострочная шапка, leading zero, exact match, SHA-256 | `tests/kz/kgdBulk.test.ts` | unit/integration | PASS |
| Атомарный progress без CAPTCHA/cookies | `tests/kz/kgdProgress.test.ts` | integration | PASS |
| Resume не повторяет завершённые этапы | `tests/kz/kgdWorkflow.test.ts` | integration | PASS |
| Цветной Excel и реальный ReportLab PDF с кириллицей | `tests/kz/kgdReport.test.ts` | artifact | PASS |

## Commands and results

- `npm test`: 54 test files passed, 495 tests passed, 1 pre-existing E2E test skipped.
- `npm run build`: PASS.
- Targeted V8 coverage: 99.5% statements, 99.5% lines, 97.56% functions; branch coverage 67.87%.
- Live bulk smoke on 19.07.2026: insolvent source complete (3,657 exact identifiers, list date 31.12.2023); forced-liquidation source complete (12,358 exact identifiers, publication date 28.06.2022).
- `npm audit --omit=dev`: two moderate findings inherited through `exceljs -> uuid`; npm offers only a breaking ExcelJS downgrade, so no automatic fix was applied.

## Known manual checks

Ручной CAPTCHA smoke требует участия пользователя и не выполнялся автоматически. В текущем окружении `pdftoppm` отсутствует; ReportLab PDF создан и проверен по структуре, а CLI выполнит Poppler render автоматически там, где утилита установлена, иначе выведет предупреждение.

## CapSolver extension

- RED checkpoint: `3fef744`; тесты падали из-за отсутствующих CapSolver, browser-injection и mode-модулей.
- `tests/kz/capSolverClient.test.ts` проверяет `createTask`, polling, ready/failed, balance/HTTP/timeout и редактирование ключа из ошибок.
- `tests/kz/kgdCaptchaAutomation.test.ts` проверяет site key, textarea, callback, две попытки и ручной fallback в реальном Chromium fixture.
- Live callback smoke на странице КГД: site key обнаружен, callback вызван; платный CapSolver-запрос без пользовательского ключа не выполнялся.
- Targeted coverage: 96.83% statements/lines, 95% functions; browser-context код отдельно исполнен Playwright-тестом.
- Полный regression: 57 test files и 510 тестов PASS; один существующий E2E-тест skipped. `npm run build` PASS.
