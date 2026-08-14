# GZ procurement-method routing and migration — TDD evidence

Date: 2026-08-14

## Scope

- Route new Bitrix24 deals by exact procurement method.
- Plan existing-deal moves between categories 9 and 41 with explicit semantic stage mappings.
- Never include the responsible field in a migration update.
- Use `crm.item.update` for cross-pipeline moves and reject silent API no-ops.

## RED

Command:

```text
npm test -- --run tests/bitrix/gzProcurementMethodMigration.test.ts
```

Observed result: 3 of 7 tests failed because the universal update request builder and strict post-update verifier did not exist. The failing scenario preserved the assignee but left category and stage unchanged, reproducing the Bitrix `crm.deal.update` silent no-op.

Test commit: `4a116b1 test: reject silent Bitrix pipeline migration no-ops`

## GREEN

Implemented:

- `crm.item.update` request with `entityTypeId: 2`, `categoryId`, and `stageId` only.
- Immediate verification of target category, target stage, and original assignee.
- Fail-fast behavior on any mismatch.

Commands:

```text
npm test -- --run tests/bitrix/gzProcurementMethodMigration.test.ts
npm run lint
```

Observed result: 7 of 7 tests passed; TypeScript completed without errors.

## Live safety verification

- Two cross-pipeline pilots (`25257`, `38689`) reached the mapped categories/stages and kept assignee `147`.
- Stage history recorded both moves; deal `25257` retained its two linked activities.
- Integration-shaped test deal `44815` entered category `41` with technical assignee `2301`; the guarded robot reassigned it to `195`.
- 180 planned moves were executed in one pilot set and eight batches. All 180 reports record matched category, matched stage, and preserved assignee.
- Final dry-run found zero remaining `move` decisions.
