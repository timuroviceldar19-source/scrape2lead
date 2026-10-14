import { describe, expect, it } from "vitest";
import type { AgentClient } from "../../src/assistant/agent.js";
import { createAssistant, createPdfExtractor } from "../../src/assistant/createAssistant.js";
import { SYSTEM_PROMPT } from "../../src/assistant/systemPrompt.js";

function client(answers: string[]) {
  const requests: Array<Record<string, any>> = [];
  const queue = [...answers];
  const fake: AgentClient = {
    messages: {
      create: async (params) => {
        requests.push(JSON.parse(JSON.stringify(params)));
        return { content: [{ type: "text", text: queue.shift() ?? "ок" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } };
      }
    }
  };
  return { fake, requests };
}

const noTools = { crm: {} as never, goszakup: {} as never, portal: {} as never, extractFromPdf: async () => "" };

describe("createAssistant", () => {
  it("uses the configured model and the system prompt", async () => {
    const { fake, requests } = client(["Берём"]);
    const assistant = createAssistant({ client: fake, model: "claude-haiku-5-5", toolDeps: noTools });

    const result = await assistant.ask("оцени сделку 1", 2301);

    expect(result.text).toBe("Берём");
    expect(requests[0].model).toBe("claude-haiku-5-5");
    expect(requests[0].system.startsWith(SYSTEM_PROMPT)).toBe(true);
  });

  it("tells the model what time it is in Almaty, so it can judge how close a deadline is", async () => {
    const { fake, requests } = client(["ок"]);
    const assistant = createAssistant({ client: fake, model: "m", toolDeps: noTools, now: () => new Date("2026-10-14T05:41:00Z") });

    await assistant.ask("срок поджимает?", 2301);

    expect(requests[0].system).toContain("2026-10-14 10:41");
    expect(requests[0].system).toMatch(/Алматы/);
  });

  it("lets the model search the web on its own, with no condition on the question", async () => {
    const { fake, requests } = client(["ок"]);
    const assistant = createAssistant({ client: fake, model: "m", toolDeps: noTools });

    await assistant.ask("040340008429", 2301);

    expect(requests[0].tools.at(-1)).toMatchObject({ type: "web_search_20250305", name: "web_search" });
  });

  it("keeps working without the web when the Anthropic account has web search switched off", async () => {
    const requests: Array<Record<string, any>> = [];
    const fake: AgentClient = {
      messages: {
        create: async (params) => {
          requests.push(JSON.parse(JSON.stringify(params)));
          if (JSON.stringify(params.tools).includes("web_search")) throw Object.assign(new Error("400 invalid_request_error: web search is not enabled for this organization"), { status: 400 });
          return { content: [{ type: "text", text: "Без интернета" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
        }
      }
    };
    const assistant = createAssistant({ client: fake, model: "m", toolDeps: noTools });

    expect((await assistant.ask("040340008429", 1)).text).toBe("Без интернета");
    expect((await assistant.ask("040340008429", 1)).text).toBe("Без интернета");

    // первый вопрос: попытка с поиском и повтор без него; второй: сразу без поиска
    expect(requests.map((request) => JSON.stringify(request.tools).includes("web_search"))).toEqual([true, false, false]);
  });

  it("remembers the last exchange of the same user for follow-up questions", async () => {
    const { fake, requests } = client(["Сделка 1: берём", "Контакты: ..."]);
    const assistant = createAssistant({ client: fake, model: "m", toolDeps: noTools });

    await assistant.ask("оцени сделку 1", 2301);
    await assistant.ask("а контакты?", 2301);

    expect(requests[1].messages.map((m: any) => m.content)).toEqual(["оцени сделку 1", "Сделка 1: берём", "а контакты?"]);
  });

  it("does not leak one user's dialog to another", async () => {
    const { fake, requests } = client(["ответ 1", "ответ 2"]);
    const assistant = createAssistant({ client: fake, model: "m", toolDeps: noTools });

    await assistant.ask("секретный вопрос", 1);
    await assistant.ask("мой вопрос", 2);

    expect(requests[1].messages.map((m: any) => m.content)).toEqual(["мой вопрос"]);
  });

  it("keeps only the most recent exchanges", async () => {
    const { fake, requests } = client([]);
    const assistant = createAssistant({ client: fake, model: "m", toolDeps: noTools, historyExchanges: 2 });

    for (const q of ["q1", "q2", "q3", "q4"]) await assistant.ask(q, 7);

    expect(requests[3].messages.map((m: any) => m.content)).toEqual(["q2", "ок", "q3", "ок", "q4"]);
  });
});

describe("createAssistant tools", () => {
  it("lets the tools know who is asking, so my_deals shows that person's deals", async () => {
    const asked: number[] = [];
    const replies = [
      { content: [{ type: "tool_use", id: "t1", name: "my_deals", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } },
      { content: [{ type: "text", text: "Вот ваши сделки" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } }
    ];
    const fake: AgentClient = { messages: { create: async () => replies.shift() as never } };
    const toolDeps = { ...noTools, crm: { listMyDeals: async (request: { userId: number }) => (asked.push(request.userId), { total: 0, deals: [] }) } as never };
    const assistant = createAssistant({ client: fake, model: "m", toolDeps, now: () => new Date("2026-10-13T08:00:00Z") });

    const result = await assistant.ask("что у меня в работе", 1665);

    expect(asked).toEqual([1665]);
    expect(result.toolCalls).toEqual(["my_deals"]);
  });
});

describe("createPdfExtractor usage", () => {
  it("reports the tokens of the separate PDF request so the total cost is not understated", async () => {
    const { fake } = client(["выжимка"]);
    const reported: Array<{ inputTokens: number; outputTokens: number }> = [];

    await createPdfExtractor(fake, "m", (usage) => reported.push(usage))("QUJD", "вопрос");

    expect(reported).toEqual([{ inputTokens: 10, outputTokens: 3 }]);
  });
});

describe("createPdfExtractor", () => {
  it("sends the PDF as a document block with the question and returns the text", async () => {
    const { fake, requests } = client(["Контакт: Петров, тел. 111"]);

    const text = await createPdfExtractor(fake, "claude-haiku-5-5")("QUJD", "Что в документе?");

    expect(text).toBe("Контакт: Петров, тел. 111");
    expect(requests[0].messages[0].content).toEqual([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } },
      { type: "text", text: "Что в документе?" }
    ]);
  });
});
