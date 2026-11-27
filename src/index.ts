import "./logs.js";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { replyToCustomer } from "./ai/seller.js";
import { BaileysClient } from "./whatsapp/baileys.js";
import { WahaClient } from "./whatsapp/waha.js";
import type { IncomingMessage, WhatsAppClient } from "./whatsapp/types.js";
import { getChat, logMessage, recentHistory } from "./store/chats.js";
import { getSettings } from "./store/settings.js";
import { createQuestion, openQuestionsFor } from "./store/questions.js";
import { getLead } from "./store/leads.js";
import { transcribe, voiceEnabled } from "./ai/transcribe.js";
import { correctTranscript } from "./ai/correct.js";
import { mountAdmin } from "./admin/routes.js";
import { startDailyBackups } from "./backup.js";

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
  const [d = "", domain] = chatId.split("@");
  if (domain === "lid") return `(WhatsApp ID ${d}, номер скрыт)`;
  return /^7\d{10}$/.test(d) ? `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : `+${d}`;
};

/** Words of a question, for spotting the same question asked twice. */
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );

function sameQuestion(a: string, b: string): boolean {
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return a.trim() === b.trim();
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size) >= 0.7;
}

function askManagerFor(chatId: string, senderName?: string) {
  return async (question: string): Promise<{ id: number; duplicate: boolean }> => {
    // The student repeating a question must not ping the managers again.
    const existing = openQuestionsFor(chatId).find((q) => sameQuestion(q.question, question));
    if (existing) {
      console.log(`[question #${existing.id}] asked again in ${chatId}; not re-sent`);
      return { id: existing.id, duplicate: true };
    }
    const name = getLead(chatId)?.name ?? senderName;
    const q = createQuestion(chatId, name, question);
    console.log(`[question #${q.id}] ${name ?? ""} ${chatId}: ${question}`);
    const link = config.DOMAIN ? `\nОтветить: https://${config.DOMAIN}/admin/questions/${q.id}` : "";
    await sendAlert(
      `❓ Вопрос #${q.id}\nОт: ${name ?? "без имени"} ${prettyPhone(chatId)}\n«${question}»${link}`,
    );
    return { id: q.id, duplicate: false };
  };
}

// Students often send several short messages in a row: wait this long after the
// last one and answer them together.
const REPLY_DELAY_MS = 6000;

const digits = (chatId: string) => (chatId.split("@")[0] ?? "").replace(/\D/g, "");

/** The manager's number and the store's own chat get alerts; the bot must never sell to them. */
async function isStaffChat(chatId: string): Promise<boolean> {
  if (!chatId.endsWith("@c.us") && !chatId.endsWith("@s.whatsapp.net")) return false;
  const { adminPhone } = getSettings();
  if (adminPhone && digits(chatId) === adminPhone) return true;
  const own = await wa.ownChatId().catch(() => undefined);
  return Boolean(own && digits(own) === digits(chatId));
}

// One job at a time per chat, so messages are saved and answered in order.
// A failed job must not block the jobs queued behind it.
const queues = new Map<string, Promise<void>>();

function runInChatQueue(chatId: string, job: () => Promise<void>): Promise<void> {
  const prev = queues.get(chatId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(job);
  const tracked = next.catch((err) => console.error(`[bot] job failed in ${chatId}`, err));
  queues.set(chatId, tracked);
  void tracked.finally(() => {
    if (queues.get(chatId) === tracked) queues.delete(chatId);
  });
  return tracked;
}

/** Save an incoming message (voice notes are transcribed first), then schedule the reply. */
async function ingest(msg: IncomingMessage): Promise<void> {
  if (await isStaffChat(msg.chatId)) {
    console.log(`[bot] ignoring message from staff chat ${msg.chatId}`);
    return;
  }

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
  scheduleReply(msg.chatId, msg.senderName);
}

const replyTimers = new Map<string, NodeJS.Timeout>();

function scheduleReply(chatId: string, senderName?: string): void {
  clearTimeout(replyTimers.get(chatId));
  replyTimers.set(
    chatId,
    setTimeout(() => {
      replyTimers.delete(chatId);
      void runInChatQueue(chatId, () => reply(chatId, senderName));
    }, REPLY_DELAY_MS),
  );
}

/** Answer everything the student has written so far (history includes all their new messages). */
async function reply(chatId: string, senderName?: string): Promise<void> {
  if (!getSettings().botEnabled || getChat(chatId)?.paused) return; // a human is handling it
  const history = recentHistory(chatId, MAX_HISTORY).map((m) => ({
    role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
    text: m.text,
  }));
  if (history.at(-1)?.role !== "user") return; // already answered (e.g. by a manager)

  await wa.setTyping(chatId, true);
  try {
    const text = await replyToCustomer(
      { chatId, senderName, notifyHuman, askManager: askManagerFor(chatId, senderName) },
      history,
    );
    if (text) {
      await wa.sendText(chatId, text);
      logMessage(chatId, "out", text);
    }
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      console.warn("[claude] rate limited");
    } else if (err instanceof Anthropic.APIError) {
      console.error(`[claude] API error ${err.status}:`, err.message);
    } else {
      console.error("[bot] error", err);
    }
    await wa
      .sendText(chatId, "Кешіріңіз, қазір техникалық ақау болып тұр. Сәл кейінірек қайта жазып көріңізші 🙏")
      .catch((e) => console.error("[bot] could not send the error message", e));
  } finally {
    await wa.setTyping(chatId, false);
  }
}

function enqueue(msg: IncomingMessage): Promise<void> {
  return runInChatQueue(msg.chatId, () => ingest(msg));
}

startDailyBackups();
mountAdmin(app, wa, notifyHuman);
await wa.start(enqueue);
app.listen(config.PORT, () => {
  console.log(`Server listening on :${config.PORT} (WhatsApp via ${config.WHATSAPP_PROVIDER})`);
});
