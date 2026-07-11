import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeSpecPdf,
  buildOpenCodeMessagesRequest,
  buildOpenCodeVisionRequest,
  buildSpecSummaryText,
  parseSpecAnalysis,
  resolveClientConfig,
  type RenderedPdfPage,
  type SpecAnalysis
} from "../../src/analysis/specAnalyzer.js";

const VALID: SpecAnalysis = {
  product: "Моноблоки для учебных кабинетов",
  summary: "Закупка 20 моноблоков с монитором 23.8\" для школы.",
  keyParams: ["Экран 23.8\"", "ОЗУ 8 ГБ", "SSD 256 ГБ"],
  quantity: "20 шт",
  deadline: "до 30 сентября 2026",
  supplierRequirements: ["Гарантия 12 мес", "Опыт поставок в бюджет"],
  fitVerdict: "можем",
  fitReason: "Стандартная компьютерная техника из нашего профиля.",
  risks: ["Сжатые сроки поставки"]
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("parseSpecAnalysis", () => {
  it("parses a raw JSON object", () => {
    expect(parseSpecAnalysis(JSON.stringify(VALID))).toEqual(VALID);
  });

  it("tolerates markdown code fences and surrounding prose", () => {
    const raw = "Вот результат:\n```json\n" + JSON.stringify(VALID) + "\n```\nГотово.";
    expect(parseSpecAnalysis(raw)).toEqual(VALID);
  });

  it("throws when the verdict is not one of the allowed values", () => {
    const bad = JSON.stringify({ ...VALID, fitVerdict: "maybe" });
    expect(() => parseSpecAnalysis(bad)).toThrow();
  });

  it("throws when a required field is missing", () => {
    const { quantity: _omit, ...rest } = VALID;
    expect(() => parseSpecAnalysis(JSON.stringify(rest))).toThrow();
  });

  it("throws when there is no JSON object at all", () => {
    expect(() => parseSpecAnalysis("модель отказалась отвечать")).toThrow(/no JSON object/);
  });
});

describe("buildSpecSummaryText", () => {
  it("renders verdict label, params and requirements as bullets", () => {
    const text = buildSpecSummaryText(VALID);
    expect(text).toContain("Товар: Моноблоки для учебных кабинетов");
    expect(text).toContain("Вывод: МОЖЕМ ПОСТАВИТЬ —");
    expect(text).toContain("• Экран 23.8\"");
    expect(text).toContain("• Гарантия 12 мес");
    expect(text).toContain("• Сжатые сроки поставки");
  });

  it("omits empty sections", () => {
    const minimal: SpecAnalysis = {
      ...VALID,
      keyParams: [],
      supplierRequirements: [],
      risks: []
    };
    const text = buildSpecSummaryText(minimal);
    expect(text).not.toContain("Ключевые параметры:");
    expect(text).not.toContain("Требования к поставщику:");
    expect(text).not.toContain("Риски:");
  });
});

describe("resolveClientConfig", () => {
  it("defaults to MiMo Free on OpenCode Zen with Kimi Go fallback", () => {
    const config = resolveClientConfig({ apiKey: "k", provider: "opencode" });
    expect(config.provider).toBe("opencode");
    expect(config.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(config.apiKey).toBe("k");
    expect(config.model).toBe("mimo-v2.5-free");
    expect(config.fallback).toEqual({
      apiKey: "k",
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: "kimi-k2.6",
      transport: "chat-completions"
    });
  });

  it("selects the Anthropic-compatible messages transport for Qwen3.7 Plus", () => {
    const config = resolveClientConfig({
      apiKey: "k",
      provider: "opencode",
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: "qwen3.7-plus",
      fallbackModel: null
    });
    expect(config.transport).toBe("messages");
    expect(config.fallback).toBeNull();
  });

  it("preserves the legacy Anthropic configuration when explicitly selected", () => {
    const config = resolveClientConfig({
      apiKey: "k",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1/"
    });
    expect(config.provider).toBe("anthropic");
    expect(config.baseUrl).toBeUndefined();
    expect(config.model).toBe("claude-sonnet-5");
    expect(config.fallback).toBeNull();
  });

  it("honours an explicit model override", () => {
    expect(resolveClientConfig({ apiKey: "k", provider: "opencode", model: "kimi-k2.7-code" }).model)
      .toBe("kimi-k2.7-code");
  });

  it("does not inherit Anthropic endpoints or models when OpenCode is explicitly selected", () => {
    const saved = {
      anthropicBase: process.env.ANTHROPIC_BASE_URL,
      cloudBase: process.env.CLOUD_BASE_URL,
      cloudModel: process.env.CLOUD_MODEL,
      opencodeBase: process.env.OPENCODE_BASE_URL,
      opencodeModel: process.env.OPENCODE_MODEL
    };
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
    process.env.CLOUD_BASE_URL = "https://api.anthropic.com";
    process.env.CLOUD_MODEL = "claude-sonnet-5";
    delete process.env.OPENCODE_BASE_URL;
    delete process.env.OPENCODE_MODEL;
    try {
      const config = resolveClientConfig({ apiKey: "k", provider: "opencode" });
      expect(config.baseUrl).toBe("https://opencode.ai/zen/v1");
      expect(config.model).toBe("mimo-v2.5-free");
    } finally {
      restoreEnv("ANTHROPIC_BASE_URL", saved.anthropicBase);
      restoreEnv("CLOUD_BASE_URL", saved.cloudBase);
      restoreEnv("CLOUD_MODEL", saved.cloudModel);
      restoreEnv("OPENCODE_BASE_URL", saved.opencodeBase);
      restoreEnv("OPENCODE_MODEL", saved.opencodeModel);
    }
  });

  it("prefers the provider-specific OpenCode key over a legacy shared key", () => {
    const saved = { cloud: process.env.CLOUD_API_KEY, opencode: process.env.OPENCODE_API_KEY };
    process.env.CLOUD_API_KEY = "legacy-anthropic-key";
    process.env.OPENCODE_API_KEY = "opencode-key";
    try {
      expect(resolveClientConfig({ provider: "opencode" }).apiKey).toBe("opencode-key");
    } finally {
      if (saved.cloud === undefined) delete process.env.CLOUD_API_KEY;
      else process.env.CLOUD_API_KEY = saved.cloud;
      if (saved.opencode === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = saved.opencode;
    }
  });

  it("allows the environment to disable the fallback model", () => {
    const saved = process.env.SPEC_ANALYSIS_FALLBACK_MODEL;
    process.env.SPEC_ANALYSIS_FALLBACK_MODEL = "none";
    try {
      expect(resolveClientConfig({ apiKey: "k", provider: "opencode" }).fallback).toBeNull();
    } finally {
      restoreEnv("SPEC_ANALYSIS_FALLBACK_MODEL", saved);
    }
  });

  it("throws when no API key is available", () => {
    const saved = { cloud: process.env.CLOUD_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
    delete process.env.CLOUD_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => resolveClientConfig({})).toThrow(/CLOUD_API_KEY/);
    } finally {
      if (saved.cloud !== undefined) process.env.CLOUD_API_KEY = saved.cloud;
      if (saved.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = saved.anthropic;
    }
  });

  it("rejects an unsupported provider from the environment", () => {
    const saved = process.env.SPEC_ANALYSIS_PROVIDER;
    process.env.SPEC_ANALYSIS_PROVIDER = "unknown";
    try {
      expect(() => resolveClientConfig({ apiKey: "k" })).toThrow(/Unsupported SPEC_ANALYSIS_PROVIDER/);
    } finally {
      if (saved === undefined) delete process.env.SPEC_ANALYSIS_PROVIDER;
      else process.env.SPEC_ANALYSIS_PROVIDER = saved;
    }
  });
});

describe("buildOpenCodeVisionRequest", () => {
  it("encodes every rendered PDF page as an OpenAI-compatible image part", () => {
    const pages: RenderedPdfPage[] = [
      { pageNumber: 1, mediaType: "image/jpeg", base64: "cGFnZTE=" },
      { pageNumber: 2, mediaType: "image/png", base64: "cGFnZTI=" }
    ];

    const request = buildOpenCodeVisionRequest("kimi-k2.6", 2000, "Проанализируй", pages);

    expect(request.model).toBe("kimi-k2.6");
    expect(request.max_tokens).toBe(2000);
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(request.thinking).toEqual({ type: "disabled" });
    expect(request.messages[0].content).toEqual([
      { type: "text", text: "Проанализируй" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,cGFnZTE=" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,cGFnZTI=" } }
    ]);
  });

  it("rejects an empty rendered document", () => {
    expect(() => buildOpenCodeVisionRequest("m", 100, "p", [])).toThrow(/no rendered pages/i);
  });
});

describe("buildOpenCodeMessagesRequest", () => {
  it("encodes rendered pages as Anthropic-compatible image blocks and disables thinking", () => {
    const pages: RenderedPdfPage[] = [
      { pageNumber: 2, mediaType: "image/png", base64: "cGFnZTI=" },
      { pageNumber: 1, mediaType: "image/jpeg", base64: "cGFnZTE=" }
    ];

    const request = buildOpenCodeMessagesRequest("qwen3.7-plus", 4000, "Проанализируй", pages);

    expect(request).toEqual({
      model: "qwen3.7-plus",
      max_tokens: 4000,
      thinking: { type: "disabled" },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Проанализируй" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "cGFnZTE=" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "cGFnZTI=" } }
        ]
      }]
    });
  });
});

describe("analyzeSpecPdf with OpenCode vision", () => {
  const pages: RenderedPdfPage[] = [
    { pageNumber: 1, mediaType: "image/jpeg", base64: "cGFnZQ==" }
  ];

  it("uses MiMo Free as primary and falls back to Kimi Go on provider failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temporary failure" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(VALID) } }]
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const renderPdf = vi.fn(async () => pages);
    const onModelResolved = vi.fn();

    const result = await analyzeSpecPdf(Buffer.from("pdf"), {
      provider: "opencode",
      apiKey: "secret",
      fetchImpl,
      renderPdf,
      maxAttemptsPerModel: 1,
      onModelResolved
    });

    expect(result).toEqual(VALID);
    expect(renderPdf).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(fetchImpl.mock.calls[1][0]).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).model).toBe("mimo-v2.5-free");
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)).model).toBe("kimi-k2.6");
    // The callback must report the fallback that actually answered, not the
    // configured primary — callers store this to know which model produced
    // a given result.
    expect(onModelResolved).toHaveBeenCalledOnce();
    expect(onModelResolved).toHaveBeenCalledWith({ provider: "opencode", model: "kimi-k2.6" });
  });

  it("retries the primary model when it returns malformed JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "not json" } }]
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(VALID) } }]
      }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(analyzeSpecPdf(Buffer.from("pdf"), {
      provider: "opencode",
      apiKey: "secret",
      fetchImpl,
      renderPdf: async () => pages,
      maxAttemptsPerModel: 2
    })).resolves.toEqual(VALID);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every((call) => call[0] === "https://opencode.ai/zen/v1/chat/completions"))
      .toBe(true);
  });

  it("accepts text-part arrays returned by an OpenAI-compatible gateway", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: [{ type: "text", text: JSON.stringify(VALID) }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(analyzeSpecPdf(Buffer.from("pdf"), {
      provider: "opencode",
      apiKey: "secret",
      fetchImpl,
      renderPdf: async () => pages,
      maxAttemptsPerModel: 1,
      fallbackModel: null
    })).resolves.toEqual(VALID);
  });

  it("uses the messages endpoint for Qwen and parses Anthropic-compatible content", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`` }]
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(analyzeSpecPdf(Buffer.from("pdf"), {
      provider: "opencode",
      apiKey: "secret",
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: "qwen3.7-plus",
      fallbackModel: null,
      fetchImpl,
      renderPdf: async () => pages,
      maxAttemptsPerModel: 1
    })).resolves.toEqual(VALID);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://opencode.ai/zen/go/v1/messages");
    const init = fetchImpl.mock.calls[0][1];
    expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.parse(String(init?.body)).thinking).toEqual({ type: "disabled" });
  });

  it("reports both model failures when primary and fallback fail", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "unavailable" }
    }), { status: 503, headers: { "content-type": "application/json" } }));

    await expect(analyzeSpecPdf(Buffer.from("pdf"), {
      provider: "opencode",
      apiKey: "secret",
      fetchImpl,
      renderPdf: async () => pages,
      maxAttemptsPerModel: 1
    })).rejects.toThrow(/mimo-v2\.5-free.*kimi-k2\.6/s);
  });
});

describe("analyzeSpecPdf with Anthropic compatibility", () => {
  it("keeps native PDF support and retries malformed model output", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "not json" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify(VALID) }] });
    const client = { messages: { create } } as unknown as Anthropic;

    await expect(analyzeSpecPdf(Buffer.from("%PDF"), {
      provider: "anthropic",
      apiKey: "secret",
      client,
      maxAttemptsPerModel: 2
    })).resolves.toEqual(VALID);

    expect(create).toHaveBeenCalledTimes(2);
    const firstRequest = create.mock.calls[0][0];
    expect(firstRequest.messages[0].content[0].type).toBe("document");
  });
});
