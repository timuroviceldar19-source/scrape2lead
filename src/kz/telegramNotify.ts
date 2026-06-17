import fs from "node:fs";
import path from "node:path";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** null, если TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы — уведомления скипаются. */
export function getTelegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

export async function sendTelegramMessage(config: TelegramConfig, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true })
  });
  await assertTelegramOk(response, "sendMessage");
}

export async function sendTelegramDocument(
  config: TelegramConfig,
  filePath: string,
  caption?: string
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", config.chatId);
  if (caption) form.append("caption", caption);
  const buffer = fs.readFileSync(filePath);
  form.append(
    "document",
    new Blob([new Uint8Array(buffer)], { type: "application/octet-stream" }),
    path.basename(filePath)
  );

  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendDocument`, {
    method: "POST",
    body: form
  });
  await assertTelegramOk(response, "sendDocument");
}

async function assertTelegramOk(response: Response, method: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`telegram ${method} failed: HTTP ${response.status} ${body.slice(0, 300)}`);
}
