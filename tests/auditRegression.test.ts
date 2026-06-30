import { describe, expect, it } from "vitest";
import {
  classifyHealthGateError,
  classifyHealthGateSnapshot,
  type HealthGateSnapshot
} from "../scripts/archive/auditHealthGate.js";
import {
  classifyAuditRuntimeEnvironmentError,
  evaluateAuditMetrics,
  evaluateDetailEnvironment,
  type AuditDiagnosticsSummary,
  type AuditMetrics
} from "../scripts/archive/auditRegression.js";

function snapshot(overrides: Partial<HealthGateSnapshot>): HealthGateSnapshot {
  return {
    url: "https://2gis.ru/novosibirsk/search/%D0%90%D0%B2%D1%82%D0%BE",
    httpStatus: 200,
    responseStatuses: [200],
    title: "2GIS",
    bodyText: "",
    apiCards: 0,
    domCards: 0,
    ...overrides
  };
}

function metrics(overrides: Partial<AuditMetrics>): AuditMetrics {
  return {
    total: 50,
    phone: 50,
    address: 49,
    website: 20,
    email: 20,
    messengers: 0,
    incomplete: 1,
    detailsFailed: 2,
    ...overrides
  };
}

function diagnostics(overrides: Partial<AuditDiagnosticsSummary>): AuditDiagnosticsSummary {
  return {
    detailsAttempted: 50,
    detailsFailed: 0,
    detailDomFallbacks: 0,
    detailDomSparseFallbacks: 0,
    detailDomTimeouts: 0,
    detailDomTunnelFailures: 0,
    detailDomProxyFailures: 0,
    detailDomNetworkFailures: 0,
    detailBlocked: 0,
    detailDegraded: false,
    websiteDiscoverySucceeded: 0,
    websiteCrawlSucceeded: 0,
    directoryDiscoverySucceeded: 0,
    ...overrides
  };
}

describe("audit health gate classifier", () => {
  it("classifies a 429 response as ENVIRONMENT_BLOCKED rate_limited", () => {
    const result = classifyHealthGateSnapshot(snapshot({
      httpStatus: 429,
      responseStatuses: [200, 429],
      title: "Too Many Requests",
      bodyText: "<html>Too Many Requests</html>"
    }));

    expect(result).toMatchObject({
      status: "environment_blocked",
      reason: "rate_limited",
      httpStatus: 429
    });
  });

  it("classifies timeout errors as network or proxy environment blocks", () => {
    const network = classifyHealthGateError(
      new Error("page.goto: Timeout 15000ms exceeded"),
      "https://2gis.ru/novosibirsk/search/autoservice",
      false
    );
    const proxy = classifyHealthGateError(
      new Error("net::ERR_TUNNEL_CONNECTION_FAILED while connecting through proxy"),
      "https://2gis.ru/novosibirsk/search/autoservice",
      true
    );

    expect(network).toMatchObject({
      status: "environment_blocked",
      reason: "network_timeout"
    });
    expect(proxy).toMatchObject({
      status: "environment_blocked",
      reason: "proxy_timeout"
    });
  });

  it("lets a healthy sample continue to the full audit", () => {
    const result = classifyHealthGateSnapshot(snapshot({
      apiCards: 2,
      domCards: 0,
      bodyText: "Results loaded"
    }));

    expect(result).toMatchObject({
      status: "ok",
      apiCards: 2
    });
  });

  it("classifies an empty blocked DOM as ENVIRONMENT_BLOCKED blocked_dom", () => {
    const result = classifyHealthGateSnapshot(snapshot({
      bodyText: "Loaded shell without firm cards"
    }));

    expect(result).toMatchObject({
      status: "environment_blocked",
      reason: "blocked_dom"
    });
  });
});

describe("audit regression metric classifier", () => {
  it("classifies healthy audit metrics as PASS", () => {
    expect(evaluateAuditMetrics(metrics({}))).toEqual({
      status: "PASS",
      failures: []
    });
  });

  it("classifies healthy-environment bad metrics as FAIL, not ENVIRONMENT_BLOCKED", () => {
    const environment = evaluateDetailEnvironment(diagnostics({}));
    const result = evaluateAuditMetrics(metrics({
      total: 49,
      phone: 0,
      address: 0,
      email: 0,
      incomplete: 49,
      detailsFailed: 3
    }));

    expect(environment).toBeNull();
    expect(result.status).toBe("FAIL");
    expect(result.failures).toEqual(expect.arrayContaining([
      "Total leads 49 < baseline 50",
      "Leads with phone 0 < baseline 50",
      "Details failed 3 > baseline 2"
    ]));
  });

  it("classifies passed search health plus detail sparse timeout fallback as ENVIRONMENT_BLOCKED", () => {
    const result = evaluateDetailEnvironment(diagnostics({
      detailsFailed: 0,
      detailDomFallbacks: 23,
      detailDomSparseFallbacks: 23,
      detailDomTimeouts: 23,
      detailDegraded: true
    }));

    expect(result).toMatchObject({
      status: "ENVIRONMENT_BLOCKED",
      reason: "detail_timeouts"
    });
  });

  it("does not let detailsFailed=0 hide detail-stage degradation", () => {
    const result = evaluateDetailEnvironment(diagnostics({
      detailsFailed: 0,
      detailDomFallbacks: 4,
      detailDomSparseFallbacks: 4,
      detailDegraded: true
    }));

    expect(result).toMatchObject({
      status: "ENVIRONMENT_BLOCKED",
      reason: "detail_sparse_fallback"
    });
  });
});

describe("audit runtime environment classifier", () => {
  it("classifies full-run 429 errors as ENVIRONMENT_BLOCKED rate_limited", () => {
    expect(classifyAuditRuntimeEnvironmentError(new Error("HTTP 429 Too Many Requests"), true)).toMatchObject({
      reason: "rate_limited"
    });
  });

  it("classifies full-run navigation timeouts after a passed search gate as environment blocks", () => {
    expect(classifyAuditRuntimeEnvironmentError(new Error("page.goto: Timeout 60000ms exceeded"), false)).toMatchObject({
      reason: "network_timeout"
    });
    expect(classifyAuditRuntimeEnvironmentError(new Error("page.goto: Timeout 60000ms exceeded"), true)).toMatchObject({
      reason: "proxy_timeout"
    });
  });
});
