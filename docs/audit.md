# Scrape2Lead Audit & Regression Harness

## Overview
To ensure pipeline stability and quality, we have an automated live audit and regression harness for the core 2GIS extraction scenario: **Новосибирск / Автосервисы (limit 50)**.

The audit script runs a full pipeline execution (discovery -> details -> website discovery -> website crawl -> directory enrichment) and asserts the final results against established baseline metrics.

## Running the Audit

```bash
# Run the programmatic harness with assertions
npm run audit:regression

# Or run the standard CLI for the same scenario (no assertions)
npm run audit:2gis:nsk-autoservice
```

## Baseline Thresholds
The harness enforces the following minimum quality standards:
- **Total leads:** >= 50
- **Leads with Phone:** >= 50
- **Leads with Address:** >= 49
- **Leads with Email:** >= 20
- **Incomplete leads:** <= 1
- **Details Failed:** <= 2

If a run fails to meet these thresholds, the script will exit with a non-zero status code and print a `REGRESSION DETECTED!` message.
