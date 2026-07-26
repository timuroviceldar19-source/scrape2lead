# Cloudflare GitHub dispatch — TDD evidence

## Source and user journeys

The source plan was supplied in the implementation request on 2026-07-26.

- As the pipeline owner, I want three independent UTC schedules to dispatch the
  corresponding GitHub Actions workflows so GitHub's delayed cron is only a fallback.
- As the credential owner, I want the PAT to remain a Cloudflare secret and never
  appear in source, logs, or errors.
- As the operator, I want each invocation to make one request and leave enough
  structured evidence to match a Cloudflare cron event to its GitHub Actions run.

## RED and GREEN

- RED checkpoint `325cc2d`: `npm test -- tests/cloudflare/githubDispatchWorker.test.ts`
  failed because `infra/cloudflare-github-dispatch/src/index.ts` did not exist. The
  failure was the intended missing-feature signal.
- GREEN checkpoint `1bd2b4f`: the same command passed all 11 initial behavior tests
  after the minimal dispatcher implementation.
- Final focused suite: 13 tests passed after adding missing-secret and non-JSON `2xx`
  coverage.

## Test specification

| Guarantee | Evidence | Result |
|---|---|---|
| All three UTC cron expressions select the intended workflow and `main` ref | Parameterized fetch-mock test | PASS |
| Dispatch uses the GitHub media type, API version, bearer token and JSON body | Request contract assertions | PASS |
| Current `200` responses and legacy empty `204` responses are accepted | Response tests | PASS |
| Other successful `2xx` bodies may be empty or non-JSON | `202` response test | PASS |
| Unknown cron and missing secret fail before any network request | Guard tests | PASS |
| `401`, `403`, `404` and `5xx` cause one attempt only | Parameterized error test | PASS |
| A token echoed in an error body is redacted from the thrown error | Secret-redaction assertion | PASS |
| Success logs contain schedule/run metadata but not the token | Structured-log assertions | PASS |
| Wrangler can bundle the scheduled handler and parse its configuration | `npm run cloudflare:check` | PASS |

## Final verification

- `npx vitest run tests/cloudflare/githubDispatchWorker.test.ts --coverage --coverage.include=infra/cloudflare-github-dispatch/src/index.ts`
  — 13 passed; statements 97.56%, branches 90.9%, functions 100%, lines 97.56%.
- `npm test` — 620 passed, 4 pre-existing tests skipped.
- `npm run lint` — passed.
- `npm run build` — passed.
- `npm run cloudflare:check` with Wrangler 4.76.0 — passed; bundle 2.90 KiB
  (1.26 KiB gzip). Wrangler reports that the `secrets` configuration field is
  experimental.
- `npm audit --audit-level=high` — no result: the npm registry audit endpoint twice
  returned a gzip payload that the installed npm client rejected as invalid JSON.
  This is an external validation gap, not a reported vulnerability result.

## Deployment gap

No Cloudflare login, secret upload, production deployment, or real GitHub dispatch was
performed. Production acceptance requires the operator-owned PAT and the next complete
scheduled cycle described in `README.md`.
