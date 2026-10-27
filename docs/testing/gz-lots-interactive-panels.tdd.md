# GZ lots: interactive panel queries — TDD evidence

## Source and user journey

Reported by the user on 2026-10-27: announcement 17867217-1 (lot 88330806-ОК1, «Панель интерактивная»,
45 pcs, 38 793 103.65 KZT, open tender) did not appear in «B2G - Тендеры» (category 43).

As a tender manager, I want published Goszakup lots for interactive panels to arrive in «B2G - Тендеры»
the same way computer lots do.

## Root cause

The daily lots collector (`config/automation.json` → `config/gz-lots-computers.json`) searches the portal
by lot name with computer-only keywords and by five computer ENSTRU codes. The lot name «Панель интерактивная»
matches no keyword, and the lot has an empty ENSTRU list in the registry (`enstruList: [0]`), so neither
query type could find it. Every run on 2026-10-27 finished successfully.

## Change

Added name queries `панель интерактивная`, `интерактивная панель`, `доска специальная`,
`панель жидкокристаллическая` (the same panel set as `config/gz-plans.json`) to `config/gz-lots-computers.json`.

## RED / GREEN evidence

| Stage | Command | Result |
|---|---|---|
| RED | `npx vitest run tests/automation/config.test.ts` | 1 intended failure: keywords lacked the panel queries; 10 passed. |
| GREEN | `npx vitest run tests/automation/config.test.ts` | 11 passed. |
| Type safety | `npm run lint` | Passed. |
| Regression | `npm test` | 1172 passed, 4 skipped; 1 local-only failure `kgdReport` (`spawn python ENOENT`, see AGENTS.md). |

## Known gaps

- Panel plan points are already tracked as plan deals (`gz-plan:`, categories 29/41), and the published-status
  monitor never moves them. A published panel tender will now also get a separate `[GZ лот …]` deal in category 43.
- More lot deals in category 43 per run: panels are a frequent Goszakup item.
- No live portal or Bitrix request was issued.
