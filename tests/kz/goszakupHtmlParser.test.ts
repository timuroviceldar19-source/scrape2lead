import { describe, expect, it } from "vitest";
import {
  parseGoszakupAnnounceHtml,
  parseGoszakupLotsHtml,
  parseGoszakupContractHtml,
  parseGoszakupPagination
} from "../../src/kz/goszakupHtmlParser.js";

const EMPTY_RESULTS = `
  <table id="search-result">
    <tbody><tr><td class="dataTables_empty">Ничего не найдено</td></tr></tbody>
  </table>
`;

describe("goszakup HTML empty results", () => {
  it("returns no announcements", () => {
    expect(parseGoszakupAnnounceHtml(EMPTY_RESULTS)).toEqual([]);
  });

  it("returns no lots", () => {
    expect(parseGoszakupLotsHtml(EMPTY_RESULTS)).toEqual([]);
  });

  it("returns no contracts", () => {
    expect(parseGoszakupContractHtml(EMPTY_RESULTS)).toEqual([]);
  });
});

describe("parseGoszakupPagination", () => {
  it("extracts pagination info", () => {
    const html = `
      <a href="?page=0">1</a>
      <a href="?page=1">2</a>
      <a href="?page=2">3</a>
      <select><option value="50">50</option></select>
      infoFiltered (найдено из 150 заказов)
    `;
    const pagination = parseGoszakupPagination(html);
    expect(pagination.totalPages).toBe(3);
    expect(pagination.totalCount).toBe(150);
  });

  it("returns defaults when pagination is absent", () => {
    expect(parseGoszakupPagination("<div>No pagination here</div>")).toEqual({
      currentPage: 0,
      totalPages: 1,
      totalCount: 0
    });
  });
});
