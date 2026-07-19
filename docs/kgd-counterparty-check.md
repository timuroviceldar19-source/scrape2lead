# Проверка рисков контрагентов КГД

Команда принимает `.csv` или `.xlsx` с колонкой `БИН`, `БИН(ИИН)` или `БИН/ИИН`:

```powershell
npm run kz:check-counterparties -- --input data/counterparties.xlsx --limit 20
```

Для автоматической CAPTCHA добавьте `CAPSOLVER_API_KEY` в локальный `.env`. При наличии ключа используется CapSolver; после двух неудачных попыток Chromium остаётся открытым для ручного решения. Режим можно переопределить через `--captcha-mode auto|manual`. Явный `auto` без ключа завершается ошибкой.

Перед запуском должны быть доступны Python 3 с `reportlab`, Playwright Chromium (`npx playwright install chromium`) и, для автоматического рендера PDF в PNG, Poppler (`pdftoppm`).

Скрипт сначала обновляет публичные bulk-списки КГД, затем открывает Chromium в headed-режиме. Для каждого интерактивного сервиса он заполняет БИН; пользователь решает CAPTCHA и нажимает кнопку поиска. Обход CAPTCHA не выполняется.

Прогресс хранится атомарно в `data/kgd-progress/`, а bulk-файлы и SHA-256 metadata — в `data/kgd-cache/`. Cookies и CAPTCHA-токены не сохраняются. Повторный запуск с тем же абсолютным путём входного файла продолжает незавершённые этапы.

Результаты:

- `exports/kgd-counterparty-report-YYYY-MM-DD.xlsx`;
- `output/pdf/kgd-counterparty-report-YYYY-MM-DD.pdf`.

Bulk-кэш моложе 24 часов используется без обновления. Кэш от 24 часов до 7 дней обновляется с fallback; отрицательный fallback помечает проверку серым. Данные старше 7 дней не используются.
