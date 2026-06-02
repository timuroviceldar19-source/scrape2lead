import type { Page, Response } from "playwright";

export class ApiCapture {
  private readonly payloads: unknown[] = [];
  private readonly urls: string[] = [];

  attach(page: Page): void {
    page.on("response", (response) => {
      void this.capture(response);
    });
  }

  values(): unknown[] {
    return [...this.payloads];
  }

  responseUrls(): string[] {
    return [...this.urls];
  }

  private async capture(response: Response): Promise<void> {
    const url = response.url();
    if (!looksLikeDataUrl(url)) return;
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("json")) return;
    try {
      this.payloads.push(await response.json());
      this.urls.push(url);
    } catch {
      // Some endpoints advertise JSON but stream or return partial content.
    }
  }
}

function looksLikeDataUrl(url: string): boolean {
  return /2gis|dgis|catalog|branch|search|firm|graphql/i.test(url);
}
