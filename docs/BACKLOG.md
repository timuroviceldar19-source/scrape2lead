# Backlog — candidate next increments

This file captures post-release candidates after `v1.7.0`. It is meant to be updated when a block is picked or discarded.

## Current recommendation

**Pick "Archive cleanup & dead-code removal" first.** It is pure technical debt, has no product risk, and makes every subsequent increment faster to build and review.

---

## 1. Archive cleanup & dead-code removal ⭐ recommended

**Goal:** remove or isolate legacy 2GIS/Kaspi MVP scripts and old prompt files so the active `operator/release flow` is obvious.

**Why now:**
- `docs/prompts/` contains 8 stage prompts that all describe work already merged (`qwen-stage1` through `gpt-stage5`). They still look like instructions.
- `scripts/` has ~30 files that are not referenced by `package.json` or current runbooks; many are early 2GIS/Kaspi experiments, seed scaffolding, or one-off MVPs.
- Cleaning this up reduces confusion for the next coder/operator and shrinks the lint/test surface.

**Scope (safe, no behavior change):**
1. Move `docs/prompts/*.md` into `docs/prompts/archive/` and add a top-level `docs/prompts/README.md` explaining the archive.
2. Move clearly dead scripts into `scripts/archive/`:
   - Old 2GIS MVP: `autoserviceRadarMvp.ts`, `mvp-astana-small.ts`, `generateMvpMock.ts`, `generateRealSample50.ts`, `generateFinalSalesPack.ts`
   - 2GIS experiments: `enrich-2gis-*.ts`, `import-2gis-browser.ts`, `2gis-browser-*.js`, `test2gisPlacesApi.ts`, `check-2gis-stats.ts`
   - Old adapter debugging: `test-kaspi-urls.ts`, `debug-kaspi-api.ts`
   - Seed/DB scaffolding: `seed-smoke.ts`, `checkSchema.ts`, `check-seed.ts`, `check-write-result.ts`, `fix-seed-lead-id.ts`, `read-crm-example.ts`, `rescoreLeads.ts`, `exportNow.ts`
   - Already-deprecated: `zakup-collector.ts`
   - Unused thin wrappers: `stat-gov-collector.ts`
   - One-off analyses: `analyze-top-a-gap.mts`, `check-bin-collisions.mts`
3. Remove or deprecate corresponding `package.json` scripts:
   - `audit:2gis:nsk-autoservice`, `audit:regression`, `validate:kz:proxy`, `api:2gis:smoke`, `mvp:astana`, `mvp:astana:small`.
4. Keep but label as **sales helpers** (used by `docs/sales-kit.md`):
   - `make-prospects-list.mts`, `make-next-sales-targets.mts`, `make-factoring-targets.mts`, `make-sales-sample.mts`, `generateBuyerOutreachTemplate.ts`, `generateSalesSprintWorkbook.ts`.

**Acceptance:**
- `npm run lint` and `npm test` still pass.
- Active commands listed in `README.md` still work.
- `git status` shows moved files (preserved history).

---

## 2. Autopilot hardening

**Goal:** make `npm run kz:autopilot` production-stable for weekly unattended runs.

**Why now:** autopilot is the main recurring revenue path (digest-winners + outreach-queue + Telegram).

**PR #1 (merged):** lock + exit codes + summary JSON + zero-output alert.
- `data/autopilot.lock` (O_EXCL) с stale-detection по `process.kill(pid, 0)`.
- Exit codes: `0` ok, `2` lock busy, `3` DB error, `4` export error, `5` no bins.
- `exports/autopilot-YYYY-MM-DD.json` со всеми полями run + `lockHeldBy` для lock-busy.
- Telegram при `winners === 0 && prospects === 0 && warnings.length === 0` отправляет префикс `⚠️`.
- See `docs/kz-batch-runbook.md` § «Параллельные запуски и lock», «Exit codes», «Summary JSON», «Zero-output».

**PR #2 (next):** per-BIN retry поверх пайплайна, retention policy для `outreach_runs`, `/health` endpoint с last-run, связка с `api_jobs` для server-side мониторинга.
- `core/withRetry` уже есть; нужен адаптер под `runKzEnrich` с budget/deadline.
- Retention: периодический prune `outreach_runs` старше N дней (через отдельный `kz:autopilot:retention`).
- `/health` уже знает про `api_jobs` (`src/server.ts`) — добавить блок `lastAutopilotRun`.
- Touches: `api_jobs` schema (миграция), `src/server.ts` (`/health`), `src/storage/apiJobStore.ts`. **Не** трогает `scripts/kz-autopilot.mts` продуктовую логику.

**PR #2 (split):**
- ✅ **`/health` last-run + JobStore retention (PR #2a, done):**
  - `IJobStore`: `getLatestJobByType`, `pruneTerminalJobsBefore` (SQLite + Postgres).
  - `GET /health` отдаёт `lastAutopilotRun` (id/status/createdAt/startedAt/finishedAt/exitCode/error/artifacts) и `jobStore: { ok, error? }` — `/health` остаётся 200 даже при ошибке чтения JobStore.
  - `SCRAPE2LEAD_JOB_RETENTION_DAYS` (env, default disabled): однократный prune terminal jobs старше N дней на старте, сразу после `resetRunningJobs()`. Логирует `Pruned N terminal API jobs older than X days`. Не трогает `queued`/`running` и не удаляет файлы в `exports/`.
  - Docs: `docs/server.md` (§ «Retention для api_jobs» + описание `lastAutopilotRun` в `/health`), `docs/kz-batch-runbook.md` (мониторинг через `/health`).
  - Миграция не нужна: текущая `api_jobs` уже содержит `id`/`type`/`status`/`created_at`/`started_at`/`finished_at`/`exit_code`/`error`, а `api_job_logs` и `api_job_artifacts` связаны `ON DELETE CASCADE`.
- ⏳ **per-BIN retry поверх `runKzEnrich` (PR #2b, future):**
  - Адаптер `core/withRetry` под enrich с budget/deadline.
- ⏳ **`outreach_runs` retention (PR #2c, future):**
  - Периодический prune `outreach_runs` старше N дней (отдельный `kz:autopilot:retention`).
  - Пока остаётся в бэклоге: API-сервер сейчас чистит только `api_jobs`, `outreach_runs` живут своей жизнью.

**Acceptance (после PR #2a):**
- `/health` показывает последний autopilot job (status/exitCode/artifacts) либо `null`, если ещё не запускался.
- При заданном `SCRAPE2LEAD_JOB_RETENTION_DAYS` старые terminal jobs удаляются на старте, queued/running — никогда.
- `npm test` и `npm run lint` зелёные, миграция БД не нужна.

---

## 3. Postgres production backend

**Goal:** finish the Postgres storage path so `STORAGE_BACKEND=postgres` is production-ready.

**Why now:** SQLite is fine for single-node operator use, but Postgres is needed for multi-user / API-heavy deployments.

**Scope:**
- Audit and fix `tests/postgresMigrationOrdering.test.ts` and `tests/exporter.test.ts`.
- Ensure Postgres migrations cover all KZ tables (`stat_gov_data`, `goszakup_registry_data`, `tender_data`, `kz_enrich_errors`, `outreach_*`).
- Verify `PostgresStorage` implements the full `Storage` interface.
- Add CI-like smoke test for Postgres backend.

**Acceptance:**
- `npm test` passes with `STORAGE_BACKEND=postgres` against a local Postgres instance.
- Operator UI can submit jobs and store artifacts with Postgres.

---

## 4. Sales pipeline automation / CRM glue

**Goal:** close the loop between `kz:autopilot` output and sales execution.

**Why now:** sales kit exists, but tracking is manual Excel files.

**Scope:**
- Store outreach status per (BIN, tender) in DB instead of spreadsheets.
- Add `kz:autopilot --digest-only` and `--outreach-only` modes.
- Generate follow-up reminders based on last contact date.
- Optional: webhook / CSV export to a CRM.

**Acceptance:**
- Operator can mark a winner as "contacted / interested / closed" in `/operator`.
- Next autopilot run respects prior outreach status.

---

## 5. New vertical / foreign market

**Goal:** reuse the KZ pipeline shape for another geography or buyer vertical.

**Why now:** `docs/foreign-market-research.md` is already drafted.

**Scope:**
- Validate one additional country/region (e.g., Uzbekistan, Kyrgyzstan) for public procurement data.
- Abstract source adapters behind the existing `src/adapters/kz/` pattern.
- Build a country-agnostic enrich pipeline (`src/enrich/`) that can be configured per market.

**Acceptance:**
- Running `npm run dev -- enrich --country UZ bins.csv` produces a comparable XLSX.
- At least one new source returns real data in a smoke test.

---

## Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-17 | Archive cleanup recommended as next block | Pure tech debt, no product risk, unblocks all other increments. |
| 2026-06-17 | Autopilot hardening split into PR #1 (lock/exit/summary) and PR #2 (retry/retention/health) | PR #1 не трогает api_jobs/server/migrations — быстрый и безопасный. PR #2 требует миграцию и UI-блок в /health. |
