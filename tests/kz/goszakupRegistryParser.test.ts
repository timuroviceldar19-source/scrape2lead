import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizePhone, normalizeWebsite, parseRegistryProfileHtml, parseRegistrySearchHtml } from "../../src/kz/goszakupRegistryParser.js";

const FIXTURES = path.resolve("tests/fixtures");

describe("parseRegistrySearchHtml", () => {
  it("extracts participant_id from search results table", () => {
    const html = fs.readFileSync(path.join(FIXTURES, "goszakup-registry-search-960440000716.html"), "utf8");
    const result = parseRegistrySearchHtml(html, "960440000716");

    expect(result).not.toBeNull();
    expect(result?.participant_id).toBe("31664");
    expect(result?.profile_url).toBe("https://goszakup.gov.kz/ru/registry/show_supplier/31664");
  });

  it("returns null when BIN not found", () => {
    const html = fs.readFileSync(path.join(FIXTURES, "goszakup-registry-search-960440000716.html"), "utf8");
    const result = parseRegistrySearchHtml(html, "000000000000");
    expect(result).toBeNull();
  });
});

describe("parseRegistryProfileHtml", () => {
  it("parses profile card with phone, email, website", () => {
    const html = fs.readFileSync(path.join(FIXTURES, "goszakup-registry-profile-960440000716.html"), "utf8");
    const record = parseRegistryProfileHtml(html, "960440000716");

    expect(record).not.toBeNull();
    expect(record?.bin).toBe("960440000716");
    expect(record?.participant_id).toBe("31664");
    expect(record?.name_ru).toContain("Нефтяная страховая компания");
    expect(record?.email).toBe("info@nsk.kz");
    expect(record?.phone).toBe("+77272581800");
    expect(record?.website).toBe("https://www.nsk.kz");
    expect(record?.role).toBe("Поставщик");
    expect(record?.kopf).toBe("Акционерное общество");
    expect(record?.registration_date).toBe("2001-03-15");
    expect(record?.director_name).toBe("Иванов Иван Иванович");
    expect(record?.director_iin).toBe("850101300012");
    expect(record?.legal_address).toContain("Жандосова");
  });

  it("returns null on BIN mismatch", () => {
    const html = fs.readFileSync(path.join(FIXTURES, "goszakup-registry-profile-960440000716.html"), "utf8");
    const record = parseRegistryProfileHtml(html, "123456789012");
    expect(record).toBeNull();
  });

  it("parses reporting administrator and contact address grid", () => {
    const html = fs.readFileSync(path.join(FIXTURES, "goszakup-registry-profile-school.html"), "utf8");
    const record = parseRegistryProfileHtml(html, "000240001420");

    expect(record).not.toBeNull();
    expect(record?.reporting_administrator).toBe('ГУ "Управление образования Карагандинской области"');
    expect(record?.full_address_ru).toContain("Карагандинская область, г.Сарань");
    expect(record?.legal_address).toContain("УШАКОВА, 8/1");
    expect(record?.participant_id).toBe("12345");
  });

});

describe("phone normalization", () => {
  it("normalizes various phone formats", () => {
    const baseHtml = `<div class="divTableCell">БИН участника</div><div class="divTableCell">123456789012</div>`;

    const withPlus = baseHtml + `<div class="divTableCell">Контактный телефон</div><div class="divTableCell">+77272581800</div>`;
    expect(parseRegistryProfileHtml(withPlus, "123456789012")?.phone).toBe("+77272581800");

    const withSpaces = baseHtml + `<div class="divTableCell">Контактный телефон</div><div class="divTableCell">+7 (727) 258-18-00</div>`;
    expect(parseRegistryProfileHtml(withSpaces, "123456789012")?.phone).toBe("+77272581800");

    const withEight = baseHtml + `<div class="divTableCell">Контактный телефон</div><div class="divTableCell">87272581800</div>`;
    expect(parseRegistryProfileHtml(withEight, "123456789012")?.phone).toBe("+77272581800");
  });
});

describe("website normalization", () => {
  it("adds https:// when scheme is missing", () => {
    const baseHtml = `<div class="divTableCell">БИН участника</div><div class="divTableCell">123456789012</div>`;

    const noScheme = baseHtml + `<div class="divTableCell">Веб-сайт</div><div class="divTableCell">example.kz</div>`;
    expect(parseRegistryProfileHtml(noScheme, "123456789012")?.website).toBe("https://example.kz");

    const withScheme = baseHtml + `<div class="divTableCell">Веб-сайт</div><div class="divTableCell">https://example.kz</div>`;
    expect(parseRegistryProfileHtml(withScheme, "123456789012")?.website).toBe("https://example.kz");
  });
});

describe("normalizePhone", () => {
  it("accepts +7XXXXXXXXXX format", () => {
    expect(normalizePhone("+77272581800")).toBe("+77272581800");
  });
  it("accepts formatted phone with spaces and dashes", () => {
    expect(normalizePhone("+7 (727) 258-18-00")).toBe("+77272581800");
  });
  it("converts 8XXXXXXXXXX to +7", () => {
    expect(normalizePhone("87272581800")).toBe("+77272581800");
  });
  it("accepts valid KZ mobile", () => {
    expect(normalizePhone("+77071017793")).toBe("+77071017793");
  });
  it("rejects goszakup service phone", () => {
    expect(normalizePhone("+7 (7172) 73-55-15")).toBeNull();
  });
  it("rejects concatenated garbage", () => {
    expect(normalizePhone("+34369387011878787")).toBeNull();
  });
  it("rejects null input", () => {
    expect(normalizePhone(null)).toBeNull();
  });
  it("rejects empty string", () => {
    expect(normalizePhone("")).toBeNull();
  });
});

describe("normalizeWebsite", () => {
  it("adds https:// for plain domain", () => {
    expect(normalizeWebsite("www.nsk.kz")).toBe("https://www.nsk.kz");
  });
  it("preserves existing https scheme", () => {
    expect(normalizeWebsite("https://www.zharykled.kz")).toBe("https://www.zharykled.kz");
  });
  it("preserves existing http scheme", () => {
    expect(normalizeWebsite("http://royalfitness.kz/")).toBe("http://royalfitness.kz/");
  });
  it("rejects email in website field", () => {
    expect(normalizeWebsite("pernebeknps10@mail.ru")).toBeNull();
  });
  it("rejects placeholder dash", () => {
    expect(normalizeWebsite("-")).toBeNull();
  });
  it("rejects placeholder em-dash", () => {
    expect(normalizeWebsite("—")).toBeNull();
  });
  it("rejects placeholder text", () => {
    expect(normalizeWebsite("нет")).toBeNull();
    expect(normalizeWebsite("n/a")).toBeNull();
    expect(normalizeWebsite("отсутствует")).toBeNull();
  });
  it("rejects null and empty", () => {
    expect(normalizeWebsite(null)).toBeNull();
    expect(normalizeWebsite("")).toBeNull();
  });
  it("rejects hostname without dot", () => {
    expect(normalizeWebsite("localhost")).toBeNull();
  });
  it("rejects goszakup service domains", () => {
    expect(normalizeWebsite("https://satypalu.gov.kz/")).toBeNull();
    expect(normalizeWebsite("https://goszakup.gov.kz/ru/registry/show_supplier/1")).toBeNull();
  });
});
