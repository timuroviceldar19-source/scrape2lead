export type CaptchaMode = "auto" | "manual";

export function resolveCaptchaMode(requested: CaptchaMode | undefined, apiKey: string | undefined): CaptchaMode {
  if (requested === "auto" && !apiKey?.trim()) throw new Error("--captcha-mode auto requires CAPSOLVER_API_KEY");
  if (requested) return requested;
  return apiKey?.trim() ? "auto" : "manual";
}
