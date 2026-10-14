/**
 * Цикл «вопрос → инструменты → ответ» поверх Claude Messages API.
 * Модель просит вызвать инструмент, мы выполняем его, возвращаем результат и так до финального ответа.
 * Сбой инструмента не роняет цикл: модель получает текст ошибки и отвечает по тому, что есть.
 */

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run(input: unknown): Promise<string>;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: unknown;
}

/** Минимум от клиента Anthropic: так цикл проверяется на заглушке без сети. */
export interface AgentClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: AgentMessage[];
      tools?: Array<Record<string, unknown>>;
    }): Promise<{
      content: Array<{ type: string; [key: string]: unknown }>;
      stop_reason: string | null;
      usage: { input_tokens: number; output_tokens: number; server_tool_use?: { web_search_requests?: number } };
    }>;
  };
}

export interface RunAgentOptions {
  client: AgentClient;
  model: string;
  system: string;
  userText: string;
  tools: AgentTool[];
  /** Инструменты, которые исполняет сам Anthropic (например поиск в интернете): уходят в запрос как есть. */
  serverTools?: Array<Record<string, unknown>>;
  history?: AgentMessage[];
  maxTurns?: number;
  maxTokens?: number;
  maxToolOutputChars?: number;
}

export interface AgentResult {
  text: string;
  toolCalls: string[];
  usage: { inputTokens: number; outputTokens: number };
  /** Сколько поисков в интернете выполнено: каждый платный. */
  webSearches: number;
  turns: number;
}

const MAX_SOURCES = 6;
const DEFAULT_MAX_TURNS = 8;
// Досье с контактами, комиссией и интернет-поиском длинное: с запасом, чтобы ответ не обрывался.
const DEFAULT_MAX_TOKENS = 6000;
const DEFAULT_MAX_TOOL_OUTPUT = 12_000;

export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxOutput = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT;
  const toolDefs: Array<Record<string, unknown>> = [
    ...options.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    ...(options.serverTools ?? [])
  ];
  const messages: AgentMessage[] = [...(options.history ?? []), { role: "user", content: options.userText }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: string[] = [];
  const sources = new Map<string, string>();
  let webSearches = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const reply = await options.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: options.system,
      messages,
      ...(toolDefs.length ? { tools: toolDefs } : {})
    });
    usage.inputTokens += reply.usage.input_tokens;
    usage.outputTokens += reply.usage.output_tokens;
    webSearches += reply.usage.server_tool_use?.web_search_requests ?? 0;
    messages.push({ role: "assistant", content: reply.content });
    collectSources(reply.content, sources);

    // Долгий поиск API ставит на паузу: тот же ход отправляется обратно, и поиск продолжается.
    if (reply.stop_reason === "pause_turn") continue;

    const requested = reply.content.filter((block) => block.type === "tool_use");
    if (reply.stop_reason !== "tool_use" || requested.length === 0) {
      // Ответ с цитатами приходит кусками посреди предложений, поэтому куски склеиваются без переноса.
      const text = reply.content
        .filter((block) => block.type === "text")
        .map((block) => String(block.text ?? ""))
        .join("")
        .trim();
      const cutShort = reply.stop_reason === "max_tokens" ? `\n\n(Ответ обрезан: он получился слишком длинным. Попросите покороче или по частям.)` : "";
      return { text: text + cutShort + sourceList(sources), toolCalls, usage, webSearches, turns: turn };
    }

    const results = [];
    for (const block of requested) {
      const name = String(block.name);
      toolCalls.push(name);
      results.push(await runTool(options.tools, block, maxOutput));
    }
    messages.push({ role: "user", content: results });
  }

  return { text: `Остановился: слишком много шагов подряд (лимит шагов ${maxTurns}). Уточните вопрос или разбейте его на части.`, toolCalls, usage, webSearches, turns: maxTurns };
}

/** Ссылки, на которые сослался поиск в интернете: их показывает ответ (так требует Anthropic). */
function collectSources(content: Array<{ type: string; [key: string]: unknown }>, sources: Map<string, string>): void {
  for (const block of content) {
    if (block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations as Array<Record<string, unknown>>) {
      const url = typeof citation.url === "string" ? citation.url : "";
      if (url && !sources.has(url)) sources.set(url, String(citation.title ?? "").trim());
    }
  }
}

function sourceList(sources: Map<string, string>): string {
  if (!sources.size) return "";
  const lines = [...sources].slice(0, MAX_SOURCES).map(([url, title]) => `- ${title ? `${title} ` : ""}${url}`);
  return `\n\nИсточники:\n${lines.join("\n")}`;
}

async function runTool(tools: AgentTool[], block: { [key: string]: unknown }, maxOutput: number) {
  const id = String(block.id);
  const tool = tools.find((candidate) => candidate.name === block.name);
  if (!tool) return { type: "tool_result", tool_use_id: id, content: `Неизвестный инструмент ${String(block.name)}`, is_error: true };

  try {
    const output = await tool.run(block.input);
    return { type: "tool_result", tool_use_id: id, content: truncate(output, maxOutput) };
  } catch (error) {
    return { type: "tool_result", tool_use_id: id, content: error instanceof Error ? error.message : String(error), is_error: true };
  }
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…(обрезано, всего ${text.length} символов)` : text;
}
