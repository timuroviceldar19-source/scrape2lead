import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseGoszakupAnnounceHtml,
  parseGoszakupLotsHtml,
  parseGoszakupContractHtml,
  parseGoszakupPagination
} from "../../src/kz/goszakupHtmlParser.js";

const FIXTURES = path.resolve("data/debug");

describe("parseGoszakupAnnounceHtml", () => {
  it("parses announce items from search results", () => {
    const htmlPath = path.join(FIXTURES, "goszakup-announce-search-all.html");
    if (!fs.existsSync(htmlPath)) {
      console.warn("Fixture not found, skipping test");
      return;
    }

    const html = fs.readFileSync(htmlPath, "utf8");
    const items = parseGoszakupAnnounceHtml(html);

    expect(items.length).toBeGreaterThan(0);

    const first = items[0];
    expect(first.number).toMatch(/^\d+-\d+$/);
    expect(first.name).toBeTruthy();
    expect(first.organizer).toBeTruthy();
    expect(first.method).toBeTruthy();
    expect(first.application_start).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(first.application_end).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(first.amount).toMatch(/[\d\s,.]+/);
    expect(first.status).toBeTruthy();
    expect(first.announce_id).toMatch(/^\d+$/);
  });

  it("returns empty array for empty results", () => {
    const html = `
      <table id="search-result">
        <tbody>
          <tr><td class="dataTables_empty">Ничего не найдено</td></tr>
        </tbody>
      </table>
    `;
    const items = parseGoszakupAnnounceHtml(html);
    expect(items).toHaveLength(0);
  });
});

describe("parseGoszakupLotsHtml", () => {
  it("parses lot items from search results", () => {
    const htmlPath = path.join(FIXTURES, "goszakup-lots-search-all.html");
    if (!fs.existsSync(htmlPath)) {
      console.warn("Fixture not found, skipping test");
      return;
    }

    const html = fs.readFileSync(htmlPath, "utf8");
    const items = parseGoszakupLotsHtml(html);

    expect(items.length).toBeGreaterThan(0);

    const first = items[0];
    expect(first.lot_number).toBeTruthy();
    expect(first.lot_name).toBeTruthy();
    expect(first.announce_number).toMatch(/^\d+-\d+$/);
    expect(first.customer).toBeTruthy();
    expect(first.quantity).toMatch(/^\d+$/);
    expect(first.amount).toMatch(/[\d\s,.]+/);
    expect(first.method).toBeTruthy();
    expect(first.status).toBeTruthy();
    expect(first.lot_id).toMatch(/^\d+$/);
    expect(first.trd_buy_id).toMatch(/^\d+$/);
  });

  it("returns empty array for empty results", () => {
    const html = `
      <table id="search-result">
        <tbody>
          <tr><td class="dataTables_empty">Ничего не найдено</td></tr>
        </tbody>
      </table>
    `;
    const items = parseGoszakupLotsHtml(html);
    expect(items).toHaveLength(0);
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

  it("returns zeros for no pagination", () => {
    const html = "<div>No pagination here</div>";
    const pagination = parseGoszakupPagination(html);
    expect(pagination.totalPages).toBe(1);
    expect(pagination.totalCount).toBe(0);
  });
});

describe("parseGoszakupContractHtml", () => {
  it("parses contract items from registry", () => {
    const htmlPath = path.join(FIXTURES, "goszakup-contracts-061040006408.html");
    if (!fs.existsSync(htmlPath)) {
      console.warn("Fixture not found, skipping test");
      return;
    }

    const html = fs.readFileSync(htmlPath, "utf8");
    const items = parseGoszakupContractHtml(html);

    expect(items.length).toBeGreaterThan(0);

    const first = items[0];
    expect(first.contract_id).toMatch(/^\d+$/);
    expect(first.contract_number).toBeTruthy();
    expect(first.contract_type).toMatch(/Основной договор|Дополнительное соглашение/);
    expect(first.status).toMatch(/Исполнен|Действует|Не заключен/);
    expect(first.created_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(first.amount).toMatch(/[\d\s,.]+/);
    expect(first.customer).toBeTruthy();
    expect(first.supplier).toBeTruthy();
    expect(first.method).toBeTruthy();
    expect(first.url).toMatch(/egzcontract/);
  });

  it("returns empty array for empty results", () => {
    const html = `
      <table id="search-result">
        <tbody>
          <tr><td class="dataTables_empty">Ничего не найдено</td></tr>
        </tbody>
      </table>
    `;
    const items = parseGoszakupContractHtml(html);
    expect(items).toHaveLength(0);
  });
});
