# Промпт: Этап 3.6 — zakup retry (search input not found)

Скопируй блок **ЗАДАНИЕ** целиком в GPT/Cursor.

**База:** после `4d945eb` (Stage 3.5.1).  
**Контекст:** MVP batch `bins-batch.csv` — zakup filter работает (0 ложных лотов), но **4/10 БИН** упали с `search input not found; not saving default lots`:

| БИН | Компания (stat) |
|-----|-----------------|
| `140540002824` | Apex Technologies KZ |
| `160240025221` | ZharykNur Media |
| `130140004507` | Headway incorporated |
| `231140004550` | TURAN B&B |

Остальные 6 BIN: поиск отработал (`raw=0` или filter rejected).

---

## ЗАДАНИЕ

Проект: `C:\Users\Madara\Desktop\Scrapper`

**Цель:** сделать zakup collector **устойчивым к flaky SPA** — retry при отсутствии поля поиска, лучший wait, debug artifacts. Не менять логику `zakupTenderFilter`.

**Не трогай:** goszakup API/registry, stat.gov, postgres/exporter, filter rules.

---

## Корневая проблема

`src/kz/zakupCollector.ts` → `findSearchInput`:

```typescript
async function findSearchInput(page: Page) {
  const selectors = [
    'input[placeholder*="Слово"]',
    'input[placeholder*="поиска"]',
    'input[type="search"]'
  ];
  for (const selector of selectors) {
    const input = await page.$(selector);  // ← мгновенный query, без wait
    if (input) return input;
  }
  return null;
}
```

**Проблемы:**
1. `page.$` без `waitFor` — race: Angular SPA ещё не отрисовала форму.
2. `waitUntil: "networkidle"` на `goto` — flaky на SPA с long-polling/websockets.
3. **Новый context + page на каждый БИН** — холодный старт ×10, больше шансов поймать неготовый DOM.
4. Нет retry при transient failure.
5. Нет HTML snapshot при ошибке (только PNG если дошли до search).

---

## Fix 1 — надёжный поиск input

### Вынеси в `src/kz/zakupPageHelpers.ts` (новый файл)

```typescript
export const ZAKUP_LOTS_URL = "https://zakup.sk.kz/#/lots";

export const ZAKUP_SEARCH_SELECTORS = [
  'input[placeholder*="Слово"]',
  'input[placeholder*="поиска"]',
  'input[placeholder*="Поиск"]',
  'input[type="search"]',
  'input[aria-label*="поиск" i]',
  'input[aria-label*="search" i]',
  '.search input',
  'form input[type="text"]'
] as const;

export async function waitForZakupSearchInput(
  page: Page,
  options?: { timeoutMs?: number }
): Promise<Locator | null>

export async function dismissZakupOverlays(page: Page): Promise<void>
// закрыть cookie banner / modal если есть:
// button:has-text("Принять"), button:has-text("Закрыть"), [aria-label="Close"]
```

**`waitForZakupSearchInput`:**
- для каждого selector: `page.locator(selector).first().waitFor({ state: "visible", timeout: perSelectorTimeout })`
- `perSelectorTimeout` ≈ 3000ms, общий cap ≈ `options.timeoutMs ?? 15000`
- вернуть первый visible enabled input
- **не** использовать голый `page.$` и **не** fallback на любой `input`

**`dismissZakupOverlays`:** best-effort click, swallow errors.

---

## Fix 2 — retry wrapper

В `zakupCollector.ts` оберни `fetchZakupTenders` в retry:

```typescript
export interface ZakupCollectOptions {
  delayMs?: number;
  headless?: boolean;
  debugDir?: string;
  maxRetries?: number;        // default 3, env ZAKUP_MAX_RETRIES
  pageLoadTimeoutMs?: number; // default 30000
}
```

```typescript
async function fetchZakupTendersWithRetry(...): Promise<...> {
  const maxRetries = options.maxRetries ?? Number(process.env.ZAKUP_MAX_RETRIES ?? 3);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchZakupTendersOnce(...);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const retriable = isRetriableZakupError(lastError);
      if (!retriable || attempt === maxRetries) break;
      const backoff = 1000 * attempt;
      console.warn(`zakup.sk.kz: bin=${bin} attempt ${attempt}/${maxRetries} failed: ${lastError.message}; retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastError!;
}

function isRetriableZakupError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return msg.includes("search input not found")
    || msg.includes("timeout")
    || msg.includes("net::")
    || msg.includes("navigation");
}
```

На **последней** неудачной попытке сохранять:
- `data/debug/zakup-fail-{bin}.png`
- `data/debug/zakup-fail-{bin}.html`

---

## Fix 3 — стабильная загрузка страницы

В `fetchZakupTendersOnce`:

```typescript
await page.goto(ZAKUP_LOTS_URL, {
  waitUntil: "domcontentloaded",  // не networkidle
  timeout: pageLoadTimeoutMs
});
await dismissZakupOverlays(page);
// дождаться признака готовности приложения:
await page.waitForLoadState("load").catch(() => {});
await page.waitForTimeout(1500); // короткая пауза для Angular bootstrap

const searchInput = await waitForZakupSearchInput(page, { timeoutMs: 15000 });
if (!searchInput) {
  throw new Error("search input not found; not saving default lots");
}
```

**Опционально (если retry всё ещё flaky):** `page.waitForResponse` на первый `4dv3rts` после goto как сигнал что API фронта жив — не использовать его data как search result.

---

## Fix 4 — reuse browser context (batch optimization)

Сейчас: `newContext()` + `newPage()` **на каждый БИН** внутри `fetchZakupTenders`.

**Сделай:**
- один `BrowserContext` на весь `collectZakupTendersForBatch`
- один `Page` на batch (или page per BIN только при crash recovery)
- между БИН: `goto(ZAKUP_LOTS_URL)` + clear search field

```typescript
export async function collectZakupTendersForBatch(...) {
  const context = await browser.newContext({
    locale: "ru-RU",
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();
  try {
    for (const company of companies) {
      // fetchZakupTenders(page, ...) — принимает page, не создаёт context
    }
  } finally {
    await context.close();
  }
}
```

При retriable error на page — `page.reload()` перед retry.

---

## Fix 5 — API capture (не сломать filter)

Сохрани текущую логику:
- `searchSubmittedAt` выставлять **только после** Enter
- сбрасывать `capturedData = null` перед Enter
- не принимать pre-search responses

Улучшение (опционально, если легко):
```typescript
await searchInput.fill("");
await searchInput.fill(searchName);
await searchInput.press("Enter");
const response = await page.waitForResponse(
  (res) => res.ok() && res.url().includes("4dv3rts"),
  { timeout: 15_000 }
).catch(() => null);
if (response) capturedData = await response.json().catch(() => null);
```

Убрать дублирующий `page.on("response")` если post-Enter `waitForResponse` достаточен.

---

## Fix 6 — CLI / env

**`.env.example`:**
```bash
ZAKUP_MAX_RETRIES=3
ZAKUP_PAGE_TIMEOUT_MS=30000
```

**`src/cli.ts` / `enrichPipeline.ts`:**
```bash
npm run dev -- kz enrich bins.csv --zakup-max-retries 3
```

Проброс в `collectZakupTendersForBatch`.

**`package.json`** (опционально):
```json
"kz:zakup:smoke": "tsx scripts/zakup-smoke.ts"
```

`scripts/zakup-smoke.ts` — один BIN + search name для ручной проверки:
```bash
npm run kz:zakup:smoke -- 140540002824 "APEX TECHNOLOGIES"
```

---

## Тесты

### `tests/kz/zakupPageHelpers.test.ts` (новый)

HTML fixtures (синтетические, без live site):

**`tests/fixtures/zakup-lots-ready.html`** — содержит:
```html
<input placeholder="Слово для поиска" type="text" />
```

**`tests/fixtures/zakup-lots-loading.html`** — пустой body / spinner без input.

Тесты:
- `waitForZakupSearchInput` на ready fixture → находит (через Playwright `page.setContent` в test)
- loading fixture + short timeout → null
- `isRetriableZakupError` unit tests

### `tests/kz/zakupCollector.test.ts` (новый, опционально)

Mock `waitForZakupSearchInput` via dependency injection или vi.mock:
- 1st call null, 2nd call locator → retry succeeds, `failed` not incremented

### Не ломать

`tests/kz/zakupTenderFilter.test.ts` — без изменений.

---

## Документация

**`docs/TENDERS.md`** — секция **Zakup reliability**:
- retry policy
- debug artifacts `zakup-fail-{bin}.html`
- smoke script

**`docs/kz-batch-runbook.md`** — ожидание после фикса:
- batch 10 BIN: `search input not found` ≤ 1/10 (допустим 0/10)
- zakup accepted может оставаться 0 (filter) — это нормально

---

## DoD

```bash
npm run lint
npx vitest run tests/kz
```

**Ручной прогон:**
```bash
npm run dev -- kz enrich bins-batch.csv --skip-stat --skip-goszakup-registry --force-refresh
# или только zakup:
npm run kz:tenders -- bins-batch.csv  # если skip goszakup в pipeline
```

| Метрика | Было (batch) | Цель |
|---------|--------------|------|
| `search input not found` | 4/10 | **≤ 1/10** |
| zakup accepted | 0 | 0 ok (filter) |
| false-positive tenders | 0 | 0 |

**Commit:**
```
fix(kz): add zakup search retry and stable page readiness (stage 3.6)
```

---

## Не делать

- Прямой HTTP API без исследования (можно отдельным этапом 3.7)
- Ослабление `zakupTenderFilter`
- Сохранение default feed при ошибке поиска
- Headed-by-default менять не обязательно; `headless: true` для CI — ok

---

## Порядок работы

1. `zakupPageHelpers.ts` + unit tests с `setContent`
2. Refactor `fetchZakupTenders` → `fetchZakupTendersOnce` + retry
3. Reuse context/page в batch
4. CLI flags + smoke script
5. Docs
6. Manual batch re-run на 4 проблемных БИН

Начни с helpers и retry — reuse context можно вторым коммитом внутри той же ветки.
