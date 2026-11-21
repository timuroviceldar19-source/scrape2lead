# F3 B2B filter narrowing (700k KZT, interactive panels, monoblocks, laptops) — TDD evidence

## User journey

As the B2B sales lead, I want `F3-В2В тендеры` (`CATEGORY_ID=1`) to receive only plans and active lots from 700 000 KZT for interactive panels, monoblocks, and laptops — without regular desktop PCs or monitors.

## Key decisions

- **Threshold:** `minAmount` raised from `500_000` to `700_000` in `config/procurement-sources.json` and `config/procurement-sources.f3.json`.
- **Laptops (`262011.`):** Unconditionally allowed by ENSTRU prefix `262011.`. Added `"262011"` to search `keywords` because EPZ `/lots/?q=Ноутбук` misses hyphenated `Бизнес-ноутбук` (`262011.100.000008`) and parenthesized `(ноутбук, ...)` lot titles, while `q=262011` returns all active laptop lots.
- **Monoblocks (`262013.`):** ENSTRU prefix `262013.` is shared with regular desktop PCs (`Компьютер`) and workstations (`Станция рабочая`). Added `pkTruKeywordFilters: { "262013.": ["моноблок*", "all-in-one", "all in one"] }` so `262013.` items pass only when monoblock wording is present, rejecting desktop PCs even when a multi-lot announcement title mentions `(ноутбук, системный блок, монитор)`. `"Компьютер"` stays in search `keywords` because EPZ `/plan-items/` indexes monoblocks under `enstru.name_ru = "Компьютер"`.
- **Monitors (`262017.100.`):** Removed `"Монитор"` from `keywords` and `"262017.100."` from `pkTruPrefixes`.
- **Detail-fetch efficiency:** Added `pkNameWords: ["моноблок*", "ноутбук*", "all-in-one", "all in one"]` with suffix `*` stem matching in `containsTerm` so `isPlanDetailCandidate` skips regular `Компьютер` and `Монитор` plan rows instead of fetching hundreds of irrelevant detail pages.

## RED and GREEN

- **RED:** `npx vitest run tests/kz/procurementFilter.test.ts tests/kz/procurementConfig.test.ts`
  - 4 failed, 17 passed: configs still had `minAmount: 500_000`, `Монитор`, and `262017.100.`; filter accepted `pc-desktop`, `pc-mixed-lot-title`, and `workstation` under `262013.`; `isPlanDetailCandidate` returned `true` for regular `Компьютер`.
- **GREEN:** After updating `src/kz/procurement/config.ts`, `src/kz/procurement/filter.ts`, `scripts/kz-export-procurement.mts`, `config/procurement-sources.json`, and `config/procurement-sources.f3.json`:
  - `npx vitest run tests/kz/procurement*.test.ts tests/automation/config.test.ts` — all passed.
  - `npm run lint` (`tsc -p tsconfig.json --noEmit`) — passed cleanly.

## Live export and Bitrix push verification (2026-11-20)

- Export (`npm run f3:export`): `complete: true`, 1 170 collected → **54 `data`** (8 Samruk active laptop lots, 39 Samruk laptop plans, 7 Samruk interactive panel plans; min amount 897 142 KZT), 10 `review` (upstream missing BIN/code or ambiguous LCD panel), 1 106 `rejected`.
- Dry-run (`npm run f3:push -- --report runs/f3/procurement-2026-11-20T07-03-08-560Z.json`): `create: 54`, `update: 0`, `duplicate: 0`, `failed: 0`.
- Live execute (`npm run f3:push -- --report runs/f3/procurement-2026-11-20T07-03-08-560Z.json --execute`):
  - **43 deals created** in `F3-В2В тендеры` (`CATEGORY_ID=1`, `STAGE_ID=C1:NEW`), `failed: 0`.
  - **11 marked `duplicate`** during execute (same-customer KEGOC plans ×8 and Қазтеміртранс lots ×3 with identical amounts matched by `findPotentialDuplicate` against the first created deal).
  - Live Bitrix round-robin robot assigned the 43 deals to users `2403` (21) and `2405` (22); `assignmentGate` flagged them only because `config/procurement-sources.f3.json` still lists legacy `managerIds: ["2255"]`.
