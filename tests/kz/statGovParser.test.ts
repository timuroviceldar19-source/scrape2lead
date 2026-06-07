import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseStatGovHtml } from "../../src/kz/statGovParser.js";

describe("parseStatGovHtml", () => {
  it("parses stat.gov fixture without inventing legal_status", () => {
    const fixture = path.resolve("data/debug/stat-gov-220540025781.html");
    const html = fs.readFileSync(fixture, "utf8");

    const record = parseStatGovHtml(html);

    expect(record).not.toBeNull();
    expect(record?.bin).toBe("220540025781");
    expect(record?.oked).toBe("46610");
    expect(record?.director).toContain("БЕГИШЕВА");
    expect(record?.legal_status).toBe("unknown");
  });
});
