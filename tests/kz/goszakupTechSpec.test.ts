import { describe, expect, it } from "vitest";
import {
  extractAnnounceId,
  parseSpecFiles,
  parseSpecGroupId,
  selectSpecFileForLot
} from "../../src/kz/goszakupTechSpec.js";

// Trimmed from a real ОК "Документация" page (anno 17294202). The spec row
// carries the modal button (group 3325); the "Дополнительные файлы" row also
// mentions спецификация but has no button and must be ignored.
const OK_DOCS_HTML = `
<table>
  <tr>
    <td>Перечень документов</td><td>Да</td>
    <td><button onclick="actionModalShowFiles(17294202,3323);">Перейти</button></td>
  </tr>
  <tr>
    <td>Приложение 13 (Техническая спецификация закупаемых товаров)</td>
    <td>Да</td>
    <td><button onclick="actionModalShowFiles(17294202,3325);">Перейти</button></td>
  </tr>
  <tr>
    <td>Дополнительные файлы для тех. спецификации</td>
    <td>Нет</td>
    <td></td>
  </tr>
</table>`;

// ЗЦП page (anno 17293619): plain "Техническая спецификация" row, group 125,
// Признак column says "Нет" yet the button is present (column is unreliable).
const ZCP_DOCS_HTML = `
<table>
  <tr>
    <td>Техническая спецификация</td><td>Нет</td>
    <td><button onclick="actionModalShowFiles(17293619,125);">Перейти</button></td>
  </tr>
</table>`;

// Modal file list for a multi-lot ОК: one PDF per lot, plus header row and a
// separate signature link that must not be mistaken for the download.
const OK_MODAL_HTML = `
<table class="table table-bordered">
  <tr><th>Номер лота</th><th>Документ</th><th>Подпись</th></tr>
  <tr>
    <td>80876559-ОК1</td>
    <td><a href="https://v3bl.goszakup.gov.kz/files/download_file/310332512/222524958/">techspec_17294202_42515180.pdf</a></td>
    <td><a href="https://goszakup.gov.kz/ru/files/signature/download_cms/m/310332512">Скачать подпись</a></td>
  </tr>
  <tr>
    <td>80892179-ОК1</td>
    <td><a href="https://v3bl.goszakup.gov.kz/files/download_file/310334334/222526391/">techspec_17294202_42515181.pdf</a></td>
    <td><a href="https://goszakup.gov.kz/ru/files/signature/download_cms/m/310334334">Скачать подпись</a></td>
  </tr>
</table>`;

const ZCP_MODAL_HTML = `
<table class="table table-bordered">
  <tr><th>Номер лота</th><th>Документ</th></tr>
  <tr>
    <td>82982126-ЗЦП1</td>
    <td><a href="https://v3bl.goszakup.gov.kz/files/download_file/310267654/222478198/">techspec_17293619_42514097.pdf</a></td>
  </tr>
</table>`;

describe("parseSpecGroupId", () => {
  it("returns the technical spec group id, ignoring the button-less decoy row", () => {
    expect(parseSpecGroupId(OK_DOCS_HTML)).toBe("3325");
  });

  it("finds the group id even when the Признак column says Нет", () => {
    expect(parseSpecGroupId(ZCP_DOCS_HTML)).toBe("125");
  });

  it("returns null when no spec row exposes a files modal", () => {
    const html = `<table><tr><td>Приложение 2 (Соглашение)</td><td>Да</td><td></td></tr></table>`;
    expect(parseSpecGroupId(html)).toBeNull();
  });
});

describe("parseSpecFiles", () => {
  it("maps each lot to its download link, skipping header and signature links", () => {
    expect(parseSpecFiles(OK_MODAL_HTML)).toEqual([
      {
        lotNumber: "80876559-ОК1",
        fileName: "techspec_17294202_42515180.pdf",
        downloadUrl: "https://v3bl.goszakup.gov.kz/files/download_file/310332512/222524958/"
      },
      {
        lotNumber: "80892179-ОК1",
        fileName: "techspec_17294202_42515181.pdf",
        downloadUrl: "https://v3bl.goszakup.gov.kz/files/download_file/310334334/222526391/"
      }
    ]);
  });

  it("parses a single-file modal", () => {
    const files = parseSpecFiles(ZCP_MODAL_HTML);
    expect(files).toHaveLength(1);
    expect(files[0].lotNumber).toBe("82982126-ЗЦП1");
  });

  it("returns an empty array when the modal has no downloadable files", () => {
    expect(parseSpecFiles("<table><tr><th>Номер лота</th></tr></table>")).toEqual([]);
  });
});

describe("selectSpecFileForLot", () => {
  const files = parseSpecFiles(OK_MODAL_HTML);

  it("matches the file for the requested lot number", () => {
    expect(selectSpecFileForLot(files, "80892179-ОК1")?.fileName).toBe("techspec_17294202_42515181.pdf");
  });

  it("falls back to the sole file when only one exists", () => {
    const single = parseSpecFiles(ZCP_MODAL_HTML);
    expect(selectSpecFileForLot(single, "unknown-lot")?.lotNumber).toBe("82982126-ЗЦП1");
  });

  it("returns null when several files exist and none match", () => {
    expect(selectSpecFileForLot(files, "99999999-ОК9")).toBeNull();
  });
});

describe("extractAnnounceId", () => {
  it("extracts the announce id from an announce URL", () => {
    expect(extractAnnounceId("https://goszakup.gov.kz/ru/announce/index/17294202")).toBe("17294202");
    expect(extractAnnounceId("https://goszakup.gov.kz/ru/announce/index/17294202?tab=lots")).toBe("17294202");
  });

  it("returns null for a non-announce URL", () => {
    expect(extractAnnounceId("https://goszakup.gov.kz/ru/registry/show_plan/123")).toBeNull();
  });
});
