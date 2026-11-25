import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from "baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import type { MessageHandler, WhatsAppClient } from "./types.js";

/**
 * Runs WhatsApp Web inside this Node process. On first start it prints a QR
 * code in the server logs: scan it from the phone (Linked devices) and the
 * session is saved to BAILEYS_AUTH_DIR so restarts don't need a new scan.
 */
export class BaileysClient implements WhatsAppClient {
  private sock?: WASocket;

  constructor(private authDir: string) {}

  async start(onMessage: MessageHandler): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "warn" }),
      markOnlineOnConnect: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log("[baileys] Scan this QR with WhatsApp > Linked devices:");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") console.log("[baileys] connected");
      if (connection === "close") {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.error(`[baileys] logged out. Delete "${this.authDir}" and restart to re-link.`);
          return;
        }
        console.warn(`[baileys] connection closed (${code ?? "unknown"}), reconnecting...`);
        void this.start(onMessage);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        const chatId = m.key.remoteJid;
        if (!chatId || m.key.fromMe) continue;
        // Only 1:1 chats; skip groups, broadcasts and status updates.
        if (chatId.endsWith("@g.us") || chatId.endsWith("@broadcast") || chatId.endsWith("@newsletter")) continue;

        const text =
          m.message?.conversation ??
          m.message?.extendedTextMessage?.text ??
          m.message?.imageMessage?.caption ??
          m.message?.videoMessage?.caption;
        if (!text) continue;

        try {
          await sock.readMessages([m.key]);
          await onMessage({ chatId, text, senderName: m.pushName ?? undefined });
        } catch (err) {
          console.error("[baileys] handler error", err);
        }
      }
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("Baileys not started");
    await this.sock.sendMessage(chatId, { text });
  }

  async setTyping(chatId: string, typing: boolean): Promise<void> {
    await this.sock?.sendPresenceUpdate(typing ? "composing" : "paused", chatId).catch(() => {});
  }

  phoneToChatId(phone: string): string {
    return `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
  }
}
