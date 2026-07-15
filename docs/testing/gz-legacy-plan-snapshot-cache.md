# `data/debug/goszakup-plan-detail-*.html` — untrusted, kept as evidence

**Do not read these files to resolve anything.** They are retained only as
forensic evidence for the incident described in
[gz-plan-number-backfill.tdd.md](gz-plan-number-backfill.tdd.md).

## Why they are untrusted

A plan link looks like `show_plan/{canonical point id}/{legacy segment}`. These
files are named after the **legacy segment**, and that segment is not an
identity: it is shared by several canonical plan points. In the live CRM, 26
legacy segments are each shared by two different plan points, so one file
answered for two deals that are not the same plan point.

A heading read out of such a file is therefore evidence about **neither** point.
It cannot be repaired by re-reading it more carefully, because nothing in the
file records which point it was fetched for.

## What replaced them

`data/canonical/gz-plan-point/gz-plan-point-{canonical point id}.html`, written
by `src/kz/gzCanonicalPlanPage.ts`. Each file is fetched from one deal's exact
plan link, and is only stored after the browser's **final** URL is confirmed to
carry the requested canonical point id — a redirect to a sibling point is
rejected rather than cached.

The two namespaces are separate directories on purpose: the canonical pass never
overwrites the legacy files, so the evidence stays intact.
