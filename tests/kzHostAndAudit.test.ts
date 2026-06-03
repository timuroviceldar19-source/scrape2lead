import { describe, it, expect } from "vitest";
import { buildSearchUrl, citySegment } from "../src/adapters/2gis/TwoGisAdapter.js";
import { evaluateAuditMetrics, summarizeAuditMetrics, evaluateDetailEnvironment, classifyAuditRuntimeEnvironmentError } from "../scripts/auditRegression.js";
import type { Lead } from "../src/types.js";

describe("2GIS Host Configuration", () => {
  it("builds RU URLs by default", () => {
    expect(buildSearchUrl("Новосибирск", "Автосервисы")).toBe("https://2gis.ru/novosibirsk/search/%D0%90%D0%B2%D1%82%D0%BE%D1%81%D0%B5%D1%80%D0%B2%D0%B8%D1%81%D1%8B");
  });

  it("builds KZ URLs when baseUrl is provided", () => {
    expect(buildSearchUrl("Астана", "Автосервисы", "https://2gis.kz")).toBe("https://2gis.kz/astana/search/%D0%90%D0%B2%D1%82%D0%BE%D1%81%D0%B5%D1%80%D0%B2%D0%B8%D1%81%D1%8B");
  });

  it("handles Astana city segment correctly", () => {
    expect(() => citySegment("Астана")).not.toThrow();
  });
});

describe("Audit Metrics Evaluation", () => {
  it("classifies partial 18/50 timeout as FAIL (not PASS)", () => {
    const leads: Lead[] = Array.from({ length: 18 }, (_, i) => ({
      source: "2gis",
      external_id: `${i}`,
      company_name: `Test ${i}`,
      category: "Автосервисы",
      city: "Новосибирск",
      address: "Address",
      phones: ["+71234567890"],
      email: null,
      website: null,
      social_links: [],
      messenger_links: [],
      parsed_at: new Date().toISOString(),
      incomplete: false
    }));

    const metrics = summarizeAuditMetrics(leads, { detailsFailed: 0 });
    const evaluation = evaluateAuditMetrics(metrics);
    
    expect(evaluation.status).toBe("FAIL");
    expect(evaluation.failures).toContain("Total leads 18 < baseline 50");
  });

  it("classifies full 50/50 with no failures as PASS", () => {
    const leads: Lead[] = Array.from({ length: 50 }, (_, i) => ({
      source: "2gis",
      external_id: `${i}`,
      company_name: `Test ${i}`,
      category: "Автосервисы",
      city: "Новосибирск",
      address: "Address",
      phones: ["+71234567890"],
      email: "test@test.com",
      website: "http://test.com",
      social_links: [],
      messenger_links: [],
      parsed_at: new Date().toISOString(),
      incomplete: false
    }));

    const metrics = summarizeAuditMetrics(leads, { detailsFailed: 0 });
    const evaluation = evaluateAuditMetrics(metrics);
    
    expect(evaluation.status).toBe("PASS");
    expect(evaluation.failures).toHaveLength(0);
  });
});

describe("Environment Block Classification", () => {
  it("classifies soft block as ENVIRONMENT_BLOCKED", () => {
    const error = new Error("soft_blocked: 2GIS rendered an empty-results page with throttling/soft-block signals");
    const result = classifyAuditRuntimeEnvironmentError(error, true);
    
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("blocked_dom");
  });

  it("classifies proxy timeout as ENVIRONMENT_BLOCKED", () => {
    const error = new Error("net::ERR_PROXY_CONNECTION_FAILED");
    const result = classifyAuditRuntimeEnvironmentError(error, true);
    
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("proxy_timeout");
  });

  it("evaluates detail environment blocked correctly", () => {
    const diagnostics = {
      detailDomFallbacks: 0,
      detailDomSparseFallbacks: 0,
      detailDomTimeouts: 5,
      detailDomTunnelFailures: 0,
      detailDomProxyFailures: 0,
      detailDomNetworkFailures: 0,
      detailBlocked: 0,
      detailDegraded: true
    };

    const result = evaluateDetailEnvironment(diagnostics);
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("detail_timeouts");
  });
});
