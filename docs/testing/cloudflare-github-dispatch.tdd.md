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
| All seven UTC cron expressions select the intended workflow and `main` ref, including both collection pairs and both watchdog windows | Parameterized fetch-mock test | PASS |
| Dispatch uses the GitHub media type, API version, bearer token and JSON body | Request contract assertions | PASS |
| The real `204 No Content` response is accepted | Response test | PASS |
| A hypothetical `2xx` carrying a JSON body is accepted and its run ids logged | Response test | PASS (speculative — see below) |
| Other successful `2xx` bodies may be empty or non-JSON | `202` response test | PASS |
| Unknown cron and missing secret fail before any network request | Guard tests | PASS |
| Permanent `4xx` responses cause one attempt; `429` and transient `5xx` responses get at most three attempts with 5/20-second backoff | Parameterized error and recovery tests | PASS |
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

End-to-end acceptance passed on the repeated watchdog-only smoke event:

- Cloudflare cron `40 10 26 7 *` was delivered at `2026-07-26T10:40:53Z`.
- Worker version `0493fdca-70ee-4298-961c-d70477d6cc16` completed with
  `outcome: ok`, no exceptions and GitHub HTTP `200`.
- GitHub created run `30198698959` with `event=workflow_dispatch`; the watchdog job
  completed successfully.
- The temporary smoke crons were then removed. Production version
  `a8180034-7874-4d28-946d-336d7a19b0ff` retains only the three documented daily
  schedules.

## 2026-08-14 scheduler resilience regression

Cloudflare delivered the 13:00 Almaty PK cron at `2026-08-14T08:00:37Z`, but the
Worker invocation ended with `scriptThrewException` after one GitHub subrequest. No
GitHub Actions run was created. The same Worker successfully dispatched the other
slots that day, so this change treats retryable GitHub HTTP responses as a bounded
transient failure rather than changing authentication or workflow configuration.

- RED checkpoint `f65b718`: 26 focused tests produced 8 intended failures. They
  demonstrated the missing retries, missing afternoon watchdog mapping/configuration,
  and missing window-specific dispatch input.
- GREEN checkpoint `05504c6`: all 26 focused tests passed after adding retry handling
  and the afternoon watchdog.
- Retries are limited to HTTP `429`, `500`, `502`, `503`, and `504`; the Worker makes
  at most three attempts with 5-second and 20-second delays. Permanent `4xx` errors
  remain single-attempt failures, and any echoed token is redacted.
- The `15 10 * * *` watchdog dispatch sends `window=afternoon`. It only accepts a PK
  collection created since 08:00 UTC and a main collection created since 09:30 UTC,
  preventing morning successes from masking a missed afternoon slot.

Verification before publication:

- Focused suite: 26 passed.
- Focused coverage: statements 96.49%, branches 88.57%, functions 100%, lines 96.49%.
- Full suite: 712 passed, 4 skipped.
- `npm run lint`, `npm run build`, and `npm run cloudflare:check`: passed.
- `npm audit --audit-level=high`: failed on 11 existing dependency findings
  (8 high, 2 moderate, 1 low). The forced remediation includes breaking upgrades
  to Wrangler and ExcelJS, so dependency upgrades remain outside this scheduler fix.

### Cloudflare Free cron limit

The first production deployment attempt uploaded the Worker code but Cloudflare
rejected the seven-trigger schedule with API error `10072`: the account's Free plan
allows five cron triggers. The existing five-trigger schedule remained the active
configuration.

- RED checkpoint `f137835`: the focused suite failed in 6 places after specifying
  consolidated cron expressions and time-sensitive routing.
- GREEN checkpoint `b832485`: two pairs are consolidated as `0 5,8 * * *` and
  `30 6,9 * * *`; the event's exact UTC hour selects the intended workflow. Together
  with the PK, F3, and afternoon-watchdog expressions, all seven daily slots fit in
  exactly five Cloudflare triggers.
- Unexpected times for a grouped expression fail before contacting GitHub.
- Final focused suite: 27 passed; statements 96.66%, branches 89.74%, functions
  100%, lines 96.66%.
- Final full suite: 713 passed, 4 skipped; lint, build, and Wrangler dry-run passed.

Production acceptance on 2026-08-14:

- Worker version `109b537f-2719-4120-b0ad-ee7da17b23ae` deployed successfully with
  exactly the five consolidated triggers.
- The real `15 10 * * *` Cloudflare event dispatched watchdog run `31791503491` at
  15:15 Almaty. It correctly failed while the recovery PK collection was still in
  progress, proving the afternoon alert does not accept an unfinished job.
- Recovery PK run `31789764101` then completed successfully. Its source searches
  returned zero rows for the current window, but the collection job itself completed
  and published its artifacts.
- Repeated afternoon watchdog run `31791626332` passed, identifying PK run
  `31789764101` and main run `31788376531` as successful collections after their
  respective afternoon boundaries.
