import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  backfillCompetitors,
  collectCompetitors,
  DEFAULT_CAPTCHA_PAUSE_MS,
  DEFAULT_MAX_CAPTCHA_RETRIES,
  discoverCompetitorLots
} from "../../src/kz/competitors/collector.js";
import { updateCompetitorsWindow } from "../../src/kz/competitors/load.js";
import { CompetitorsStorage } from "../../src/kz/competitors/storage.js";
import { loadCompetitorsConfig } from "../../src/kz/competitors/config.js";

// Все названия, БИН и суммы в этом файле выдуманные.

const SEARCH_HTML = `
  <div>Показано с 1 по 2 из 2 записей</div>
  <table id="search-result"><tbody>
    <tr>
      <td><strong>90002001-ОК1</strong></td>
      <td><a href="/ru/announce/index/29002001"><strong>29002001-1 Закупка панели</strong></a><br>Заказчик: КГУ "Тест Школа"</td>
      <td><a href="https://procurement.gov.kz/ru/subpriceoffer/index/29002001/60001">Панель интерактивная</a></td>
      <td>1</td><td>1 000 000</td><td>Открытый конкурс</td><td>Закупка состоялась</td>
    </tr>
    <tr>
      <td><strong>90002002-ОК1</strong></td>
      <td><a href="/ru/announce/index/29002002"><strong>29002002-1 Закупка панели открытая</strong></a><br>Заказчик: КГУ "Тест Лицей"</td>
      <td><a href="https://procurement.gov.kz/ru/subpriceoffer/index/29002002/60002">Панель интерактивная</a></td>
      <td>1</td><td>1 200 000</td><td>Открытый конкурс</td><td>Опубликован (прием заявок)</td>
    </tr>
  </tbody></table>
`;

const SUB_HTML_1 = `
  <table>
    <tr><th>Лот №</th><td>90002001-ОК1</td></tr>
    <tr><th>Статус лота</th><td>Закупка состоялась</td></tr>
    <tr><th>Дата начала приема заявок</th><td>2026-06-05 09:00:00</td></tr>
    <tr><th>Дата окончания приема заявок</th><td>2026-06-15 18:00:00</td></tr>
    <tr><th>БИН заказчика</th><td>111111111111</td></tr>
    <tr><th>Наименование заказчика</th><td>КГУ "Тест Школа"</td></tr>
    <tr><th>Код ТРУ</th><td>262030.100.000021</td></tr>
    <tr><th>Наименование ТРУ</th><td>Панель интерактивная</td></tr>
    <tr><th>Краткая характеристика</th><td>75 дюймов</td></tr>
    <tr><th>Цена за единицу</th><td>1 000 000</td></tr>
    <tr><th>Количество</th><td>1</td></tr>
    <tr><th>Запланированная сумма</th><td>1 000 000</td></tr>
  </table>
`;

const SUB_HTML_2 = `
  <table>
    <tr><th>Лот №</th><td>90002002-ОК1</td></tr>
    <tr><th>Статус лота</th><td>Опубликован (прием заявок)</td></tr>
    <tr><th>Дата начала приема заявок</th><td>2026-11-10 09:00:00</td></tr>
    <tr><th>Дата окончания приема заявок</th><td>2026-11-20 18:00:00</td></tr>
    <tr><th>БИН заказчика</th><td>222222222222</td></tr>
    <tr><th>Наименование заказчика</th><td>КГУ "Тест Лицей"</td></tr>
    <tr><th>Код ТРУ</th><td>262030.100.000021</td></tr>
    <tr><th>Наименование ТРУ</th><td>Панель интерактивная</td></tr>
    <tr><th>Краткая характеристика</th><td>86 дюймов</td></tr>
    <tr><th>Цена за единицу</th><td>1 200 000</td></tr>
    <tr><th>Количество</th><td>1</td></tr>
    <tr><th>Запланированная сумма</th><td>1 200 000</td></tr>
  </table>
`;

const PROTOS_HTML_1 = `
  <div class="panel"><div class="panel-heading">Протокол итогов</div>
    <table><tr><th>Протокол итогов</th><th>Статус</th></tr>
    <tr><td><a href="https://v3bl.goszakup.gov.kz/files/download_file/700/1/">Просмотреть протокол</a></td><td>Действительный</td></tr></table>
  </div>
`;

const DOCS_HTML = `
  <table><tr><td>Техническая спецификация</td><td>Да</td><td><button onclick="actionModalShowFiles(29002001, 3325)">Файлы</button></td></tr></table>
`;

const MODAL_HTML = `
  <table><tr><th>Лот</th><th>Файл</th></tr>
  <tr><td>90002001-ОК1</td><td><a href="https://v3bl.goszakup.gov.kz/files/download_file/700/2/">spec.pdf</a></td></tr></table>
`;

const ITOGI_HTML_1 = `<!doctype html><html><body>
  <table><tr><th>№</th><th>№ лота</th><th>Наименование лота</th><th>Кол-во</th><th>Цена за ед.</th><th>Выделенная сумма</th></tr>
  <tr><td>1</td><td>90002001-ОК1</td><td>Панель интерактивная</td><td>1</td><td>1 000 000</td><td>1 000 000</td></tr></table>
  <table><tr><th>№</th><th>Наименование</th><th>БИН</th><th>Дата и время представления</th></tr>
  <tr><td>1</td><td>ТОО «Альфа Тест»</td><td>333333333333</td><td>2026-06-10 10:00:00</td></tr></table>
  <table><tr><th>№</th><th>Наименование</th><th>БИН</th></tr>
  <tr><td>1</td><td>ТОО «Альфа Тест»</td><td>333333333333</td></tr></table>
  <table><tr><th>Место</th><th>Наименование</th><th>БИН</th><th>Выделенная сумма</th><th>Цена поставщика</th><th>Сумма ст.13</th><th>Условная скидка, %</th><th>Условная цена</th></tr>
  <tr><td>1</td><td>ТОО «Альфа Тест»</td><td>333333333333</td><td>1 000 000</td><td>900 000</td><td>0</td><td>0</td><td>900 000</td></tr></table>
  <table><tr><th>№</th><th>Наименование потенциального поставщика</th><th>БИН</th><th>Сведения бенефициарного владельца</th></tr>
  <tr><td>1</td><td>ТОО «Альфа Тест»</td><td>333333333333</td><td>Тестов Т.Т.</td></tr></table>
</body></html>`;

describe("competitors collector: resumable backfill and incremental update", () => {
  it("runs resumable backfill without re-fetching completed pages and updates only non-terminal or changed lots", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-coll-"));
    const dbPath = path.join(dir, "competitors.db");
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>режим полива по лунному календарю</w:t></w:r></w:p></w:body></w:document>");
    const docxBuf = await zip.generateAsync({ type: "nodebuffer" });

    const seenUrls: string[] = [];
    let failFirstSubprice2 = true;
    let searchRetries = 0;

    const fakeFetch = (async (input: string | URL) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.includes("/ru/search/lots")) {
        if (url.includes("262030.100.000021")) {
          if (searchRetries === 0) {
            searchRetries++;
            return new Response("busy", { status: 429 });
          }
          return new Response(SEARCH_HTML, { status: 200 });
        }
        return new Response("<div>Ничего не найдено</div>", { status: 200 });
      }
      if (url.includes("/subpriceoffer/index/29002001/")) return new Response(SUB_HTML_1, { status: 200 });
      if (url.includes("/subpriceoffer/index/29002002/")) {
        if (failFirstSubprice2) {
          failFirstSubprice2 = false;
          return new Response("down", { status: 503 });
        }
        return new Response(SUB_HTML_2, { status: 200 });
      }
      if (url.includes("/announce/index/29002001?tab=protocols")) return new Response(PROTOS_HTML_1, { status: 200 });
      if (url.includes("?tab=documents")) return new Response(DOCS_HTML, { status: 200 });
      if (url.includes("actionAjaxModalShowFiles")) return new Response(MODAL_HTML, { status: 200 });
      if (url.includes("/download_file/700/1/")) return new Response(ITOGI_HTML_1, { status: 200 });
      if (url.includes("/download_file/700/2/")) return new Response(new Uint8Array(docxBuf), { status: 200 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const cfg = loadCompetitorsConfig({ templatesConfigPath: "tests/fixtures/kz/spec-templates.demo.json" });
    try {
      // Run 1: backfill (lot 1 succeeds, lot 2 fails once and retries cleanly)
      const res1 = await backfillCompetitors({
        fromDate: "2026-01-01",
        toDate: "2026-11-15",
        dbPath,
        cfg,
        enstruCodes: ["262030.100.000021"],
        fetchFn: fakeFetch,
        pauseMs: 0,
        retryDelayMs: 0,
        maxRetries: 2,
        concurrency: 2
      });
      expect(res1.lotsCount).toBe(2);
      expect(res1.bidsCount).toBe(1);

      const storage = new CompetitorsStorage(dbPath);
      expect(storage.loadTemplateMatches()).toHaveLength(2);
      storage.close();

      // Run 2: resume backfill — completed subpriceoffer & itogi for 29002001 should NOT be fetched again!
      seenUrls.length = 0;
      await backfillCompetitors({
        fromDate: "2026-01-01",
        toDate: "2026-11-15",
        dbPath,
        cfg,
        enstruCodes: ["262030.100.000021"],
        fetchFn: fakeFetch,
        pauseMs: 0,
        retryDelayMs: 0,
        concurrency: 2
      });
      expect(seenUrls.some((u) => u.includes("/subpriceoffer/index/29002001/"))).toBe(false);
      expect(seenUrls.some((u) => u.includes("/download_file/700/1/"))).toBe(false);

      // Run 3: incremental daily update — only open lot 29002002 is refreshed, terminal 29002001 is skipped!
      seenUrls.length = 0;
      await updateCompetitorsWindow({
        todayAlmaty: "2026-11-16",
        dbPath,
        cfg,
        enstruCodes: ["262030.100.000021"],
        fetchFn: fakeFetch,
        pauseMs: 0,
        retryDelayMs: 0,
        useZakupPublicApi: true
      });
      expect(seenUrls.some((u) => u.includes("/subpriceoffer/index/29002001/"))).toBe(false);
      expect(seenUrls.some((u) => u.includes("/subpriceoffer/index/29002002/"))).toBe(true);

      // Run 4: failed incremental update in non-strict mode preserves yesterday's updated_at & data
      const failingFetch = (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;
      const warnCount = await updateCompetitorsWindow({
        todayAlmaty: "2026-11-17",
        dbPath,
        cfg,
        enstruCodes: ["262030.100.000021"],
        fetchFn: failingFetch,
        pauseMs: 0,
        retryDelayMs: 0,
        maxRetries: 0
      });
      expect(warnCount).toBeUndefined();
      const sCheck = new CompetitorsStorage(dbPath);
      expect(sCheck.getMeta("updated_at")).toBe("2026-11-16");
      expect(sCheck.loadLots()).toHaveLength(2);
      sCheck.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects stub subpriceoffer/general/protocols/documents/itogi pages, treats empty DB lotDetail as unfetched, and retries cleanly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-stub-"));
    const dbPath = path.join(dir, "competitors.db");

    // Pre-seed DB with an empty stub lotDetail (like prior 200-stub saves) and mark needs_refresh = 0
    const seedStorage = new CompetitorsStorage(dbPath);
    seedStorage.upsertDiscoveredLots([
      {
        lotNumber: "90002001-ОК1",
        lotNameSearch: "Панель интерактивная",
        annoId: "29002001",
        annoNumber: "29002001-1",
        annoName: "Закупка панели",
        annoUrl: "https://procurement.gov.kz/ru/announce/index/29002001",
        lotUrl: "https://procurement.gov.kz/ru/subpriceoffer/index/29002001/60001",
        customerNameSearch: 'КГУ "Тест Школа"',
        qtySearch: 1,
        plannedSumSearch: 1000000,
        methodSearch: "Открытый конкурс",
        statusSearch: "Закупка состоялась",
        enstruCode: "262030.100.000021"
      }
    ]);
    seedStorage.saveLotEnrichment("29002001", "90002001-ОК1", {
      lotDetail: {
        lotNumberPage: "",
        statusLot: "",
        startDate: "",
        endDate: "",
        customerBin: "",
        customerName: "",
        enstruCodePage: "",
        truName: "",
        shortDesc: "",
        extraDesc: "",
        unitPrice: null,
        unit: "",
        qty: null,
        plannedSum: null,
        deliveryKato: "",
        subItems: []
      },
      needsRefresh: false
    });
    seedStorage.close();

    const wrongLotHtml = `<table><tr><th>Лот №</th><td>OTHER-LOT-999</td></tr></table>`;
    const emptyStubHtml = `<html><body><div>Подождите...</div></body></html>`;
    const counts: Record<string, number> = {};
    const inc = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

    const fakeFetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/ru/search/lots")) return new Response(SEARCH_HTML.replace(/90002002-ОК1[\s\S]*?<\/tr>/, ""), { status: 200 });
      if (url.includes("/subpriceoffer/index/29002001/")) {
        const n = inc("sub");
        if (n === 1) return new Response(emptyStubHtml, { status: 200 });
        if (n === 2) return new Response(wrongLotHtml, { status: 200 });
        return new Response(SUB_HTML_1, { status: 200 });
      }
      if (url.includes("?tab=protocols")) {
        const n = inc("proto");
        return new Response(n === 1 ? emptyStubHtml : PROTOS_HTML_1, { status: 200 });
      }
      if (url.includes("?tab=documents")) {
        const n = inc("docs");
        return new Response(n === 1 ? emptyStubHtml : DOCS_HTML, { status: 200 });
      }
      if (url.includes("actionAjaxModalShowFiles")) {
        const n = inc("modal");
        return new Response(n === 1 ? emptyStubHtml : MODAL_HTML, { status: 200 });
      }
      if (url.includes("/download_file/700/1/")) {
        const n = inc("itogi");
        return new Response(n === 1 ? emptyStubHtml : ITOGI_HTML_1, { status: 200 });
      }
      if (url.includes("/download_file/700/2/")) {
        const zip = new JSZip();
        zip.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>Текстовая ТС</w:t></w:r></w:p></w:body></w:document>");
        return new Response(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const cfg = loadCompetitorsConfig({ templatesConfigPath: "tests/fixtures/kz/spec-templates.demo.json" });
    try {
      const res = await backfillCompetitors({
        fromDate: "2026-01-01",
        toDate: "2026-11-15",
        dbPath,
        cfg,
        enstruCodes: ["262030.100.000021"],
        fetchFn: fakeFetch,
        pauseMs: 0,
        retryDelayMs: 0,
        maxRetries: 3
      });
      expect(res.errors).toEqual([]);
      expect(counts.sub).toBe(3);
      expect(counts.proto).toBe(2);
      expect(counts.docs).toBe(2);
      expect(counts.modal).toBe(2);
      expect(counts.itogi).toBe(2);

      const st = new CompetitorsStorage(dbPath);
      const raw = st.loadAllRawLots()[0];
      expect(raw.lotDetail?.lotNumberPage).toBe("90002001-ОК1");
      expect(raw.lotDetail?.customerBin).toBe("111111111111");
      st.close();

      // Persistent stub on subpriceoffer must NOT overwrite valid/null lotDetail with empty stub
      const dbStubPath = path.join(dir, "stub-only.db");
      const alwaysStubFetch = (async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/ru/search/lots")) return new Response(SEARCH_HTML, { status: 200 });
        if (url.includes("/subpriceoffer/")) return new Response(wrongLotHtml, { status: 200 });
        if (url.includes("?tab=general")) return new Response(emptyStubHtml, { status: 200 });
        return new Response(emptyStubHtml, { status: 200 });
      }) as unknown as typeof fetch;
      const failRes = await backfillCompetitors({
        fromDate: "2026-01-01",
        toDate: "2026-11-15",
        dbPath: dbStubPath,
        cfg,
        enstruCodes: ["262030.100.000021"],
        fetchFn: alwaysStubFetch,
        pauseMs: 0,
        retryDelayMs: 0,
        maxRetries: 1
      });
      expect(failRes.errors.length).toBeGreaterThan(0);
      const stFail = new CompetitorsStorage(dbStubPath);
      expect(stFail.loadAllRawLots().every((r) => r.lotDetail === null)).toBe(true);
      stFail.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects 302 -> /ru/captcha, waits 15 min up to 3 retries, and fails clearly after 3 retries", async () => {
    expect(DEFAULT_CAPTCHA_PAUSE_MS).toBe(15 * 60 * 1000);
    expect(DEFAULT_MAX_CAPTCHA_RETRIES).toBe(3);

    const delays: number[] = [];
    let attempt = 0;
    let clock = 1_763_300_000_000;
    const captchaThenOkFetch = (async () => {
      attempt++;
      if (attempt <= 3) {
        return new Response(null, { status: 302, headers: { location: "https://procurement.gov.kz/ru/captcha" } });
      }
      return new Response("<div>Ничего не найдено</div>", { status: 200 });
    }) as unknown as typeof fetch;

    const okItems = await discoverCompetitorLots({
      fromDate: "2026-01-01",
      toDate: "2026-11-15",
      enstruCodes: ["262030.100.000021"],
      fetchFn: captchaThenOkFetch,
      pauseMs: 0,
      retryDelayMs: 0,
      nowFn: () => clock,
      sleepFn: async (ms) => {
        delays.push(ms);
        clock += ms;
      }
    });
    expect(okItems).toEqual([]);
    expect(attempt).toBe(4);
    expect(delays.reduce((s, d) => s + d, 0)).toBe(3 * DEFAULT_CAPTCHA_PAUSE_MS);

    // 4th captcha (> 3 retries) must throw explicit error and NOT loop forever
    const failDelays: number[] = [];
    let failAttempt = 0;
    const alwaysCaptchaFetch = (async () => {
      failAttempt++;
      return new Response(null, { status: 302, headers: { location: "/ru/captcha" } });
    }) as unknown as typeof fetch;

    await expect(
      discoverCompetitorLots({
        fromDate: "2026-01-01",
        toDate: "2026-11-15",
        enstruCodes: ["262030.100.000021"],
        fetchFn: alwaysCaptchaFetch,
        pauseMs: 0,
        retryDelayMs: 0,
        nowFn: () => clock,
        sleepFn: async (ms) => {
          failDelays.push(ms);
          clock += ms;
        }
      })
    ).rejects.toThrow(/капч|captcha/i);
    expect(failDelays.reduce((s, d) => s + d, 0)).toBe(3 * DEFAULT_CAPTCHA_PAUSE_MS);
    expect(failAttempt).toBe(4);
  });

  it("rejects search HTML missing #search-result/«Ничего не найдено», incomplete pages, and total >= 9000", async () => {
    // 1. Word "записей" without #search-result table or "Ничего не найдено" must fail (even after retries)
    const noTableFetch = (async () => new Response("<div>Ошибка: 0 записей загружено</div>", { status: 200 })) as unknown as typeof fetch;
    await expect(
      discoverCompetitorLots({
        fromDate: "2026-01-01",
        toDate: "2026-11-15",
        enstruCodes: ["262030.100.000021"],
        fetchFn: noTableFetch,
        pauseMs: 0,
        retryDelayMs: 0,
        maxRetries: 1
      })
    ).rejects.toThrow(/search-result|HTML/i);

    // 2. Total = 80 on page 1, page 2 returns empty #search-result -> incomplete page error
    const incompletePageFetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("page=2")) {
        return new Response('<table id="search-result"><tbody><tr><td>Ничего не найдено</td><td></td><td></td><td></td><td></td><td></td><td></td></tr></tbody></table>', { status: 200 });
      }
      return new Response(SEARCH_HTML.replace("из 2 записей", "из 80 записей"), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      discoverCompetitorLots({
        fromDate: "2026-01-01",
        toDate: "2026-11-15",
        enstruCodes: ["262030.100.000021"],
        fetchFn: incompletePageFetch,
        pauseMs: 0,
        retryDelayMs: 0,
        maxRetries: 1
      })
    ).rejects.toThrow(/Неполная выдача|Suspect search result/i);

    // 3. total >= 9000 must throw an error instead of returning []
    const hugeTotalFetch = (async () =>
      new Response(SEARCH_HTML.replace("из 2 записей", "из 12000 записей"), { status: 200 })) as unknown as typeof fetch;
    await expect(
      discoverCompetitorLots({
        fromDate: "2026-01-01",
        toDate: "2026-11-15",
        enstruCodes: ["262030.100.000021"],
        fetchFn: hugeTotalFetch,
        pauseMs: 0,
        retryDelayMs: 0,
        maxRetries: 1
      })
    ).rejects.toThrow(/9000/);
  });

  it("shares a single 15-min wall-clock captcha gate across 4 concurrent workers with 1 log line and slows down after pause", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-gate-"));
    const dbPath = path.join(dir, "competitors.db");

    // 4 lots in search HTML so enrich runs with concurrency = 4
    const fourSearchHtml = `
      <div>Показано с 1 по 4 из 4 записей</div>
      <table id="search-result"><tbody>
        ${[1, 2, 3, 4]
          .map(
            (n) => `<tr>
              <td><strong>9000300${n}-ОК1</strong></td>
              <td><a href="/ru/announce/index/2900300${n}"><strong>2900300${n}-1 Тест</strong></a><br>Заказчик: КГУ "Школа ${n}"</td>
              <td><a href="https://procurement.gov.kz/ru/subpriceoffer/index/2900300${n}/7000${n}">Панель интерактивная</a></td>
              <td>1</td><td>1 000 000</td><td>Открытый конкурс</td><td>Опубликован (прием заявок)</td>
            </tr>`
          )
          .join("\n")}
      </tbody></table>
    `;
    const subHtml = (n: number) =>
      SUB_HTML_2.replace("90002002-ОК1", `9000300${n}-ОК1`);

    let clock = 1_763_300_000_000;
    const sleepCalls: number[] = [];
    const fetchTimestamps: Array<{ url: string; ts: number }> = [];
    let captchaWindowActive = false;
    let firstWaveCalls = 0;

    const fakeFetch = (async (input: string | URL) => {
      const url = String(input);
      fetchTimestamps.push({ url, ts: clock });
      if (url.includes("zakup.gov.kz/api/core/api/public/lots/")) {
        return new Response("[]", { status: 200 });
      }
      if (url.includes("/ru/search/lots")) {
        return new Response(fourSearchHtml, { status: 200 });
      }
      const m = url.match(/\/subpriceoffer\/index\/2900300(\d)\//);
      if (m) {
        const n = Number(m[1]);
        firstWaveCalls++;
        // Both first two concurrent subpriceoffer requests get 302 -> /ru/captcha!
        if (firstWaveCalls <= 2 && clock < 1_763_300_000_000 + DEFAULT_CAPTCHA_PAUSE_MS) {
          captchaWindowActive = true;
          return new Response(null, { status: 302, headers: { location: "/ru/captcha" } });
        }
        return new Response(subHtml(n), { status: 200 });
      }
      if (url.includes("?tab=documents")) return new Response("<div>Нет технической спецификации</div>", { status: 200 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadCompetitorsConfig({ templatesConfigPath: "tests/fixtures/kz/spec-templates.demo.json" });
    try {
      const res = await collectCompetitors({
        fromDate: "2026-01-01",
        toDate: "2026-11-15",
        dbPath,
        cfg,
        enstruCodes: ["262030.100.000021"],
        fetchFn: fakeFetch,
        concurrency: 4,
        pauseMs: 0,
        retryDelayMs: 0,
        nowFn: () => clock,
        sleepFn: async (ms: number) => {
          sleepCalls.push(ms);
          clock += ms;
        }
      });

      expect(captchaWindowActive).toBe(true);
      expect(res.lotsCount).toBe(4);
      expect(res.incomplete).toBe(false);
      expect(res.remainingMissingDetails).toBe(0);

      // Total cooldown pause across all 4 workers must be ONCE (15 min), ticking in <= 30s steps!
      const tickSleeps = sleepCalls.filter((ms) => ms >= 10_000 || ms <= 30_000 && ms >= 5_000);
      const totalPaused = tickSleeps.reduce((s, ms) => s + ms, 0);
      expect(totalPaused).toBe(DEFAULT_CAPTCHA_PAUSE_MS);
      expect(Math.max(...sleepCalls)).toBeLessThanOrEqual(30_000);

      // Single log line for the shared pause
      const captchaWarnings = warnSpy.mock.calls.filter((args) => String(args[0]).includes("все запросы") && String(args[0]).includes("стоят до"));
      expect(captchaWarnings).toHaveLength(1);

      // No procurement.gov.kz requests happened during the 15-min cooldown, and post-captcha requests are serialized >= 1500ms!
      const pauseStart = 1_763_300_000_000;
      const pauseEnd = pauseStart + DEFAULT_CAPTCHA_PAUSE_MS;
      const duringCooldown = fetchTimestamps.filter((e) => e.url.includes("procurement.gov.kz") && e.ts > pauseStart && e.ts < pauseEnd);
      expect(duringCooldown).toEqual([]);

      const procTsAfterPause = fetchTimestamps
        .filter((e) => e.url.includes("procurement.gov.kz") && e.ts >= pauseEnd)
        .map((e) => e.ts)
        .sort((a, b) => a - b);
      expect(procTsAfterPause.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < procTsAfterPause.length; i++) {
        expect(procTsAfterPause[i] - procTsAfterPause[i - 1]).toBeGreaterThanOrEqual(1500);
      }
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses zakup.gov.kz public/lots API for ordinary lotDetails and falls back to subpriceoffer when missing or -ОЛ-", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-api-"));
    const dbPath = path.join(dir, "competitors.db");

    const apiAndFallbackSearchHtml = `
      <div>Показано с 1 по 2 из 2 записей</div>
      <table id="search-result"><tbody>
        <tr>
          <td><strong>90004001-ОК1</strong></td>
          <td><a href="/ru/announce/index/29004001"><strong>29004001-1 Панели</strong></a><br>Заказчик: КГУ "А"</td>
          <td><a href="https://procurement.gov.kz/ru/subpriceoffer/index/29004001/80001">Панель интерактивная</a></td>
          <td>2</td><td>2 000 000</td><td>Открытый конкурс</td><td>Опубликован (прием заявок)</td>
        </tr>
        <tr>
          <td><strong>90004002-ОЛ-ОК1</strong></td>
          <td><a href="/ru/announce/index/29004002"><strong>29004002-1 Сборный</strong></a><br>Заказчик: КГУ "Б"</td>
          <td><a href="https://procurement.gov.kz/ru/subpriceoffer/index/29004002/80002">Панель интерактивная</a></td>
          <td>1</td><td>3 000 000</td><td>Открытый конкурс</td><td>Опубликован (прием заявок)</td>
        </tr>
      </tbody></table>
    `;
    const subOlHtml = `
      <title>Информация о лоте №90004002-ОЛ-ОК1 :: Портал</title>
      <table>
        <tr><th>№</th><th>Номер пункта плана</th><th>Заказчик</th><th>Наименование</th><th>Доп</th><th>Цена</th><th>Кол-во</th><th>Ед.</th><th>Сумма</th><th>9</th><th>10</th><th>11</th><th>Статус</th></tr>
        <tr><td>1</td><td>111</td><td>КГУ "Б"</td><td>Панель интерактивная</td><td>75 дюймов</td><td>3 000 000</td><td>1</td><td>Штука</td><td>3 000 000</td><td></td><td></td><td></td><td>Опубликован (прием заявок)</td></tr>
      </table>
    `;

    const seenSubUrls: string[] = [];
    const fakeFetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/ru/search/lots")) return new Response(apiAndFallbackSearchHtml, { status: 200 });
      if (url.includes("zakup.gov.kz/api/core/api/public/lots/")) {
        if (url.includes("90004001")) {
          return new Response(
            JSON.stringify([
              {
                lot_number: "90004001-ОК1",
                announcement_external_id: 29004001,
                status_name: "Опубликован (прием заявок)",
                offer_start_date: "2026-11-10T04:00:00+00:00",
                offer_end_date: "2026-11-20T04:00:00+00:00",
                quantity: 2,
                total_price: 2000000,
                enstru_key: "262030.100.000021",
                enstrus: [{ name_ru: "Панель интерактивная", short_description_ru: "75 дюймов" }],
                customers: [{ bin: "123456789012", name_ru: 'КГУ "А"' }],
                delivery_addresses: [{ code: "710000000" }]
              }
            ]),
            { status: 200 }
          );
        }
        return new Response("[]", { status: 200 });
      }
      if (url.includes("/subpriceoffer/")) {
        seenSubUrls.push(url);
        if (url.includes("29004002")) return new Response(subOlHtml, { status: 200 });
        return new Response("unexpected call", { status: 500 });
      }
      if (url.includes("?tab=general")) {
        return new Response(`<label>Номер объявления</label><input value="29004002-1"><label>Срок начала приема заявок</label><input value="2026-11-11 09:00:00">`, { status: 200 });
      }
      if (url.includes("?tab=documents")) return new Response("<div>Нет технической спецификации</div>", { status: 200 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const cfg = loadCompetitorsConfig({ templatesConfigPath: "tests/fixtures/kz/spec-templates.demo.json" });
    try {
      const res = await backfillCompetitors({
        fromDate: "2026-01-01",
        toDate: "2026-11-15",
        dbPath,
        cfg,
        enstruCodes: ["262030.100.000021"],
        fetchFn: fakeFetch,
        pauseMs: 0,
        retryDelayMs: 0,
        useZakupPublicApi: true
      });
      expect(res.errors).toEqual([]);
      expect(res.lotsCount).toBe(2);
      // Ordinary lot resolved via zakup public API -> subpriceoffer NEVER hit for 29004001!
      expect(seenSubUrls.some((u) => u.includes("29004001"))).toBe(false);
      // -ОЛ- lot fell back cleanly to subpriceoffer!
      expect(seenSubUrls.some((u) => u.includes("29004002"))).toBe(true);

      const st = new CompetitorsStorage(dbPath);
      const lot1 = st.loadLots().find((l) => l.lotNumber === "90004001-ОК1");
      expect(lot1?.customerBin).toBe("123456789012");
      expect(lot1?.startDate).toBe("2026-11-10");
      expect(lot1?.plannedUnitPriceNoVat).toBe(1000000);
      st.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
