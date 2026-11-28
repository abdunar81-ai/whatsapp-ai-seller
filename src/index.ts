import "./logs.js";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { replyToCustomer } from "./ai/seller.js";
import { BaileysClient } from "./whatsapp/baileys.js";
import { WahaClient } from "./whatsapp/waha.js";
import type { IncomingMessage, WhatsAppClient } from "./whatsapp/types.js";
import { getChat, logMessage, managerWroteSince, recentHistory, setPaused, unansweredChats } from "./store/chats.js";
import { getSettings } from "./store/settings.js";
import { createQuestion, openQuestionsFor } from "./store/questions.js";
import { getLead } from "./store/leads.js";
import { transcribe, voiceEnabled } from "./ai/transcribe.js";
import { correctTranscript } from "./ai/correct.js";
import { describeAttachment } from "./ai/attachment.js";
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

// Messages sent from the store's number come back to us like a manager writing from the phone.
// Remember what we sent (bot replies, panel messages, alerts) so those echoes are not taken for one.
const ECHO_WINDOW_MS = 5 * 60 * 1000;
const sentTexts = new Map<string, { text: string; at: number }[]>();
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
{
  const send = wa.sendText.bind(wa);
  wa.sendText = async (chatId, text) => {
    const list = (sentTexts.get(chatId) ?? []).filter((s) => Date.now() - s.at < ECHO_WINDOW_MS);
    list.push({ text: norm(text), at: Date.now() });
    sentTexts.set(chatId, list);
    await send(chatId, text);
  };
}
// Kept for the whole window (not removed on the first match): a duplicate echo must not pause the bot.
const isEcho = (chatId: string, text: string) =>
  (sentTexts.get(chatId) ?? []).some((s) => s.text === norm(text) && Date.now() - s.at < ECHO_WINDOW_MS);

/** Send a fixed message to a customer and keep it in the history. */
async function sendLogged(chatId: string, text: string): Promise<void> {
  await sendWithRetry(chatId, text);
  logMessage(chatId, "out", text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send to a customer, retrying for a moment if WhatsApp is briefly unavailable. */
async function sendWithRetry(chatId: string, text: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await wa.sendText(chatId, text);
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`[bot] send to ${chatId} failed (attempt ${attempt}), retrying`, err);
      await sleep(attempt * 3000);
    }
  }
}

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

const chatLink = (chatId: string) =>
  config.DOMAIN ? `\nЧат: https://${config.DOMAIN}/admin/chats/${encodeURIComponent(chatId).replace(/%40/g, "@")}` : "";

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

// After the bot hands a chat to a manager it stays quiet, but not forever: if no manager has written
// this long after the handoff, the bot answers the customer again (and tells the manager).
const HANDOFF_WAIT_MS = 30 * 60 * 1000;

/** Whether the bot may answer in this chat now; resumes a handoff the manager didn't pick up. */
async function botMayReply(chatId: string): Promise<boolean> {
  if (!getSettings().botEnabled) return false;
  const chat = getChat(chatId);
  if (!chat?.paused) return true;
  if (chat.paused_reason !== "handoff" || !chat.paused_at) return false; // a manager took over
  if (Date.now() - Date.parse(chat.paused_at) < HANDOFF_WAIT_MS) return false;
  if (managerWroteSince(chatId, chat.paused_at)) {
    setPaused(chatId, true, "manager"); // the manager is on it
    return false;
  }
  setPaused(chatId, false);
  console.log(`[bot] no manager reply in ${chatId} since the handoff; the bot answers again`);
  await sendAlert(
    `⏰ Менеджер не ответил ${HANDOFF_WAIT_MS / 60000} мин — бот снова отвечает клиенту ` +
      `${getLead(chatId)?.name ?? chat.name ?? ""} ${prettyPhone(chatId)}. ` +
      `Чтобы взять диалог, напишите клиенту или поставьте бота на паузу.${chatLink(chatId)}`,
  );
  return true;
}

// A customer writing in a paused chat: tell the manager (not on every message), so nobody is left unanswered.
const PAUSED_ALERT_EVERY_MS = 15 * 60 * 1000;
const pausedAlerts = new Map<string, number>();

async function alertPausedChat(chatId: string, text: string, senderName?: string): Promise<void> {
  if (Date.now() - (pausedAlerts.get(chatId) ?? 0) < PAUSED_ALERT_EVERY_MS) return;
  pausedAlerts.set(chatId, Date.now());
  const chat = getChat(chatId);
  const name = getLead(chatId)?.name ?? senderName ?? chat?.name ?? "";
  const resume =
    chat?.paused_reason === "handoff"
      ? `Если менеджер не напишет, бот ответит сам через ${HANDOFF_WAIT_MS / 60000} мин после передачи.`
      : "Бот на паузе в этом чате.";
  await sendAlert(`💬 Клиент ждёт ответа: ${name} ${prettyPhone(chatId)}\n«${text.slice(0, 300)}»\n${resume}${chatLink(chatId)}`);
}

/** Save an incoming message (voice notes are transcribed, photos described), then schedule the reply. */
async function ingest(msg: IncomingMessage): Promise<void> {
  if (await isStaffChat(msg.chatId)) {
    if (!msg.fromMe) console.log(`[bot] ignoring message from staff chat ${msg.chatId}`);
    return;
  }

  if (msg.fromMe) {
    if (isEcho(msg.chatId, msg.text)) return;
    // A manager wrote from the phone: they are handling this chat now.
    logMessage(msg.chatId, "manual", msg.text || "🎤 (голосовое сообщение)");
    clearTimeout(replyTimers.get(msg.chatId));
    replyTimers.delete(msg.chatId);
    if (!getChat(msg.chatId)?.paused || getChat(msg.chatId)?.paused_reason === "handoff") {
      setPaused(msg.chatId, true, "manager");
      console.log(`[bot] a manager wrote in ${msg.chatId} from the phone; the bot is paused there`);
    }
    return;
  }

  if (msg.voice) {
    const voice = msg.voice;
    if (!voiceEnabled()) {
      logMessage(msg.chatId, "in", "🎤 (голосовое сообщение)", msg.senderName);
      await sendLogged(msg.chatId, "Кешіріңіз, дауыстық хабарламаны аша алмадым. Мәтінмен жазып жіберсеңіз 🙏");
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
      await sendLogged(msg.chatId, "Кешіріңіз, дауыстық хабарламаны ести алмадым. Мәтінмен жазып жіберсеңіз 🙏");
      return;
    }
  }

  if (msg.attachment) {
    const caption = msg.text;
    try {
      const description = await describeAttachment(msg.chatId, await msg.attachment());
      console.log(`[media] ${msg.chatId}: ${description.slice(0, 80)}`);
      msg = { ...msg, text: [`📷 ${description || "(фото)"}`, caption].filter(Boolean).join("\n"), attachment: undefined };
    } catch (err) {
      console.error("[media] could not read the file", err);
      msg = { ...msg, text: ["(фото)", caption].filter(Boolean).join(" "), attachment: undefined };
    }
  }

  logMessage(msg.chatId, "in", msg.text, msg.senderName, msg.rawText);
  failures.delete(msg.chatId);
  if (await botMayReply(msg.chatId)) {
    scheduleReply(msg.chatId, msg.senderName);
  } else if (getSettings().botEnabled) {
    await alertPausedChat(msg.chatId, msg.text, msg.senderName);
  }
}

const replyTimers = new Map<string, NodeJS.Timeout>();

function scheduleReply(chatId: string, senderName?: string, delay = REPLY_DELAY_MS): void {
  clearTimeout(replyTimers.get(chatId));
  replyTimers.set(
    chatId,
    setTimeout(() => {
      replyTimers.delete(chatId);
      void runInChatQueue(chatId, () => reply(chatId, senderName));
    }, delay),
  );
}

// Replies that failed (AI or WhatsApp errors) are retried a few times before the customer gets an apology.
const MAX_ATTEMPTS = 3;
const failures = new Map<string, number>();

/** Answer everything the student has written so far (history includes all their new messages). */
async function reply(chatId: string, senderName?: string): Promise<void> {
  if (!(await botMayReply(chatId))) return; // a human is handling it
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
      await sendWithRetry(chatId, text);
      logMessage(chatId, "out", text);
    }
    failures.delete(chatId);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      console.warn("[claude] rate limited");
    } else if (err instanceof Anthropic.APIError) {
      console.error(`[claude] API error ${err.status}:`, err.message);
    } else {
      console.error("[bot] error", err);
    }
    const attempts = (failures.get(chatId) ?? 0) + 1;
    failures.set(chatId, attempts);
    if (attempts < MAX_ATTEMPTS) {
      console.warn(`[bot] reply to ${chatId} failed (attempt ${attempts}); trying again in ${attempts} min`);
      scheduleReply(chatId, senderName, attempts * 60_000);
    } else {
      console.error(`[bot] giving up on ${chatId} after ${attempts} attempts`);
      await notifyHuman(`Бот не смог ответить клиенту ${prettyPhone(chatId)} (техническая ошибка). Ответьте вручную.${chatLink(chatId)}`);
      await sendLogged(chatId, "Кешіріңіз, қазір техникалық ақау болып тұр. Менеджер жақын арада жауап береді 🙏").catch(
        (e) => console.error("[bot] could not send the error message", e),
      );
    }
  } finally {
    await wa.setTyping(chatId, false);
  }
}

function enqueue(msg: IncomingMessage): Promise<void> {
  return runInChatQueue(msg.chatId, () => ingest(msg));
}

// Catch-up: answer customers whose last message got no reply (the bot was restarted or offline,
// WhatsApp was reconnecting, ...). Only recent messages: a reply days late would look odd.
const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
const CATCH_UP_EVERY_MS = 5 * 60 * 1000;

async function catchUp(): Promise<void> {
  if (!getSettings().botEnabled) return;
  if ((await wa.getStatus().catch(() => undefined))?.status !== "CONNECTED") return;
  const since = new Date(Date.now() - CATCH_UP_WINDOW_MS).toISOString();
  const settled = new Date(Date.now() - 60_000).toISOString(); // leave fresh messages to the normal flow
  for (const c of unansweredChats(since)) {
    if (c.last_at > settled || replyTimers.has(c.chat_id) || queues.has(c.chat_id)) continue;
    if ((failures.get(c.chat_id) ?? 0) >= MAX_ATTEMPTS) continue; // the manager was told
    if (await isStaffChat(c.chat_id)) continue;
    if (!(await botMayReply(c.chat_id))) continue;
    console.log(`[catch-up] answering ${c.chat_id} (last message ${c.last_at})`);
    scheduleReply(c.chat_id, c.name ?? undefined, 1000);
  }
}

startDailyBackups();
mountAdmin(app, wa, notifyHuman);
await wa.start(enqueue);
setTimeout(() => {
  const run = () => catchUp().catch((err) => console.error("[catch-up] failed", err));
  void run();
  setInterval(run, CATCH_UP_EVERY_MS);
}, 30_000);
app.listen(config.PORT, () => {
  console.log(`Server listening on :${config.PORT} (WhatsApp via ${config.WHATSAPP_PROVIDER})`);
});
