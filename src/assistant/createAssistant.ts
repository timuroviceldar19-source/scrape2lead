/**
 * Сборка ассистента: модель + инструменты + короткая память диалога каждого сотрудника.
 * Память хранится в процессе и только как «вопрос → итоговый ответ», без промежуточных вызовов инструментов.
 */

import { runAgent, type AgentClient, type AgentMessage, type AgentResult } from "./agent.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { almatyDateTime, buildTools, type ToolDeps } from "./tools.js";

const DEFAULT_HISTORY_EXCHANGES = 3;
/** Поиск в интернете Anthropic: модель сама решает, когда он нужен; три поиска на вопрос — верхняя граница. */
const WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 3 };

export interface CreateAssistantOptions {
  client: AgentClient;
  model: string;
  toolDeps: ToolDeps;
  /** Сколько последних пар «вопрос-ответ» помнить для уточняющих вопросов. */
  historyExchanges?: number;
  maxTurns?: number;
  /** Текущее время; в тестах подменяется. Нужно для сроков и «моих сделок». */
  now?: () => Date;
}

export interface Assistant {
  ask(text: string, userId: number): Promise<AgentResult>;
}

export function createAssistant(options: CreateAssistantOptions): Assistant {
  const keep = (options.historyExchanges ?? DEFAULT_HISTORY_EXCHANGES) * 2;
  const histories = new Map<number, AgentMessage[]>();
  // Если в аккаунте Anthropic поиск выключен, API отвечает ошибкой на каждый запрос с ним: тогда работаем без интернета.
  let webAvailable = true;

  return {
    async ask(text, userId) {
      const history = histories.get(userId) ?? [];
      // Инструменты собираются на каждый вопрос: «мои сделки» должны знать, кто спрашивает.
      const tools = buildTools(options.toolDeps, { userId, now: options.now });
      const run = (withWeb: boolean) =>
        runAgent({
          client: options.client,
          model: options.model,
          // Без часов модель не может сказать, горит ли срок: время Алматы дописывается к инструкции на каждый вопрос.
          system: `${SYSTEM_PROMPT}\n\nСейчас ${almatyDateTime((options.now ?? (() => new Date()))())} по Алматы (UTC+5).`,
          userText: text,
          tools,
          serverTools: withWeb ? [WEB_SEARCH] : [],
          history,
          maxTurns: options.maxTurns
        });
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run(webAvailable);
      } catch (error) {
        if (!webAvailable || !/web.?search/i.test(error instanceof Error ? error.message : String(error))) throw error;
        webAvailable = false;
        result = await run(false);
      }
      const exchange: AgentMessage[] = [
        { role: "user", content: text },
        { role: "assistant", content: result.text }
      ];
      histories.set(userId, [...history, ...exchange].slice(-keep));
      return result;
    }
  };
}

/**
 * Читает PDF отдельным запросом к модели и возвращает только выжимку по вопросу.
 * Токены этого запроса не входят в итог основного цикла, поэтому передаются в `onUsage`.
 */
export function createPdfExtractor(
  client: AgentClient,
  model: string,
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
): (base64: string, question: string) => Promise<string> {
  return async (base64, question) => {
    const reply = await client.messages.create({
      model,
      max_tokens: 1500,
      system: "Ты извлекаешь факты из документа. Отвечай только по тексту документа и ничего не выдумывай.",
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: question }
          ]
        }
      ]
    });
    onUsage?.({ inputTokens: reply.usage.input_tokens, outputTokens: reply.usage.output_tokens });
    return reply.content
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("\n")
      .trim();
  };
}
