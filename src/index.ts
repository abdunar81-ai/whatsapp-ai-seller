import "./logs.js";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { replyToCustomer } from "./ai/seller.js";
import { BaileysClient } from "./whatsapp/baileys.js";
import { WahaClient } from "./whatsapp/waha.js";
import type { IncomingMessage, WhatsAppClient } from "./whatsapp/types.js";
import { getChat, logMessage, recentHistory, resetHistory } from "./store/chats.js";
import { getSettings } from "./store/settings.js";
import { createQuestion } from "./store/questions.js";
import { getLead } from "./store/leads.js";
import { transcribe, voiceEnabled } from "./ai/transcribe.js";
import { correctTranscript } from "./ai/correct.js";
import { mountAdmin } from "./admin/routes.js";

const MAX_HISTORY = 40;

const app = express();
app.set("trust proxy", "loopback, uniquelocal"); // behind Caddy
app.use(express.json({ limit: "2mb" }));
app.get("/health", (_req, res) => res.json({ ok: true, provider: config.WHATSAPP_PROVIDER }));

const wa: WhatsAppClient =
  config.WHATSAPP_PROVIDER === "waha"
    ? new WahaClient(app, config.WAHA_URL, config.WAHA_API_KEY, config.WAHA_SESSION)
    : new BaileysClient(config.BAILEYS_AUTH_DIR);

/** Where alerts go: the manager's number if set, otherwise the store number's own "You" chat. */
async function alertChatId(): Promise<string | undefined> {
  const { adminPhone } = getSettings();
  return adminPhone ? wa.phoneToChatId(adminPhone) : wa.ownChatId().catch(() => undefined);
}

async function sendAlert(text: string): Promise<void> {
  const to = await alertChatId();
  if (!to) return console.warn("[alert] no manager number and WhatsApp not connected; alert only in logs");
  await wa.sendText(to, text).catch((err) => console.error("[alert] could not send", err));
}

async function notifyHuman(summary: string): Promise<void> {
  console.log(`[handoff] ${summary}`);
  await sendAlert(`🔔 ${summary}`);
}

const prettyPhone = (chatId: string) => {
  const d = chatId.split("@")[0] ?? "";
  return /^7\d{10}$/.test(d) ? `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : `+${d}`;
};

function askManagerFor(chatId: string, senderName?: string) {
  return async (question: string): Promise<number> => {
    const name = getLead(chatId)?.name ?? senderName;
    const q = createQuestion(chatId, name, question);
    console.log(`[question #${q.id}] ${name ?? ""} ${chatId}: ${question}`);
    const link = config.DOMAIN ? `\nОтветить: https://${config.DOMAIN}/admin/questions/${q.id}` : "";
    await sendAlert(
      `❓ Вопрос #${q.id}\nОт: ${name ?? "без имени"} ${prettyPhone(chatId)}\n«${question}»${link}`,
    );
    return q.id;
  };
}

// One message at a time per chat, so replies stay in order.
const queues = new Map<string, Promise<void>>();

async function handle(msg: IncomingMessage): Promise<void> {
  if (msg.voice) {
    const voice = msg.voice;
    if (!voiceEnabled()) {
      logMessage(msg.chatId, "in", "🎤 (голосовое сообщение)", msg.senderName);
      await wa.sendText(msg.chatId, "Кешіріңіз, дауыстық хабарламаны аша алмадым. Мәтінмен жазып жіберсеңіз 🙏");
      return;
    }
    await wa.setTyping(msg.chatId, true);
    try {
      const raw = await transcribe(await voice());
      const history = recentHistory(msg.chatId, 12).map((m) => ({
        role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
        text: m.text,
      }));
      const fixed = await correctTranscript(msg.chatId, raw, history);
      if (fixed !== raw) console.log(`[voice] corrected: ${fixed.slice(0, 80)}`);
      msg = { ...msg, text: `🎤 ${fixed || "(неразборчиво)"}`, rawText: raw, voice: undefined };
    } catch (err) {
      console.error("[voice] could not transcribe", err);
      logMessage(msg.chatId, "in", "🎤 (голосовое сообщение — не удалось распознать)", msg.senderName);
      await wa.setTyping(msg.chatId, false);
      await wa.sendText(msg.chatId, "Кешіріңіз, дауыстық хабарламаны ести алмадым. Мәтінмен жазып жіберсеңіз 🙏");
      return;
    }
  }

  logMessage(msg.chatId, "in", msg.text, msg.senderName, msg.rawText);

  if (msg.text.trim().toLowerCase() === "/reset") {
    resetHistory(msg.chatId);
    await wa.sendText(msg.chatId, "Conversation reset.");
    return;
  }

  if (!getSettings().botEnabled || getChat(msg.chatId)?.paused) return; // a human is handling it

  await wa.setTyping(msg.chatId, true);
  try {
    const history = recentHistory(msg.chatId, MAX_HISTORY).map((m) => ({
      role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
      text: m.text,
    }));
    const reply = await replyToCustomer(
      {
        chatId: msg.chatId,
        senderName: msg.senderName,
        notifyHuman,
        askManager: askManagerFor(msg.chatId, msg.senderName),
      },
      history,
    );
    if (reply) {
      await wa.sendText(msg.chatId, reply);
      logMessage(msg.chatId, "out", reply);
    }
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      console.warn("[claude] rate limited");
    } else if (err instanceof Anthropic.APIError) {
      console.error(`[claude] API error ${err.status}:`, err.message);
    } else {
      console.error("[bot] error", err);
    }
    await wa.sendText(msg.chatId, "Кешіріңіз, қазір техникалық ақау болып тұр. Сәл кейінірек қайта жазып көріңізші 🙏");
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

mountAdmin(app, wa, notifyHuman);
await wa.start(enqueue);
app.listen(config.PORT, () => {
  console.log(`Server listening on :${config.PORT} (WhatsApp via ${config.WHATSAPP_PROVIDER})`);
});
