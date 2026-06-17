# Read-only audit: prompts / MVP scripts

Post-release housekeeping audit. Goal: separate what is part of the active `operator/release flow` from what belongs in the archive.

## docs/prompts/ — archive of completed stages

All files in `docs/prompts/` describe work that has already been merged into `develop`. They are historical artifacts, not active task specs.

| File | Stage | Status | Notes |
|------|-------|--------|-------|
| `qwen-stage1.md` | Stage 1 — consolidate stat.gov + tenders | ✅ merged | Created `src/kz/*` collectors, migration v11, `kz:enrich`. |
| `gpt-stage2.md` | Stage 2 — CLI, cache, aggregates, XLSX export | ✅ merged | Added `kzStorage`, `CompanyCard`, `kzExporter`, CLI `kz` subcommands. |
| `gpt-stage3-goszakup.md` | Stage 3 — goszakup v3 API | ✅ merged | `goszakupClient.ts`, pagination, active filter. |
| `gpt-stage3.5-goszakup-registry.md` | Stage 3.5 — public registry collector | ✅ merged | Phone/email/website from public registry without token. |
| `gpt-stage3.5.1-registry-quality-fixes.md` | Stage 3.5.1 — registry quality fixes | ✅ merged | Phone/website validators, union export. |
| `gpt-stage3.6-zakup-retry.md` | Stage 3.6 — zakup retry / reliability | ✅ merged | `zakupPageHelpers.ts`, retry, context reuse. |
| `gpt-zakup-filter-fix.md` | zakup filter fix | ✅ merged | `zakupTenderFilter.ts`, default-feed detection. |
| `gpt-stage5-2gis-leads.md` | Stage 5 — glue 2GIS leads + KZ enrich | ✅ merged | `leadKzMerge.ts`, `kz export-unified`. |

**Recommendation:** move all files to `docs/prompts/archive/` and add `docs/prompts/README.md` stating they are historical.

---

## scripts/ — audit by category

### A. Active operator / release flow (keep, maintain)

These scripts are referenced by `package.json` scripts that appear in `README.md` and runbooks.

| Script | `package.json` command | Purpose |
|--------|------------------------|---------|
| `stat-gov-login.ts` | `kz:login` | QR auth session for stat.gov. |
| `kz-enrich.ts` | `kz:enrich` | Main enrich orchestrator. |
| `tenders-collector.ts` | `kz:tenders` | Unified tender collection. |
| `merge-stat-gov-data.ts` | `kz:merge` | Merge stat.gov into `leads`. |
| `kz-batch-audit.ts` | `kz:audit` | Batch quality audit. |
| `kz-export.ts` | `kz:export` | Main XLSX export. |
| `kz-export-top-a.mts` | `kz:export-top-a` | Top-A leads slice. |
| `kz-export-sales-top-a.mts` | `kz:export-sales-top-a` | Sales-optimized Top-A slice. |
| `goszakup-smoke.ts` | `kz:goszakup:smoke` | Live goszakup v3 smoke test. |
| `goszakup-lots-smoke.ts` | `kz:lots:smoke` | Live goszakup lots smoke. |
| `goszakup-contracts-smoke.ts` | `kz:contracts:smoke` | Live goszakup contracts smoke. |
| `zakup-smoke.ts` | `kz:zakup:smoke` | Live zakup smoke. |
| `goszakup-registry-collector.ts` | `kz:registry` | Public registry collector. |
| `harvest-registry-bins.ts` | `kz:harvest` | Harvest BINs from registry. |
| `kz-autopilot.mts` | `kz:autopilot` | Weekly outreach digest. |
| `kz-feeder-top-a.mts` | `kz:feeder-top-a` | 2GIS feeder → backfill BIN. |
| `kz-targeted-2gis-top-a.mts` | `kz:targeted-2gis-top-a` | Targeted 2GIS top-A. |
| `kz-direct-scrape.mts` | `kz:astana-scrape` | Direct 2GIS scrape config runner. |
| `kz-astana-modem-smoke.mts` | `kz:astana-modem-smoke` | Modem/connection smoke. |
| `operatorIntake.ts` | `operator:intake` | Operator intake helper. |

### B. Sales helpers (keep, document)

Used by `docs/sales-kit.md` and current sales sprint. Not part of nightly operator flow, but actively used.

| Script | Purpose |
|--------|---------|
| `make-prospects-list.mts` | Build `exports/prospects-segment1.xlsx` from 2GIS leads. |
| `make-next-sales-targets.mts` | Build `exports/next-sales-targets.xlsx`. |
| `make-factoring-targets.mts` | Build `exports/factoring-targets.xlsx`. |
| `make-sales-sample.mts` | Build `exports/kz-top-a-sample-3.xlsx`. |
| `generateBuyerOutreachTemplate.ts` | Build `exports/autoservice-radar-buyer-outreach-template.xlsx`. |
| `generateSalesSprintWorkbook.ts` | Build `exports/autoservice-radar-sales-sprint-workbook.xlsx`. |

### C. Archive candidates (legacy / MVP / one-off)

These should be moved to `scripts/archive/` and their `package.json` scripts removed.

**Old 2GIS/Kaspi MVP & experiments**

| Script | Why archive |
|--------|-------------|
| `autoserviceRadarMvp.ts` | Old 2GIS Astana MVP, replaced by feeder + unified export. |
| `mvp-astana-small.ts` | Smaller version of the above. |
| `generateMvpMock.ts` | Generates mock 2GIS MVP data. |
| `generateRealSample50.ts` | One-off real sample builder with hard-coded path. |
| `generateFinalSalesPack.ts` | Reads old `data/scrape2lead-kz.db`, not current schema. |
| `enrich-2gis-dom-scrape.ts` | Experimental 2GIS DOM enrichment. |
| `enrich-2gis-full-data.ts` | Experimental 2GIS full data enrichment. |
| `enrich-2gis-playwright.ts` | Experimental 2GIS Playwright enrichment. |
| `enrich-2gis-xhr-full.ts` | Experimental 2GIS XHR enrichment. |
| `enrich-2gis-xhr-intercept.ts` | Experimental 2GIS XHR intercept. |
| `import-2gis-browser.ts` | Experimental 2GIS browser import. |
| `2gis-browser-collect.js` | Experimental 2GIS browser collect. |
| `2gis-browser-fetch.js` | Experimental 2GIS browser fetch. |
| `test2gisPlacesApi.ts` | 2GIS API smoke, not used by release flow. |
| `check-2gis-stats.ts` | 2GIS stats debugging. |
| `test-kaspi-urls.ts` | Kaspi URL debugging. |
| `debug-kaspi-api.ts` | Kaspi API debugging. |

**Early seed / DB scaffolding**

| Script | Why archive |
|--------|-------------|
| `seed-smoke.ts` | Early seed smoke. |
| `checkSchema.ts` | One-off schema check. |
| `check-seed.ts` | One-off seed check. |
| `check-write-result.ts` | One-off write-result check. |
| `fix-seed-lead-id.ts` | One-off seed ID fix. |
| `read-crm-example.ts` | One-off CRM example reader. |
| `rescoreLeads.ts` | One-off rescore helper. |
| `exportNow.ts` | One-off export helper. |

**Audit / regression (2GIS-specific)**

| Script | Why archive |
|--------|-------------|
| `auditRegression.ts` | 2GIS regression audit. |
| `auditHealthGate.ts` | Supporting health gate for 2GIS audit. |

**Deprecated / unused thin wrappers**

| Script | Why archive |
|--------|-------------|
| `zakup-collector.ts` | Already marked `DEPRECATED`; function moved to `tenders-collector.ts`. |
| `stat-gov-collector.ts` | Not referenced; `kz:enrich` covers it. |

**One-off analyses**

| Script | Why archive |
|--------|-------------|
| `analyze-top-a-gap.mts` | One-off gap analysis between top-A BINs and 2GIS leads. |
| `check-bin-collisions.mts` | One-off BIN collision check. |
| `_db-check.mts` | Internal DB check, underscore prefix suggests ad-hoc. |

---

## package.json scripts to remove / deprecate

| Script | Reason |
|--------|--------|
| `audit:2gis:nsk-autoservice` | 2GIS audit archive. |
| `audit:regression` | 2GIS audit archive. |
| `validate:kz:proxy` | 2GIS proxy validation, not release flow. |
| `api:2gis:smoke` | 2GIS API smoke, not release flow. |
| `mvp:astana` | Old 2GIS MVP. |
| `mvp:astana:small` | Old 2GIS MVP. |

---

## Next action

1. Pick **"Archive cleanup & dead-code removal"** from `docs/BACKLOG.md`.
2. Move files to `scripts/archive/` and `docs/prompts/archive/`.
3. Update `package.json` to remove archive scripts.
4. Run `npm run lint` and `npm test` to confirm no regressions.
