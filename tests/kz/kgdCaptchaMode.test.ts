import { describe, expect, it } from "vitest";
import { resolveCaptchaMode } from "../../src/kz/kgdCaptchaMode.js";

describe("CAPTCHA mode", () => {
  it("uses auto by default when a key is present", () => expect(resolveCaptchaMode(undefined, "key")).toBe("auto"));
  it("uses manual by default without a key", () => expect(resolveCaptchaMode(undefined, "")).toBe("manual"));
  it("honors explicit manual mode even with a key", () => expect(resolveCaptchaMode("manual", "key")).toBe("manual"));
  it("rejects explicit auto mode without a key", () => expect(() => resolveCaptchaMode("auto", "")).toThrow(/CAPSOLVER_API_KEY/));
});
