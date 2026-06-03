# Scrape2Lead Audit & Regression Harness

## Overview

The live audit regression harness validates the core 2GIS extraction scenario:
**Novosibirsk / Autoservices (limit 50)**.

The script first runs a short proxy/session health gate. Only if the environment
looks measurable does it run the expensive full pipeline:

1. 2GIS discovery
2. details extraction
3. website discovery
4. website crawl
5. directory contact enrichment
6. baseline assertions

This separates a real product regression from an unhealthy live environment.

## Running the Audit

```bash
# Programmatic harness with health gate and assertions
npm run audit:regression

# Standard CLI for the same scenario, without regression assertions
npm run audit:2gis:nsk-autoservice
```

## Outcomes

`PASS` means the health gate passed, the full live audit ran, and every baseline
was met. Exit code: `0`.

`FAIL` means the health gate passed, so the environment was healthy enough to
measure, but the pipeline failed one or more baselines. Treat this as a code or
product regression. Exit code: `1`.

`ENVIRONMENT_BLOCKED` means the health gate could not fairly measure 2GIS before
the expensive run. The full audit is skipped. Treat this as proxy/session/network
work, not a pipeline regression. Exit code: `2`.

Common `ENVIRONMENT_BLOCKED` reasons:

- `rate_limited`: 2GIS returned `429 Too Many Requests` or equivalent text.
- `proxy_timeout`: a configured proxy failed, timed out, or could not tunnel.
- `network_timeout`: the search page did not load within the bounded probe.
- `blocked_dom`: the page loaded but exposed no start cards because 2GIS served
  a CAPTCHA, browser wall, empty soft-block page, or otherwise blocked DOM.
- `http_error`: the search page returned another non-OK HTTP status.

## Baseline Thresholds

The harness enforces these thresholds and must not be weakened:

- Total leads: `>= 50`
- Leads with phone: `>= 50`
- Leads with address: `>= 49`
- Leads with email: `>= 20`
- Incomplete leads: `<= 1`
- Details failed: `<= 2`

## Proxy Requirement

A fair live 2GIS audit requires a healthy proxy/session. Direct no-proxy runs are
likely to hit 429s, CAPTCHA/browser walls, or empty DOM fallback timeouts. Use
the configured proxy environment before treating any metric drop as a regression:

```bash
PROXY_SERVER=http://host:port
PROXY_USERNAME=optional
PROXY_PASSWORD=optional
```

The audit runner loads `.env` via `dotenv/config`, so these variables may live in
the local `.env` file.

## What To Do On 429

If the harness prints `ENVIRONMENT_BLOCKED reason=rate_limited`, do not lower
thresholds and do not classify the run as a regression. Rotate or replace the
proxy/session, wait for the rate limit to cool down, then rerun:

```bash
npm run audit:regression
```
