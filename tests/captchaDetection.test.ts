import { describe, expect, it } from "vitest";
import { looksLikeCaptcha, classifyWall } from "../src/adapters/2gis/TwoGisAdapter.js";

/**
 * Regression for the silent anti-bot miss surfaced by the no-proxy
 * Novosibirsk smoke test (2026-06-02): a direct IP gets served the 2GIS
 * interstitial wall, which the old body-only `captcha|капча|проверка` check
 * did not match, so the job mis-reported `completed / 0 leads`.
 */
describe("looksLikeCaptcha", () => {
  // Verbatim wall text observed from 2gis.ru on a challenged IP.
  const wallTitle = "2GIS Captcha";
  const wallBody =
    "Мы заметили подозрительную активность с вашего IP адреса. " +
    "Чтобы подтвердить, что вы не робот, пожалуйста, заполните форму ниже:";

  it("detects the 2GIS wall via the title alone", () => {
    expect(looksLikeCaptcha(wallTitle, "")).toBe(true);
  });

  it("detects the 2GIS wall via the body text alone (no literal 'captcha')", () => {
    expect(wallBody.toLowerCase()).not.toContain("captcha");
    expect(looksLikeCaptcha("", wallBody)).toBe(true);
  });

  it("detects the full wall (title + body)", () => {
    expect(looksLikeCaptcha(wallTitle, wallBody)).toBe(true);
  });

  it("still matches the legacy signatures", () => {
    expect(looksLikeCaptcha("", "Введите капчу")).toBe(true); // капч stem
    expect(looksLikeCaptcha("", "Требуется проверка безопасности")).toBe(true);
  });

  it("does not flag a normal search results page", () => {
    const title = "Автосервисы в Новосибирске — 2ГИС";
    const body = "СТО Авто+ · ул. Ленина, 1 · +7 383 000 00 00 · Шиномонтаж рядом";
    expect(looksLikeCaptcha(title, body)).toBe(false);
  });
});

/**
 * Regression for the deeper root cause found while verifying the fix: the
 * adapter's spoofed `Chrome/124` UA trips 2GIS's browser-upgrade
 * interstitial ("2ГИС советует обновить браузер"), which is neither a
 * CAPTCHA nor real results — discovery must still fail loudly.
 */
describe("classifyWall", () => {
  const upgradeTitle = "2ГИС";
  const upgradeBody =
    "2ГИС советует обновить браузер. 2ГИС прекрасно работает в новых " +
    "браузерах, а в старых могут возникать проблемы.";

  it("classifies the CAPTCHA wall as 'captcha'", () => {
    expect(classifyWall("2GIS Captcha", "Мы заметили подозрительную активность")).toBe("captcha");
  });

  it("classifies the browser-upgrade interstitial as 'browser-upgrade'", () => {
    expect(classifyWall(upgradeTitle, upgradeBody)).toBe("browser-upgrade");
  });

  it("matches the English browser-upgrade wording too", () => {
    expect(classifyWall("", "Please update your browser to continue")).toBe("browser-upgrade");
  });

  it("returns null for a normal results page", () => {
    expect(classifyWall("Автосервисы в Новосибирске — 2ГИС", "СТО Авто+ · ул. Ленина, 1")).toBeNull();
  });

  it("CAPTCHA takes precedence when both signatures are present", () => {
    expect(classifyWall("2GIS Captcha", upgradeBody)).toBe("captcha");
  });
});
