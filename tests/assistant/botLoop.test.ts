import { describe, expect, it } from "vitest";
import type { BotEvent, EventsPage, IncomingMessage } from "../../src/assistant/bitrixBotClient.js";
import { createPollState, pollOnce } from "../../src/assistant/botLoop.js";

const messageEvent = (eventId: number, messageId: number, text = "привет"): BotEvent => ({
  eventId,
  type: "ONIMBOTV2MESSAGEADD",
  date: "d",
  data: { chat: { dialogId: "chat5", type: "chat" }, message: { id: messageId, text, authorId: 2301 }, user: { id: 2301 } }
});

function bot(pages: EventsPage[]) {
  const offsets: Array<number | undefined> = [];
  const queue = [...pages];
  return {
    offsets,
    client: {
      pollEvents: async (input: { botId: number; offset?: number }) => {
        offsets.push(input.offset);
        return queue.shift() ?? { events: [], nextOffset: null, hasMore: false };
      }
    }
  };
}

describe("pollOnce", () => {
  it("confirms processed events through the offset on the next poll", async () => {
    const { client, offsets } = bot([
      { events: [messageEvent(5, 77)], nextOffset: 6, hasMore: false },
      { events: [], nextOffset: 6, hasMore: false }
    ]);
    const state = createPollState();
    const handled: IncomingMessage[] = [];
    const handle = async (m: IncomingMessage) => void handled.push(m);

    const first = await pollOnce({ bot: client, botId: 1, handle, state });
    await pollOnce({ bot: client, botId: 1, handle, state });

    expect(first).toEqual({ handled: 1, hasMore: false });
    expect(handled[0]).toMatchObject({ messageId: 77, text: "привет", dialogId: "chat5" });
    expect(offsets).toEqual([undefined, 6]);
  });

  it("does not handle the same message twice if Bitrix delivers it again", async () => {
    const { client } = bot([
      { events: [messageEvent(5, 77)], nextOffset: 6, hasMore: false },
      { events: [messageEvent(5, 77)], nextOffset: 6, hasMore: false }
    ]);
    const state = createPollState();
    let count = 0;
    const handle = async () => void (count += 1);

    await pollOnce({ bot: client, botId: 1, handle, state });
    await pollOnce({ bot: client, botId: 1, handle, state });

    expect(count).toBe(1);
  });

  it("keeps going when one message fails and still advances the offset", async () => {
    const { client, offsets } = bot([
      { events: [messageEvent(5, 77, "плохое"), messageEvent(6, 78, "хорошее")], nextOffset: 7, hasMore: false },
      { events: [], nextOffset: 7, hasMore: false }
    ]);
    const state = createPollState();
    const done: string[] = [];
    const errors: string[] = [];
    const handle = async (m: IncomingMessage) => {
      if (m.text === "плохое") throw new Error("boom");
      done.push(m.text);
    };

    const result = await pollOnce({ bot: client, botId: 1, handle, state, onError: (e) => errors.push(String(e)) });
    await pollOnce({ bot: client, botId: 1, handle, state });

    expect(done).toEqual(["хорошее"]);
    expect(result.handled).toBe(1);
    expect(errors).toHaveLength(1);
    expect(offsets).toEqual([undefined, 7]);
  });

  it("ignores events that are not new messages but still moves the offset", async () => {
    const { client, offsets } = bot([
      { events: [{ eventId: 9, type: "ONIMBOTV2JOINCHAT", date: "d", data: {} }], nextOffset: 10, hasMore: true },
      { events: [], nextOffset: 10, hasMore: false }
    ]);
    const state = createPollState();

    const first = await pollOnce({ bot: client, botId: 1, handle: async () => undefined, state });
    await pollOnce({ bot: client, botId: 1, handle: async () => undefined, state });

    expect(first).toEqual({ handled: 0, hasMore: true });
    expect(offsets).toEqual([undefined, 10]);
  });
});
