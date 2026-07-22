import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

const exportsRoot = resolve("exports");

interface SnapshotDir {
  name: string;
  dir: string;
  dashboardPath: string;
  pptxFiles: string[];
}

function discoverSnapshots(): SnapshotDir[] {
  if (!existsSync(exportsRoot)) return [];
  return readdirSync(exportsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("bitrix-b2g-"))
    .map((entry) => {
      const dir = resolve(exportsRoot, entry.name);
      return {
        name: entry.name,
        dir,
        dashboardPath: resolve(dir, "dashboard.html"),
        pptxFiles: readdirSync(dir).filter((file) => file.endsWith(".pptx"))
      };
    })
    .filter((snapshot) => existsSync(snapshot.dashboardPath) && snapshot.pptxFiles.length > 0);
}

const snapshots = discoverSnapshots();

describe.runIf(snapshots.length > 0)("final Bitrix report artifacts", () => {
  it.each(snapshots.map((snapshot) => [snapshot.name, snapshot] as const))(
    "keeps operational deal, company and manager names out of the PowerPoint (%s)",
    async (_name, snapshot) => {
      const dashboard = await readFile(snapshot.dashboardPath, "utf8");
      const payloadText = dashboard.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)?.[1];
      expect(payloadText).toBeTruthy();
      const payload = JSON.parse(payloadText!) as { deals: Array<{ title: string; companyName: string; managerName: string }> };
      const operationalNames = new Set(payload.deals.flatMap((deal) => [deal.title, deal.companyName, deal.managerName])
        .filter((value) => value.length >= 12 && value !== "Без компании" && !value.startsWith("ID ")));

      for (const pptxFile of snapshot.pptxFiles) {
        const zip = await JSZip.loadAsync(await readFile(resolve(snapshot.dir, pptxFile)));
        const slideEntries = Object.values(zip.files).filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name));
        const slideXml = (await Promise.all(slideEntries.map((entry) => entry.async("string")))).join("\n");

        const leaked = [...operationalNames].filter((value) => slideXml.includes(value)).slice(0, 10);
        expect(leaked, pptxFile).toEqual([]);
        expect(slideXml, pptxFile).not.toMatch(/crm\/deal\/details|\/rest\/\d+\//i);
      }
    }
  );

  it.each(snapshots.map((snapshot) => [snapshot.name, snapshot] as const))(
    "contains no webhook, contacts, phones or email fields in exported text artifacts (%s)",
    async (_name, snapshot) => {
      const files = ["dashboard.html", "snapshot-manifest.json", "data-audit.json", "stage-mapping.json", "deal-user-fields-metadata.json"]
        .filter((file) => existsSync(resolve(snapshot.dir, file)));
      const text = (await Promise.all(files.map((file) => readFile(resolve(snapshot.dir, file), "utf8")))).join("\n");
      expect(text).not.toMatch(/\/rest\/\d+\/[a-z0-9]+\//i);
      expect(text).not.toMatch(/"(?:PHONE|EMAIL|CONTACT_ID)"\s*:/i);
    }
  );
});
