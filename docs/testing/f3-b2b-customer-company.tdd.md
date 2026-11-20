# F3 B2B customer company with registry phone — TDD evidence

## User journey

As a B2B manager working `F3-В2В тендеры` (`CATEGORY_ID=1`), I want every tender deal to carry the
customer company with its phone, so the call button on the kanban card and in the deal works without
someone creating companies by hand.

Before this change the collector created deals with the customer only in the title and in string
fields (`UF_CRM_6627AEBD72587`, `UF_CRM_6627AEBD7C2D2`): `COMPANY_ID` was empty, so the phone, e-mail
and chat icons were grey. On 2026-11-20, 40 of 43 deals were linked by hand.

## Key decisions

- **Find before create.** Company by BIN field `UF_CRM_666171B20E9E3` («БИН заказчика», the same field
  the GZ push uses and 2 277 companies already carry), then by `ORIGINATOR_ID=scrape2lead-procurement` +
  `ORIGIN_ID=procurement-company:<BIN>`, otherwise create.
- **Contacts from the public registry.** `zakup.gov.kz/api/core/api/public/organizations/?q=<BIN>` →
  exact `iin_bin` match → organization detail: `phone` plus address phones, `email`, `website`.
  Free-text phones are split on `;`/`,`, de-duplicated by digits, junk under 5 digits dropped, bare
  ten-digit `7XXXXXXXXX` prefixed with `+7`. Placeholder e-mails like `do not have email` are skipped.
- **One company per BIN per run**, even with parallel calls (promise cache), so 16 KEGOC plans make one company.
- **Never overwrite a manual link.** Existing deals get `COMPANY_ID` only when they have none.
- **Registry or Bitrix lookup failure never loses a deal.** No registry match → company without phone and a
  warning; resolver exception → deal without company and a warning. Warnings go to `AUTOMATION_RESULT_JSON`
  (logged, not blocking).
- **Dry-run writes nothing** (reports `action: create, companyId: null`). `--no-customers` restores old behaviour.
- **`managerIds`** relaxed from the literal `["2255"]` to a non-empty list; F3 config now `["2403", "2405"]`,
  the managers the Bitrix robot actually distributes to.

## RED and GREEN

- **RED:** `npx vitest run tests/bitrix/procurementCustomer.test.ts tests/bitrix/procurementPush.test.ts tests/kz/procurementRegistryContact.test.ts`
  — 3 files failed: resolver and registry modules missing; push did not set `COMPANY_ID` nor report `customer`.
  `tests/kz/procurementConfig.test.ts` failed on `managerIds` (`expected "2255"`).
- **GREEN:** after adding `src/bitrix/procurementCustomer.ts`, `src/kz/procurement/registryContact.ts`, wiring
  `planProcurementPush` / `ProcurementBitrixClient` / `scripts/bitrix-push-procurement.mts`, and relaxing the schema:
  - targeted suites 20/20 and 19/19 passed;
  - full `npx vitest run --pool=forks`: 1 821 passed, 9 skipped;
  - `npm run lint` clean.

## Live verification (2026-11-20, read-only)

- BIN field backfilled on the 15 companies linked by hand earlier that day (13687–13715), so the
  collector finds them instead of creating duplicates.
- Dry-run on `runs/f3/procurement-2026-11-20T07-03-08-560Z.json`: `update: 43`, `duplicate: 11`, `failed: 0`;
  38 deals already linked left untouched; 5 deals planned to get 3 new companies (BIN `970240000816`,
  `050540000581`, `140340010451`) without phone — these organizations are absent from the registry search.
