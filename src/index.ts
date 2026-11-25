import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { replyToCustomer, resetConversation } from "./ai/seller.js";
import { BaileysClient } from "./whatsapp/baileys.js";
import { WahaClient } from "./whatsapp/waha.js";
import type { IncomingMessage, WhatsAppClient } from "./whatsapp/types.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/health", (_req, res) => res.json({ ok: true, provider: config.WHATSAPP_PROVIDER }));

const wa: WhatsAppClient =
  config.WHATSAPP_PROVIDER === "waha"
    ? new WahaClient(app, config.WAHA_URL, config.WAHA_API_KEY, config.WAHA_SESSION)
    : new BaileysClient(config.BAILEYS_AUTH_DIR);

async function notifyHuman(summary: string): Promise<void> {
  console.log(`[handoff] ${summary}`);
  if (config.ADMIN_PHONE) {
    await wa.sendText(wa.phoneToChatId(config.ADMIN_PHONE), `🔔 ${summary}`).catch((err) =>
      console.error("[handoff] could not notify admin", err),
    );
  }
}

// One message at a time per chat, so replies stay in order.
const queues = new Map<string, Promise<void>>();

async function handle(msg: IncomingMessage): Promise<void> {
  if (msg.text.trim().toLowerCase() === "/reset") {
    resetConversation(msg.chatId);
    await wa.sendText(msg.chatId, "Conversation reset.");
    return;
  }

  await wa.setTyping(msg.chatId, true);
  try {
    const reply = await replyToCustomer(
      { chatId: msg.chatId, senderName: msg.senderName, notifyHuman },
      msg.text,
    );
    if (reply) await wa.sendText(msg.chatId, reply);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      console.warn("[claude] rate limited");
    } else if (err instanceof Anthropic.APIError) {
      console.error(`[claude] API error ${err.status}:`, err.message);
    } else {
      console.error("[bot] error", err);
    }
    await wa.sendText(msg.chatId, "Sorry, something went wrong on our side. Please try again in a moment.");
  } finally {
    await wa.setTyping(msg.chatId, false);
  }
}

function enqueue(msg: IncomingMessage): Promise<void> {
  const prev = queues.get(msg.chatId) ?? Promise.resolve();
  const next = prev.then(() => handle(msg));
  const tracked = next.finally(() => {
    if (queues.get(msg.chatId) === tracked) queues.delete(msg.chatId);
  });
  queues.set(msg.chatId, tracked);
  return next;
}

await wa.start(enqueue);
app.listen(config.PORT, () => {
  console.log(`Server listening on :${config.PORT} (WhatsApp via ${config.WHATSAPP_PROVIDER})`);
});
