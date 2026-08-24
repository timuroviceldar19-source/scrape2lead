import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { parseRegistryProfileHtml, parseRegistrySearchHtml } from "./goszakupRegistryParser.js";

const REGISTRY_SEARCH_URL = "https://goszakup.gov.kz/ru/registry/supplierreg";

export type RegistryFetchResult =
  | { record: ReturnType<typeof parseRegistryProfileHtml>; rawSnapshotPath: string | null }
  | "not_found";

export async function fetchRegistryForBin(
  page: Page,
  bin: string,
  debugDir: string,
  profileUrl?: string
): Promise<RegistryFetchResult> {
  if (profileUrl && isAllowedSupplierProfileUrl(profileUrl)) {
    try {
      const directResult = await fetchRegistryProfile(page, bin, profileUrl, debugDir);
      if (directResult.record) {
        const participantId = profileUrl.match(/show_supplier\/(\d+)/)?.[1] ?? null;
        return {
          ...directResult,
          record: {
            ...directResult.record,
            participant_id: directResult.record.participant_id ?? participantId,
            registry_url: directResult.record.registry_url ?? profileUrl
          }
        };
      }
      console.warn(`registry: direct profile BIN mismatch or parse failure for ${bin}; falling back to search`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`registry: direct profile failed for ${bin}: ${message}; falling back to search`);
    }
  }

  await page.goto(REGISTRY_SEARCH_URL, { waitUntil: "networkidle", timeout: 30_000 });

  const searchInput = page.locator('input[placeholder*="Наименование"], input[placeholder*="БИН"], input[name="search_bin"], input[name="bin_iin"]');
  await searchInput.first().waitFor({ timeout: 10_000 });
  await searchInput.first().fill(bin);

  const findButton = page.locator('button:has-text("Найти"), button[type="submit"]');
  await findButton.first().click();
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  const searchHtml = await page.content();
  const searchResult = parseRegistrySearchHtml(searchHtml, bin);
  if (!searchResult) return "not_found";

  const profileResult = await fetchRegistryProfile(page, bin, searchResult.profile_url, debugDir);
  const record = profileResult.record;
  if (!record) return profileResult;
  return {
    record: {
      ...record,
      participant_id: record.participant_id ?? searchResult.participant_id,
      registry_url: record.registry_url ?? searchResult.profile_url
    },
    rawSnapshotPath: profileResult.rawSnapshotPath
  };
}

async function fetchRegistryProfile(
  page: Page,
  bin: string,
  profileUrl: string,
  debugDir: string
): Promise<Exclude<RegistryFetchResult, "not_found">> {
  await page.goto(profileUrl, { waitUntil: "networkidle", timeout: 30_000 });
  const profileHtml = await page.content();
  const record = parseRegistryProfileHtml(profileHtml, bin);
  if (!record) return { record: null, rawSnapshotPath: null };

  fs.mkdirSync(debugDir, { recursive: true });
  const rawSnapshotPath = path.join(debugDir, `goszakup-registry-${bin}.html`);
  fs.writeFileSync(rawSnapshotPath, profileHtml, "utf8");
  return { record, rawSnapshotPath };
}

function isAllowedSupplierProfileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "goszakup.gov.kz" || url.hostname === "www.goszakup.gov.kz")
      && /^\/(?:ru|kz)\/registry\/show_supplier\/\d+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}
