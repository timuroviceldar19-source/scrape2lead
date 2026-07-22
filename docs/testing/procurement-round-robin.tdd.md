# Procurement B2B round-robin: TDD and live verification

Date: 2026-07-22

## Scope

- Category: `1` (`F3-B2B тендеры`)
- Entry stage: `C1:NEW`
- Sequential manager pool: `147`, `1751`, `725`
- Absent employees are skipped; completed workday is not considered.
- Existing deals and later manual reassignment are not changed by the integration.

## RED

The assignment tests and real configuration test were first changed to require exactly
`147/1751/725`. They failed while the implementation and JSON configuration still
contained the previous four-person pool including absent manager `205`.

## GREEN

- `PROCUREMENT_MANAGER_IDS`, `config/procurement-sources.json`, and the parsed config
  now contain exactly `147/1751/725`.
- Deal creation omits `ASSIGNED_BY_ID`; the Bitrix robot owns initial assignment.
- A fail-closed post-create gate polls Bitrix and rejects an industrial run when a new
  deal is not assigned to a configured manager.
- Target verification: 3 files, 8 tests passed.
- Full verification: 72 files passed, 1 skipped; 571 tests passed, 1 skipped.
- `npm run lint`: passed.
- Changed-module coverage: assignment control 100% statements/lines, deal planning
  99.28% statements/lines, procurement config 100% statements/lines.

## Bitrix live control

The native `Изменить ответственного` robot in category `1`, stage `C1:NEW`, was saved
and reopened for readback. Persisted values:

- Managers: Бахтияр Искаков (`147`), Нурбол Еламан (`1751`), Бекзат Казанбаев (`725`)
- Mode: `последовательно`
- Skip absent: `Да`
- Skip completed workday: `Нет`

One verified Samruk plan was created without `ASSIGNED_BY_ID`:

- Deal: `42995`
- Source record: `19925351`
- Category/stage: `1 / C1:NEW`
- Assigned by the robot: `147` (Бахтияр Искаков)
- `OPENED=Y`
- Origin: `scrape2lead-procurement / proc:samruk:plan:19925351`

Protected pre-existing deals `42987` and `42989` remained assigned to `2301` before
and after the control creation. The next two naturally created deals are needed to
observe a complete three-person rotation; no extra control deals were created.
