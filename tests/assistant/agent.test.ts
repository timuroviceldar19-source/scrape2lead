import { describe, expect, it } from "vitest";
import { runAgent, type AgentClient, type AgentTool } from "../../src/assistant/agent.js";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
interface Reply {
  content: Array<Block | Record<string, unknown>>;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "pause_turn";
  usage: { input_tokens: number; output_tokens: number; server_tool_use?: { web_search_requests: number } };
}

function scripted(replies: Reply[]) {
  const requests: Array<Record<string, any>> = [];
  const queue = [...replies];
  const client: AgentClient = {
    messages: {
      create: async (params) => {
        requests.push(JSON.parse(JSON.stringify(params)));
        // последний ответ повторяется, пока цикл не остановится сам
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (!next) throw new Error("no scripted reply");
        return next as never;
      }
    }
  };
  return { client, requests };
}

const toolUse = (id: string, name: string, input: unknown = {}): Reply => ({
  content: [{ type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 2 }
});
const answer = (text: string): Reply => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 5 } });

const getDeal = (run: AgentTool["run"]): AgentTool => ({
  name: "get_deal",
  description: "Сделка по номеру",
  input_schema: { type: "object", properties: { deal_id: { type: "number" } }, required: ["deal_id"] },
  run
});

const base = { model: "claude-haiku-5-5", system: "Ты помощник", userText: "оцени сделку 1" };

describe("runAgent", () => {
  it("runs the requested tool, feeds the result back and returns the final answer", async () => {
    const { client, requests } = scripted([toolUse("tu_1", "get_deal", { deal_id: 1 }), answer("Берём")]);
    const seen: unknown[] = [];

    const result = await runAgent({ ...base, client, tools: [getDeal(async (input) => (seen.push(input), "сделка 1"))] });

    expect(seen).toEqual([{ deal_id: 1 }]);
    expect(result.text).toBe("Берём");
    expect(result.toolCalls).toEqual(["get_deal"]);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 7 });
    expect(requests[1].messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "сделка 1" }]
    });
  });

  it("sends model, system prompt and tool schemas without the run function", async () => {
    const { client, requests } = scripted([answer("ок")]);

    await runAgent({ ...base, client, tools: [getDeal(async () => "x")] });

    expect(requests[0].model).toBe("claude-haiku-5-5");
    expect(requests[0].system).toBe("Ты помощник");
    expect(requests[0].tools).toEqual([
      { name: "get_deal", description: "Сделка по номеру", input_schema: { type: "object", properties: { deal_id: { type: "number" } }, required: ["deal_id"] } }
    ]);
    expect(requests[0].messages).toEqual([{ role: "user", content: "оцени сделку 1" }]);
  });

  it("puts earlier messages of the dialog before the new question", async () => {
    const { client, requests } = scripted([answer("ок")]);

    await runAgent({ ...base, client, tools: [], history: [{ role: "user", content: "привет" }, { role: "assistant", content: "здравствуйте" }] });

    expect(requests[0].messages.map((m: any) => m.content)).toEqual(["привет", "здравствуйте", "оцени сделку 1"]);
  });

  it("tells the model about an unknown tool instead of crashing", async () => {
    const { client, requests } = scripted([toolUse("tu_1", "nope"), answer("не получилось")]);

    const result = await runAgent({ ...base, client, tools: [] });

    expect(result.text).toBe("не получилось");
    expect(requests[1].messages.at(-1).content[0]).toMatchObject({ tool_use_id: "tu_1", is_error: true });
  });

  it("turns a failing tool into an error result with the message only", async () => {
    const { client, requests } = scripted([toolUse("tu_1", "get_deal", { deal_id: 9 }), answer("сделка недоступна")]);

    await runAgent({
      ...base,
      client,
      tools: [getDeal(async () => {
        throw new Error("Сделка 9 не найдена");
      })]
    });

    const block = requests[1].messages.at(-1).content[0];
    expect(block.is_error).toBe(true);
    expect(block.content).toBe("Сделка 9 не найдена");
  });

  it("stops after the turn limit with a notice", async () => {
    const { client, requests } = scripted([toolUse("tu_1", "get_deal", { deal_id: 1 })]);

    const result = await runAgent({ ...base, client, tools: [getDeal(async () => "x")], maxTurns: 3 });

    expect(requests).toHaveLength(3);
    expect(result.text).toMatch(/лимит шагов|слишком много шагов/i);
  });

  it("cuts very long tool output", async () => {
    const { client, requests } = scripted([toolUse("tu_1", "get_deal", { deal_id: 1 }), answer("ок")]);

    await runAgent({ ...base, client, tools: [getDeal(async () => "я".repeat(50_000))], maxToolOutputChars: 1000 });

    const content = requests[1].messages.at(-1).content[0].content as string;
    expect(content.length).toBeLessThan(1200);
    expect(content).toContain("обрезано");
  });

  it("leaves room for a long answer", async () => {
    const { client, requests } = scripted([answer("ok")]);

    await runAgent({ ...base, client, tools: [] });

    expect(requests[0].max_tokens).toBe(6000);
  });

  it("tells the reader when the model ran out of room and the answer was cut short", async () => {
    const cut: Reply = { content: [{ type: "text", text: "- Первый контакт\n- Второй конт" }], stop_reason: "max_tokens", usage: { input_tokens: 20, output_tokens: 3000 } };
    const { client } = scripted([cut]);

    const result = await runAgent({ ...base, client, tools: [] });

    expect(result.text.startsWith("- Первый контакт\n- Второй конт")).toBe(true);
    expect(result.text).toMatch(/ответ обрезан/i);
  });
});


describe("runAgent web search", () => {
  const WEB = { type: "web_search_20250305", name: "web_search", max_uses: 3 };
  const searched = (): Reply => ({
    content: [
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "Жасыл даму собственник" } },
      { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://gov.kz/a", title: "Минэкологии" }] },
      { type: "text", text: "Принадлежит Минэкологии.", citations: [{ type: "web_search_result_location", url: "https://gov.kz/a", title: "Минэкологии" }] },
      { type: "text", text: " Правление: Сәрсенбай.", citations: [{ type: "web_search_result_location", url: "https://recycle.kz/pravlenie", title: "Правление" }, { type: "web_search_result_location", url: "https://gov.kz/a", title: "Минэкологии" }] }
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 40000, output_tokens: 900, server_tool_use: { web_search_requests: 2 } }
  });

  it("sends the server tool next to ours, counts the searches and lists each source link once", async () => {
    const { client, requests } = scripted([searched()]);

    const result = await runAgent({ ...base, client, tools: [getDeal(async () => "x")], serverTools: [WEB] });

    expect(requests[0].tools.map((tool: { name: string }) => tool.name)).toEqual(["get_deal", "web_search"]);
    expect(requests[0].tools[1]).toEqual(WEB);
    expect(result.webSearches).toBe(2);
    expect(result.text).toContain("Принадлежит Минэкологии.");
    expect(result.text).toMatch(/Источники:\n- Минэкологии https:\/\/gov\.kz\/a\n- Правление https:\/\/recycle\.kz\/pravlenie$/);
  });

  it("says nothing about sources when the answer cites none, and counts zero searches", async () => {
    const { client } = scripted([answer("Берём")]);

    const result = await runAgent({ ...base, client, tools: [getDeal(async () => "x")], serverTools: [WEB] });

    expect(result.text).toBe("Берём");
    expect(result.webSearches).toBe(0);
  });

  it("carries on when the API pauses a long search, sending the paused turn back as it was", async () => {
    const paused: Reply = { content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } }], stop_reason: "pause_turn", usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 1 } } };
    const { client, requests } = scripted([paused, answer("Нашёл")]);

    const result = await runAgent({ ...base, client, tools: [], serverTools: [WEB] });

    expect(result.text).toBe("Нашёл");
    expect(result.turns).toBe(2);
    expect(result.webSearches).toBe(1);
    expect(requests[1].messages.at(-1)).toEqual({ role: "assistant", content: paused.content });
  });
});
