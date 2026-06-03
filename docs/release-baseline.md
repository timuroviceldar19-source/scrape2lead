# Release Baseline: v0.3.0-2gis-quality-baseline

Date: 2026-06-03

## Scenario

`Новосибирск / Автосервисы / limit 50`

## Baseline Metrics

- Total leads: 50
- With phone: 50/50
- With address: 49/50
- With website: 25/50
- With email: 22/50
- With messengers: 38/50
- Incomplete: 0/50
- Details failed: 0
- Detail degraded: false

## Included Capabilities

- Bounded 2GIS query expansion.
- Marker/cluster synthesis with rejection diagnostics.
- Website crawl enrichment.
- Opt-in official website discovery.
- Opt-in directory contact discovery.
- Audit regression harness.
- Proxy/session health gate, including detail-stage degradation detection.

## Audit Interpretation

`PASS` means the search/detail environment is healthy enough to measure and all
baseline thresholds were met.

`FAIL` means the environment is healthy enough to measure, but one or more
metrics fell below the baseline thresholds. Treat this as a product or code
regression.

`ENVIRONMENT_BLOCKED` means the live audit could not be measured fairly because
of rate limiting, proxy failure, network timeout, blocked/empty 2GIS DOM, or
detail-stage degradation after the search gate passed. Treat this as an
environment issue, not a product regression.

## Regression Thresholds

- Total leads: `>= 50`
- Leads with phone: `>= 50`
- Leads with address: `>= 49`
- Leads with email: `>= 20`
- Incomplete leads: `<= 1`
- Details failed: `<= 2`
