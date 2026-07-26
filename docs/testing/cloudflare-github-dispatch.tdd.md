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

### Production regression: required User-Agent

- Production smoke test on 2026-07-26 reached GitHub from the scheduled Cloudflare
  handler but received HTTP `403`: GitHub rejected the request because it did not
  contain a `User-Agent` header.
- RED checkpoint `59804bc`: the three request-contract cases failed after adding
  `User-Agent: scrape2lead-cloudflare-dispatch/1.0` to the expected GitHub request.
- GREEN checkpoint `04e824a`: the same 13-test suite passed after the Worker added
  that header. The change does not add retries or expose the token.

## Test specification

| Guarantee | Evidence | Result |
|---|---|---|
| All three UTC cron expressions select the intended workflow and `main` ref | Parameterized fetch-mock test | PASS |
| Dispatch uses the GitHub media type, API version, bearer token and JSON body | Request contract assertions | PASS |
| The real `204 No Content` response is accepted | Response test | PASS |
| A hypothetical `2xx` carrying a JSON body is accepted and its run ids logged | Response test | PASS (speculative — see below) |
| Other successful `2xx` bodies may be empty or non-JSON | `202` response test | PASS |
| Unknown cron and missing secret fail before any network request | Guard tests | PASS |
| `401`, `403`, `404` and `5xx` cause one attempt only | Parameterized error test | PASS |
| A token echoed in an error body is redacted from the thrown error | Secret-redaction assertion | PASS |
| Success logs contain schedule/run metadata but not the token | Structured-log assertions | PASS |
| Wrangler can bundle the scheduled handler and parse its configuration | `npm run cloudflare:check` | PASS |

## Measured response shape

The first draft of this document described `200` with a run identifier as the current
behaviour and `204` as legacy. That was backwards. Measured against the live API on
2026-07-26 with a real dispatch of `gz-watchdog.yml`:

```
HTTP/2.0 204 No Content
```

No body. `responseData()` returns `{}` for it, so a successful log entry carries
`status: 204` and no `workflowRunId` — a Cloudflare invocation is matched to its Actions
run by timestamp and the `workflow` field, not by an id. The branch that parses a JSON
body and logs `workflow_run_id` / `run_url` / `html_url` is therefore speculative: it is
correct if GitHub ever starts returning one, but nothing exercises it against reality,
and its tests assert a response GitHub does not currently send.

The same measurement settled the pinned API version. The response carried:

```
Deprecation: Tue, 10 Mar 2026 00:00:00 GMT
Sunset:      Fri, 10 Mar 2028 00:00:00 GMT
X-Github-Api-Version-Selected: 2022-11-28
```

`gh` had sent its default `2022-11-28`, and GitHub marked that version deprecated as of
exactly 2026-03-10 — the date `GITHUB_API_VERSION` pins. So the pin is current and
`2022-11-28` is the deprecated one; a review suggestion to "revert" to it would have been
a regression.

## Initial verification

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

## Regression verification

- Focused suite: 13 passed.
- Focused coverage: statements 97.59%, branches 90.9%, functions 100%, lines 97.59%.
- Full suite: 620 passed, 4 skipped.
- `npm run lint`, `npm run build` and `npm run cloudflare:check`: passed.
- `npm audit --audit-level=high`: failed with 19 dependency findings (17 high,
  1 moderate, 1 low). Suggested full remediation includes breaking upgrades to
  Wrangler, Vitest coverage and ExcelJS, so it is not bundled into this one-line
  production fix.

## Initial deployment gap

No Cloudflare login, secret upload, or production deployment was performed. Production
acceptance requires the operator-owned PAT and the next complete scheduled cycle
described in `README.md`.

A real GitHub dispatch *was* performed during review, outside Cloudflare: a direct
`POST /actions/workflows/gz-watchdog.yml/dispatches` against the live API, chosen because
the watchdog only reads the Actions API and writes nothing to the CRM. It produced run
30194181540 and the `204` measurement above. What remains unexercised is the Cloudflare
side — cron trigger delivery, secret binding, and Workers Logs — none of which this
review could reach without deploying.

## Production follow-up

Cloudflare login, secret upload and the first production deployment were performed on
2026-07-26. A one-off scheduled smoke event proved cron delivery and secret binding,
but GitHub rejected the request because the Worker omitted `User-Agent`; that is the
production regression covered by checkpoints `59804bc` and `04e824a`.

End-to-end acceptance requires repeating the one-off watchdog-only smoke event with
the fixed Worker and observing both a successful Workers Log entry and a GitHub run
with `event=workflow_dispatch`.
