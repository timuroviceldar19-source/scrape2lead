# Backlog — candidate next increments

This file captures post-release candidates after `v1.8.0`. It is meant to be updated when a block is picked or discarded.

## Current recommendation

**Pick "Sales pipeline automation / CRM glue" next.** Autopilot and archive cleanup are done in v1.8.0; the main gap is closing the loop between weekly digest output and sales execution (still manual Excel tracking).

---

## 1. Archive cleanup & dead-code removal ✅ done (v1.8.0)

**Goal:** remove or isolate legacy 2GIS/Kaspi MVP scripts and old prompt files so the active `operator/release flow` is obvious.

**Outcome:**
- `docs/prompts/` archived under `docs/prompts/archive/` with a top-level README.
- Dead scripts moved to `scripts/archive/`; deprecated `package.json` scripts removed.
- Sales helpers kept and labeled: `make-prospects-list.mts`, `make-next-sales-targets.mts`, `make-factoring-targets.mts`, `make-sales-sample.mts`, `generateBuyerOutreachTemplate.ts`, `generateSalesSprintWorkbook.ts`.
- See `docs/ARCHIVE_AUDIT.md` for the audit trail.

---

## 2. Autopilot hardening ✅ done (v1.8.0)

**Goal:** make `npm run kz:autopilot` production-stable for weekly unattended runs.

**Shipped in v1.8.0 (PRs #25–#29):**

| PR | Scope |
|----|-------|
| **#25** | Autopilot lock (`data/autopilot.lock`, O_EXCL + stale PID detection), clear exit codes (`0` ok, `2` lock busy, `3` DB, `4` export, `5` no bins), summary JSON (`exports/autopilot-YYYY-MM-DD.json`), zero-output Telegram alert (`⚠️` when winners/prospects/warnings all empty). |
| **#26** | fix(server): drop dead `skipChannel`/`channelNiche` from kz-autopilot API. |
| **#27** | `/health` last-autopilot-run block, `api_jobs` retention (`SCRAPE2LEAD_JOB_RETENTION_DAYS`), JobStore prune on startup. |
| **#28** | per-BIN enrich retry fallback via `core/withRetry` adapter (budget/deadline). |
| **#29** | outreach run retention ledger — migration v16 (`outreach_seen`), decoupled dedup, `npm run kz:autopilot:retention` (`KZ_OUTREACH_RUN_RETENTION_DAYS`). |

**Docs:** `docs/kz-batch-runbook.md` (lock, exit codes, summary JSON, zero-output, retention), `docs/server.md` (`/health`, job retention).

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

## 4. Sales pipeline automation / CRM glue ⭐ recommended

**Goal:** close the loop between `kz:autopilot` output and sales execution.

**Why now:** sales kit exists, but tracking is manual Excel files. Autopilot output is stable; next value is operator workflow, not more outreach DB tables.

**Scope:**
- Track outreach status per (BIN, tender) in operator UI / lightweight CRM export — **not** a new Postgres outreach schema as the first step.
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
| 2026-06-17 | v1.8.0 shipped archive cleanup + autopilot hardening (#25–#29) | Lock/exit/summary, health retention, enrich retry, outreach_seen ledger. |
| 2026-06-17 | Sales pipeline / CRM glue recommended next | Autopilot stable; manual Excel tracking is the bottleneck. Defer Postgres outreach tables. |
