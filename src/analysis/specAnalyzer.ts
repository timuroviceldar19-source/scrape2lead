/**
 * Analyses a tender technical-specification PDF and returns a structured,
 * Zod-validated verdict for the sales team.
 *
 * OpenCode vision is the default path: PDF pages are rendered to images and
 * sent to MiMo-V2.5 Free, with Kimi K2.6 on OpenCode Go as the fallback.
 * The legacy native-PDF Anthropic path remains available for compatibility.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { renderPdfPages, type RenderedPdfPage } from "./pdfRenderer.js";

export type { RenderedPdfPage } from "./pdfRenderer.js";

export type SpecAiProvider = "opencode" | "anthropic";
export type OpenCodeTransport = "chat-completions" | "messages";

export const DEFAULT_SPEC_MODEL = "mimo-v2.5-free";
export const DEFAULT_SPEC_BASE_URL = "https://opencode.ai/zen/v1";
export const DEFAULT_SPEC_FALLBACK_MODEL = "kimi-k2.6";
export const DEFAULT_SPEC_FALLBACK_BASE_URL = "https://opencode.ai/zen/go/v1";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

// Kimi K2.6 may use a substantial part of the completion budget for internal
// reasoning before emitting the requested JSON object.
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_MAX_ATTEMPTS_PER_MODEL = 2;

/** Our business context - used to ground the "can we supply this" verdict. */
const SUPPLIER_PROFILE =
  "Мы - поставщик компьютерной и офисной техники: компьютеры, моноблоки, " +
  "ноутбуки, мониторы, серверы, МФУ/принтеры, интерактивные панели, " +
  "комплектующие и сопутствующая оргтехника.";

export const SpecAnalysisSchema = z.object({
  product: z.string().describe("Что закупают, кратко"),
  summary: z.string().describe("Суть спецификации в 1-3 предложениях"),
  keyParams: z.array(z.string()).describe("Ключевые тех. параметры/требования к товару"),
  quantity: z.string().describe("Количество/объём, как указано в спеке"),
  deadline: z.string().describe("Срок поставки/исполнения"),
  supplierRequirements: z.array(z.string()).describe("Требования к поставщику"),
  fitVerdict: z.enum(["можем", "спорно", "нет"]),
  fitReason: z.string().describe("Обоснование вердикта"),
  risks: z.array(z.string()).describe("Риски/подводные камни")
});

export type SpecAnalysis = z.infer<typeof SpecAnalysisSchema>;

interface SpecModelTarget {
  apiKey: string;
  baseUrl: string;
  model: string;
  transport: OpenCodeTransport;
}

export interface ResolvedSpecAiConfig {
  provider: SpecAiProvider;
  apiKey: string;
  baseUrl: string | undefined;
  model: string;
  transport: OpenCodeTransport | null;
  fallback: SpecModelTarget | null;
}

export interface AnalyzeSpecOptions {
  provider?: SpecAiProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  transport?: OpenCodeTransport;
  fallbackApiKey?: string;
  fallbackBaseUrl?: string;
  fallbackModel?: string | null;
  fallbackTransport?: OpenCodeTransport;
  /** Grounding context, e.g. lot name / customer from the deal. */
  context?: string;
  maxTokens?: number;
  maxAttemptsPerModel?: number;
  fetchImpl?: typeof fetch;
  renderPdf?: (pdf: Buffer) => Promise<RenderedPdfPage[]>;
  client?: Anthropic;
}

/** Resolves provider, credentials, primary model and optional fallback. */
export function resolveClientConfig(options: AnalyzeSpecOptions = {}): ResolvedSpecAiConfig {
  const cloudBaseUrl = process.env.CLOUD_BASE_URL?.trim();
  const cloudModel = process.env.CLOUD_MODEL?.trim();
  const specModel = process.env.SPEC_ANALYSIS_MODEL?.trim();
  const provider = options.provider
    ?? parseProvider(process.env.SPEC_ANALYSIS_PROVIDER)
    ?? inferProvider(
      options.baseUrl ?? cloudBaseUrl ?? process.env.ANTHROPIC_BASE_URL?.trim(),
      options.model ?? cloudModel ?? specModel
    );

  if (provider === "anthropic") {
    const apiKey = options.apiKey
      ?? process.env.ANTHROPIC_API_KEY?.trim()
      ?? process.env.CLOUD_API_KEY?.trim();
    if (!apiKey) throw new Error("CLOUD_API_KEY (or ANTHROPIC_API_KEY) is not set");
    return {
      provider,
      apiKey,
      baseUrl: normalizeAnthropicBaseUrl(
        options.baseUrl ?? process.env.ANTHROPIC_BASE_URL?.trim() ?? cloudBaseUrl
      ),
      model: options.model ?? specModel ?? cloudModel ?? DEFAULT_ANTHROPIC_MODEL,
      transport: null,
      fallback: null
    };
  }

  const apiKey = options.apiKey
    ?? process.env.OPENCODE_API_KEY?.trim()
    ?? process.env.CLOUD_API_KEY?.trim();
  if (!apiKey) throw new Error("CLOUD_API_KEY (or OPENCODE_API_KEY) is not set");

  const baseUrl = normalizeOpenAiBaseUrl(
    options.baseUrl
      ?? process.env.OPENCODE_BASE_URL?.trim()
      ?? openCodeCompatibleBaseUrl(cloudBaseUrl)
      ?? DEFAULT_SPEC_BASE_URL
  );
  const model = options.model
    ?? process.env.OPENCODE_MODEL?.trim()
    ?? openCodeCompatibleModel(cloudModel)
    ?? openCodeCompatibleModel(specModel)
    ?? DEFAULT_SPEC_MODEL;
  const transport = options.transport ?? inferOpenCodeTransport(model);
  const envFallbackModel = process.env.SPEC_ANALYSIS_FALLBACK_MODEL?.trim();
  const fallbackModel = options.fallbackModel !== undefined
    ? options.fallbackModel
    : envFallbackModel?.toLowerCase() === "none"
      ? null
      : envFallbackModel || DEFAULT_SPEC_FALLBACK_MODEL;
  const fallbackBaseUrl = normalizeOpenAiBaseUrl(
    options.fallbackBaseUrl
      ?? process.env.SPEC_ANALYSIS_FALLBACK_BASE_URL?.trim()
      ?? DEFAULT_SPEC_FALLBACK_BASE_URL
  );

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    transport,
    fallback: fallbackModel
      ? {
          apiKey: options.fallbackApiKey ?? process.env.SPEC_ANALYSIS_FALLBACK_API_KEY?.trim() ?? apiKey,
          baseUrl: fallbackBaseUrl,
          model: fallbackModel,
          transport: options.fallbackTransport ?? inferOpenCodeTransport(fallbackModel)
        }
      : null
  };
}

function parseProvider(raw: string | undefined): SpecAiProvider | null {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "opencode" || normalized === "anthropic") return normalized;
  throw new Error(`Unsupported SPEC_ANALYSIS_PROVIDER: ${raw}`);
}

function inferProvider(baseUrl: string | undefined, model: string | undefined): SpecAiProvider {
  if (/anthropic\.com/i.test(baseUrl ?? "") || /^claude-/i.test(model ?? "")) return "anthropic";
  return "opencode";
}

function openCodeCompatibleBaseUrl(baseUrl: string | undefined): string | undefined {
  return /anthropic\.com/i.test(baseUrl ?? "") ? undefined : baseUrl;
}

function openCodeCompatibleModel(model: string | undefined): string | undefined {
  return /^claude-/i.test(model ?? "") ? undefined : model;
}

function inferOpenCodeTransport(model: string): OpenCodeTransport {
  return /^(?:qwen|mini?max)/i.test(model) ? "messages" : "chat-completions";
}

function normalizeAnthropicBaseUrl(rawBaseUrl: string | undefined): string | undefined {
  if (!rawBaseUrl) return undefined;
  const trimmed = rawBaseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  if (!trimmed || /^https:\/\/api\.anthropic\.com$/i.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeOpenAiBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) throw new Error(`AI base URL must be http(s): ${rawBaseUrl}`);
  return trimmed;
}

const INSTRUCTIONS = [
  "Ты - ассистент отдела продаж. Проанализируй приложенную техническую спецификацию тендера.",
  SUPPLIER_PROFILE,
  "Верни СТРОГО один JSON-объект (без markdown, без пояснений вокруг) со следующими полями:",
  "- product: string - что закупают, кратко;",
  "- summary: string - суть спецификации в 1-3 предложениях;",
  "- keyParams: string[] - ключевые технические параметры/требования к товару;",
  "- quantity: string - количество/объём (как в спеке; если нет - \"не указано\");",
  "- deadline: string - срок поставки/исполнения (если нет - \"не указано\");",
  "- supplierRequirements: string[] - требования к поставщику;",
  "- fitVerdict: одно из \"можем\" | \"спорно\" | \"нет\" - можем ли мы это поставить;",
  "- fitReason: string - короткое обоснование вердикта;",
  "- risks: string[] - риски/подводные камни (пустой массив, если нет).",
  "Пиши на русском. Массивы не должны содержать пустых строк; если данных нет - пустой массив."
].join("\n");

/** Extracts and validates analysis JSON from raw model text. */
export function parseSpecAnalysis(rawText: string): SpecAnalysis {
  const jsonText = extractJsonObject(rawText);
  if (!jsonText) throw new Error("no JSON object found in model response");

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`invalid JSON in model response: ${error instanceof Error ? error.message : String(error)}`);
  }

  return SpecAnalysisSchema.parse(parsed);
}

/** Renders the analysis into a plain-text block for the Bitrix summary field. */
export function buildSpecSummaryText(analysis: SpecAnalysis): string {
  const lines = [
    `Товар: ${analysis.product}`,
    `Суть: ${analysis.summary}`,
    `Количество: ${analysis.quantity}`,
    `Срок: ${analysis.deadline}`
  ];
  if (analysis.keyParams.length > 0) {
    lines.push("Ключевые параметры:", ...analysis.keyParams.map((param) => `• ${param}`));
  }
  if (analysis.supplierRequirements.length > 0) {
    lines.push("Требования к поставщику:", ...analysis.supplierRequirements.map((req) => `• ${req}`));
  }
  lines.push(`Вывод: ${verdictLabel(analysis.fitVerdict)} — ${analysis.fitReason}`);
  if (analysis.risks.length > 0) {
    lines.push("Риски:", ...analysis.risks.map((risk) => `• ${risk}`));
  }
  return lines.join("\n");
}

function verdictLabel(verdict: SpecAnalysis["fitVerdict"]): string {
  if (verdict === "можем") return "МОЖЕМ ПОСТАВИТЬ";
  if (verdict === "спорно") return "СПОРНО";
  return "НЕ НАШЕ";
}

export interface OpenCodeVisionRequest {
  model: string;
  max_tokens: number;
  response_format: { type: "json_object" };
  thinking?: { type: "disabled" };
  messages: Array<{
    role: "user";
    content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;
  }>;
}

export interface OpenCodeMessagesRequest {
  model: string;
  max_tokens: number;
  thinking: { type: "disabled" };
  messages: Array<{
    role: "user";
    content: Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: { type: "base64"; media_type: RenderedPdfPage["mediaType"]; data: string };
        }
    >;
  }>;
}

/** Builds the OpenAI-compatible multimodal payload used by OpenCode Zen/Go. */
export function buildOpenCodeVisionRequest(
  model: string,
  maxTokens: number,
  prompt: string,
  pages: RenderedPdfPage[]
): OpenCodeVisionRequest {
  if (pages.length === 0) throw new Error("no rendered pages were produced for the PDF");
  const ordered = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  return {
    model,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    ...(/^kimi-/i.test(model) ? { thinking: { type: "disabled" as const } } : {}),
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...ordered.map((page) => ({
          type: "image_url" as const,
          image_url: { url: `data:${page.mediaType};base64,${page.base64}` }
        }))
      ]
    }]
  };
}

/** Builds the Anthropic-compatible multimodal payload used by Qwen on OpenCode Go. */
export function buildOpenCodeMessagesRequest(
  model: string,
  maxTokens: number,
  prompt: string,
  pages: RenderedPdfPage[]
): OpenCodeMessagesRequest {
  if (pages.length === 0) throw new Error("no rendered pages were produced for the PDF");
  const ordered = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  return {
    model,
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...ordered.map((page) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: page.mediaType,
            data: page.base64
          }
        }))
      ]
    }]
  };
}

/** Analyses a PDF using OpenCode vision or the legacy Anthropic native-PDF path. */
export async function analyzeSpecPdf(pdf: Buffer, options: AnalyzeSpecOptions = {}): Promise<SpecAnalysis> {
  const config = resolveClientConfig(options);
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxAttempts = options.maxAttemptsPerModel ?? DEFAULT_MAX_ATTEMPTS_PER_MODEL;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttemptsPerModel must be a positive integer");
  const prompt = buildPrompt(options.context);

  if (config.provider === "anthropic") {
    return analyzeWithAnthropic(pdf, prompt, config, maxTokens, maxAttempts, options.client);
  }

  const pages = await (options.renderPdf ?? renderPdfPages)(pdf);
  const targets: SpecModelTarget[] = [{
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? DEFAULT_SPEC_BASE_URL,
    model: config.model,
    transport: config.transport ?? inferOpenCodeTransport(config.model)
  }];
  if (config.fallback && !sameTarget(targets[0], config.fallback)) targets.push(config.fallback);

  const errors: string[] = [];
  for (const target of targets) {
    try {
      return await analyzeWithOpenCodeTarget(
        target,
        pages,
        prompt,
        maxTokens,
        maxAttempts,
        options.fetchImpl ?? fetch
      );
    } catch (error) {
      errors.push(`${target.model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`spec analysis failed across all configured models: ${errors.join(" | ")}`);
}

function buildPrompt(context: string | undefined): string {
  const contextLine = context ? `Контекст лота: ${context}` : null;
  return [INSTRUCTIONS, contextLine].filter(Boolean).join("\n\n");
}

async function analyzeWithOpenCodeTarget(
  target: SpecModelTarget,
  pages: RenderedPdfPage[],
  prompt: string,
  maxTokens: number,
  maxAttempts: number,
  fetchImpl: typeof fetch
): Promise<SpecAnalysis> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const retryReminder = attempt > 0
      ? "Предыдущий ответ был ошибочным. Верни только один валидный JSON-объект по указанной схеме."
      : null;
    try {
      const requestPrompt = [prompt, retryReminder].filter(Boolean).join("\n\n");
      const isMessages = target.transport === "messages";
      const response = await fetchImpl(`${target.baseUrl}/${isMessages ? "messages" : "chat/completions"}`, {
        method: "POST",
        headers: isMessages
          ? {
              authorization: `Bearer ${target.apiKey}`,
              "x-api-key": target.apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json"
            }
          : {
              authorization: `Bearer ${target.apiKey}`,
              "content-type": "application/json"
            },
        body: JSON.stringify(isMessages
          ? buildOpenCodeMessagesRequest(target.model, maxTokens, requestPrompt, pages)
          : buildOpenCodeVisionRequest(target.model, maxTokens, requestPrompt, pages))
      });
      const payload = await readJsonPayload(response);
      if (!response.ok) throw new Error(openCodeErrorMessage(payload, response.status));
      return parseSpecAnalysis(isMessages ? extractOpenCodeMessagesText(payload) : extractOpenCodeText(payload));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("OpenCode request failed");
}

async function readJsonPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`AI gateway returned non-JSON response (HTTP ${response.status})`);
  }
}

function openCodeErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    return `HTTP ${status}: ${String((payload as { message?: unknown }).message ?? "provider error")}`;
  }
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return `HTTP ${status}: ${error}`;
    if (error && typeof error === "object" && "message" in error) {
      return `HTTP ${status}: ${String((error as { message?: unknown }).message ?? "provider error")}`;
    }
  }
  return `HTTP ${status}`;
}

function extractOpenCodeMessagesText(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new Error("AI response is not an object");
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("AI response has no content blocks");
  const text = content
    .map((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
      ? String((part as { text?: unknown }).text ?? "")
      : "")
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) throw new Error("AI response has no text content");
  return text;
}

function extractOpenCodeText(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new Error("AI response is not an object");
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error("AI response has no choices");
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const content = first.message?.content ?? first.text;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map((part) => part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }
  throw new Error("AI response has no text content");
}

async function analyzeWithAnthropic(
  pdf: Buffer,
  prompt: string,
  config: ResolvedSpecAiConfig,
  maxTokens: number,
  maxAttempts: number,
  injectedClient: Anthropic | undefined
): Promise<SpecAnalysis> {
  const client = injectedClient ?? new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {})
  });
  const base64 = pdf.toString("base64");
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const retryReminder = attempt > 0
      ? "Предыдущий ответ не был валидным JSON. Верни ТОЛЬКО один валидный JSON-объект по схеме выше."
      : null;
    try {
      const message = await client.messages.create({
        model: config.model,
        max_tokens: maxTokens,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: [prompt, retryReminder].filter(Boolean).join("\n\n") }
          ]
        }]
      });
      return parseSpecAnalysis(extractAnthropicResponseText(message));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Anthropic request failed");
}

function extractAnthropicResponseText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function sameTarget(left: SpecModelTarget, right: SpecModelTarget): boolean {
  return left.baseUrl === right.baseUrl && left.model === right.model && left.transport === right.transport;
}

function extractJsonObject(rawText: string): string | null {
  const withoutFences = rawText.replace(/```(?:json)?/gi, "").trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return withoutFences.slice(start, end + 1);
}
