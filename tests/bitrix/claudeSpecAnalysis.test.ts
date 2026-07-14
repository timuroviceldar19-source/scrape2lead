import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAnalysis, runWrite, safeLotSlug, type SpecWorkEntry } from "../../scripts/claude-spec-analysis.mjs";
import { SpecDealClient } from "../../scripts/analyze-gz-specs.mjs";
import type { SpecAnalysis } from "../../src/analysis/specAnalyzer.js";

const LOT = "86850967-ЗЦП1";
const ANALYSIS: SpecAnalysis = {
  product: "Компьютеры в сборе",
  summary: "Закупка 15 компьютеров для отдела.",
  keyParams: ["CPU 6 ядер", "ОЗУ 16 ГБ", "SSD 512 ГБ"],
  quantity: "15 шт",
  deadline: "до 1 октября 2026",
  supplierRequirements: ["Опыт поставок гос.органам"],
  fitVerdict: "можем",
  fitReason: "Стандартные ПК из нашего профиля.",
  risks: []
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function makeWorkDir(entry: Partial<SpecWorkEntry> = {}, analysis: unknown = ANALYSIS): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-spec-"));
  dirs.push(dir);
  const slug = safeLotSlug(LOT);
  const work: SpecWorkEntry = {
    lotNumber: LOT,
    lotName: "Компьютеры для школы",
    customer: "ГУ Школа №1",
    announceUrl: "https://goszakup.gov.kz/ru/announce/index/12345",
    context: "Компьютеры для школы — заказчик ГУ Школа №1",
    fileName: "spec.pdf",
    pdfFile: `${slug}.pdf`,
    noSpec: false,
    ...entry
  };
  fs.writeFileSync(path.join(dir, "work.json"), JSON.stringify([work], null, 2));
  fs.writeFileSync(path.join(dir, `${slug}.pdf`), Buffer.from("%PDF-1.4 fake"));
  fs.writeFileSync(path.join(dir, `${slug}.analysis.json`), JSON.stringify(analysis, null, 2));
  return dir;
}

function fakeClient(dealOverrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; body?: unknown }> = [];
  const call = vi.fn(async (method: string, body?: unknown) => {
    calls.push({ method, body });
    if (method === "crm.deal.get") {
      return { ID: "41647", TITLE: "GZ lot", ORIGINATOR_ID: "scrape2lead-gz-lots", ORIGIN_ID: `gz-lot:${LOT}`, ...dealOverrides };
    }
    if (method === "crm.deal.userfield.list") return [];
    if (method === "crm.timeline.comment.list") return [];
    return true;
  });
  return { client: new SpecDealClient({ call }), calls };
}

describe("safeLotSlug", () => {
  it("keeps Cyrillic and digits, collapses separators", () => {
    expect(safeLotSlug("86850967-ЗЦП1")).toBe("86850967-ЗЦП1");
    expect(safeLotSlug("42553554/ОЛ ЗЦП1")).toBe("42553554-ОЛ-ЗЦП1");
  });
});

describe("loadAnalysis", () => {
  it("rejects a JSON that violates the SpecAnalysis schema", () => {
    const dir = makeWorkDir({}, { product: "x", fitVerdict: "невозможно" });
    expect(() => loadAnalysis(dir, LOT)).toThrow();
  });
});

describe("runWrite", () => {
  it("writes the agent verdict into the deal without any AI call", async () => {
    const dir = makeWorkDir();
    const { client, calls } = fakeClient();

    const result = await runWrite({ client, dir, dealId: "41647", confirmDealId: "41647", force: false });

    expect(result).toEqual({ outcome: "posted", lotNumber: LOT });
    const update = calls.find((c) => c.method === "crm.deal.update");
    const fields = (update?.body as { fields: Record<string, unknown> }).fields;
    expect(fields).toHaveProperty("UF_CRM_S2L_SPEC_VERDICT", "можем");
    expect(fields).toHaveProperty("UF_CRM_S2L_SPEC_SUMMARY");
    expect(fields).toHaveProperty("UF_CRM_S2L_SPEC_PDF");
    expect(fields).not.toHaveProperty("UF_CRM_S2L_SPEC_MODEL");
  });

  it("aborts before writing when --confirm-deal does not match the resolved deal", async () => {
    const dir = makeWorkDir();
    const { client, calls } = fakeClient();

    await expect(
      runWrite({ client, dir, dealId: "41647", confirmDealId: "99999", force: false })
    ).rejects.toThrow(/does not match resolved deal 41647/);
    expect(calls.some((c) => c.method === "crm.deal.update")).toBe(false);
  });

  it("skips an already-analyzed deal unless forced", async () => {
    const dir = makeWorkDir();
    const { client, calls } = fakeClient({ UF_CRM_S2L_SPEC_ANALYZED_AT: "2026-07-01T00:00:00.000Z" });

    const result = await runWrite({ client, dir, dealId: "41647", confirmDealId: "41647", force: false });

    expect(result.outcome).toBe("already");
    expect(calls.some((c) => c.method === "crm.deal.update")).toBe(false);
  });

  it("marks a lot with no spec instead of writing an analysis", async () => {
    const dir = makeWorkDir({ noSpec: true, fileName: null, pdfFile: null });
    const { client, calls } = fakeClient();

    const result = await runWrite({ client, dir, dealId: "41647", confirmDealId: "41647", force: false });

    expect(result.outcome).toBe("no-spec");
    const update = calls.find((c) => c.method === "crm.deal.update");
    expect((update?.body as { fields: Record<string, unknown> }).fields).toHaveProperty(
      "UF_CRM_S2L_SPEC_VERDICT",
      "нет спеки"
    );
  });
});
