import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

const outputDir = resolve("exports/bitrix-b2g-2026-07-17");
const dashboardPath = resolve(outputDir, "dashboard.html");
const pptxPath = resolve(outputDir, "bitrix-b2g-report-2026-07-17.pptx");

describe.runIf(existsSync(dashboardPath) && existsSync(pptxPath))("final Bitrix report artifacts", () => {
  it("keeps operational deal, company and manager names out of the PowerPoint", async () => {
    const dashboard = await readFile(dashboardPath, "utf8");
    const payloadText = dashboard.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)?.[1];
    expect(payloadText).toBeTruthy();
    const payload = JSON.parse(payloadText!) as { deals: Array<{ title: string; companyName: string; managerName: string }> };
    const zip = await JSZip.loadAsync(await readFile(pptxPath));
    const slideEntries = Object.values(zip.files).filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name));
    const slideXml = (await Promise.all(slideEntries.map((entry) => entry.async("string")))).join("\n");
    const operationalNames = new Set(payload.deals.flatMap((deal) => [deal.title, deal.companyName, deal.managerName])
      .filter((value) => value.length >= 12 && value !== "Без компании" && !value.startsWith("ID ")));

    const leaked = [...operationalNames].filter((value) => slideXml.includes(value)).slice(0, 10);
    expect(leaked).toEqual([]);
    expect(slideXml).not.toMatch(/crm\/deal\/details|\/rest\/\d+\//i);
  });

  it("contains no webhook, contacts, phones or email fields in exported text artifacts", async () => {
    const files = ["dashboard.html", "snapshot-manifest.json", "data-audit.json", "stage-mapping.json", "deal-user-fields-metadata.json"];
    const text = (await Promise.all(files.map((file) => readFile(resolve(outputDir, file), "utf8")))).join("\n");
    expect(text).not.toMatch(/\/rest\/\d+\/[a-z0-9]+\//i);
    expect(text).not.toMatch(/"(?:PHONE|EMAIL|CONTACT_ID)"\s*:/i);
  });
});
