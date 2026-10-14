import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  assertAllowedFileUrl,
  extractDocxText,
  fetchAnnouncementContacts,
  loadSpecFile
} from "../../src/assistant/portalReaders.js";

const ANNOUNCE_HTML = `
<table>
  <tr><th>Организатор</th><td>120540004946 КГУ "Отдел образования"</td></tr>
  <tr><th>Юр. адрес организатора</th><td>г. Тараз, ул. Тестовая, 1</td></tr>
</table>
<div><b>Информация об организаторе</b></div>
<table>
  <tr><th>ФИО представителя</th><td>ИВАНОВ ИВАН ИВАНОВИЧ</td></tr>
  <tr><th>Должность</th><td>Эксперт-закупщик</td></tr>
  <tr><th>E-Mail</th><td>zakup@example.kz</td></tr>
</table>`;

function htmlFetch(html: string, status = 200): { fetchFn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(html, { status });
  }) as typeof fetch;
  return { fetchFn, urls };
}

function bytesFetch(bytes: Uint8Array, status = 200): typeof fetch {
  return (async () => new Response(bytes as unknown as BodyInit, { status })) as typeof fetch;
}

async function docxBytes(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

describe("fetchAnnouncementContacts", () => {
  it("reads the customer and the representative from the announcement page", async () => {
    const { fetchFn, urls } = htmlFetch(ANNOUNCE_HTML);

    const result = await fetchAnnouncementContacts(17294202, fetchFn);

    expect(urls[0]).toMatch(/\/ru\/announce\/index\/17294202$/);
    expect(result).toEqual({
      announceId: 17294202,
      customer: { bin: "120540004946", name: 'КГУ "Отдел образования"', legalAddress: "г. Тараз, ул. Тестовая, 1" },
      representative: { fullName: "ИВАНОВ ИВАН ИВАНОВИЧ", position: "Эксперт-закупщик", email: "zakup@example.kz" }
    });
  });

  it("fails clearly when the portal answers with an error status", async () => {
    const { fetchFn } = htmlFetch("oops", 503);

    await expect(fetchAnnouncementContacts(1, fetchFn)).rejects.toThrow(/503/);
  });
});

describe("extractDocxText", () => {
  it("returns one line per paragraph", async () => {
    const text = await extractDocxText(await docxBytes(["Требования к поставщику", "Тел. +7 700 000 00 00"]));

    expect(text).toBe("Требования к поставщику\nТел. +7 700 000 00 00");
  });
});

describe("assertAllowedFileUrl", () => {
  it.each(["https://ows.goszakup.gov.kz/files/2", "https://v3bl.goszakup.gov.kz/files/x", "https://procurement.gov.kz/ru/download_file/1/2/"])(
    "accepts %s",
    (url) => {
      expect(() => assertAllowedFileUrl(url)).not.toThrow();
    }
  );

  it.each([
    "http://ows.goszakup.gov.kz/files/2",
    "https://evil.example.com/files/2",
    "https://ows.goszakup.gov.kz@evil.example.com/files/2",
    "https://ows.goszakup.gov.kz.evil.example.com/x",
    "file:///etc/passwd",
    "not a url"
  ])("rejects %s", (url) => {
    expect(() => assertAllowedFileUrl(url)).toThrow();
  });
});

describe("loadSpecFile", () => {
  it("extracts text from a Word file", async () => {
    const file = await loadSpecFile("https://ows.goszakup.gov.kz/files/1", bytesFetch(await docxBytes(["Контакт: Иванов"])));

    expect(file).toEqual({ kind: "docx", text: "Контакт: Иванов" });
  });

  it("hands a PDF over as base64", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7 fake");

    const file = await loadSpecFile("https://ows.goszakup.gov.kz/files/2", bytesFetch(pdf));

    expect(file).toEqual({ kind: "pdf", base64: Buffer.from(pdf).toString("base64"), bytes: pdf.length });
  });

  it("does not claim to read formats it cannot read", async () => {
    const file = await loadSpecFile("https://ows.goszakup.gov.kz/files/3", bytesFetch(new TextEncoder().encode("MZ binary")));

    expect(file.kind).toBe("unsupported");
  });

  it("refuses files above the size limit", async () => {
    const big = new Uint8Array(16 * 1024 * 1024);
    big.set(new TextEncoder().encode("%PDF"));

    await expect(loadSpecFile("https://ows.goszakup.gov.kz/files/4", bytesFetch(big))).rejects.toThrow(/размер|size/i);
  });

  it("refuses a url outside the portal before downloading", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response("x");
    }) as typeof fetch;

    await expect(loadSpecFile("https://evil.example.com/a.pdf", fetchFn)).rejects.toThrow();
    expect(called).toBe(false);
  });
});
