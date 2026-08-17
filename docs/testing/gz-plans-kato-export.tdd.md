# KATO plan status export — TDD evidence

## Scope

- Five delivery KATO codes for Balkhash, Sayak, Shashubay, Torangalyk and Aktogay.
- August–December 2026.
- Plan statuses `Утвержден` (2) and `На проверке камерального контроля` (444).
- KATO-only search, deduplication by plan point ID and fail-fast pagination limits.

## RED

The first targeted run failed on six missing behaviors: empty-keyword KATO config, the five-place config, KATO option propagation, singular server-side status URL, search-query cross product and pagination truncation protection.

A second RED test showed that list-only export rows were incorrectly discarded when detail-card BIN enrichment was intentionally skipped. A pagination regression test also caught the required zero-based `page=1` second-page convention.

## GREEN

- Targeted plan suite: 64 tests passed.
- Full suite: 847 passed, 4 skipped.
- `npm run lint` and `npm run build`: passed.
- Targeted changed-module coverage with plan integration/deduplication tests: 82.78% statements/lines, 87.69% functions.

## Live verification

- 6,984 unique plan IDs, no pagination cap reached.
- Statuses: 6,974 `Утвержден`, 10 `На проверке камерального контроля`.
- Months: August 2,792; September 1,307; October 1,303; November 1,163; December 419.
- Locations returned by the registry: Balkhash 6,984; the other four configured KATO searches returned zero rows.
- Both plan and customer URLs are populated for every plan row.
