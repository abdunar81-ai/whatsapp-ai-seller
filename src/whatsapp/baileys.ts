import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WASocket,
} from "baileys";
import { rm } from "node:fs/promises";
import QRCode from "qrcode";
import pino from "pino";
import {
  canReadAttachment,
  mediaPlaceholder,
  type Download,
  type MessageHandler,
  type WhatsAppClient,
  type WhatsAppStatus,
} from "./types.js";

/**
 * Runs WhatsApp Web inside this Node process. The QR code is shown in the
 * admin panel (and logs); the session is saved to BAILEYS_AUTH_DIR.
 */
export class BaileysClient implements WhatsAppClient {
  private sock?: WASocket;
  private onMessage?: MessageHandler;
  private qr?: string;
  private state: WhatsAppStatus = { status: "STOPPED" };

  constructor(private authDir: string) {}

  async start(onMessage: MessageHandler): Promise<void> {
    this.onMessage = onMessage;
    await this.open();
  }

  private async open(): Promise<void> {
    this.state = { status: "STARTING" };
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
        this.qr = qr;
        this.state = { status: "SCAN_QR_CODE" };
        console.log("[baileys] waiting for QR scan (open the admin panel)");
      }
      if (connection === "open") {
        this.qr = undefined;
        this.state = { status: "CONNECTED", me: { id: sock.user?.id, pushName: sock.user?.name } };
        console.log("[baileys] connected");
      }
      if (connection === "close") {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          this.state = { status: "STOPPED", detail: "Logged out" };
          console.error("[baileys] logged out; use Connect in the admin panel to link again.");
          return;
        }
        console.warn(`[baileys] connection closed (${code ?? "unknown"}), reconnecting...`);
        void this.open();
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        const chatId = m.key.remoteJid;
        if (!chatId) continue;
        if (chatId.endsWith("@g.us") || chatId.endsWith("@broadcast") || chatId.endsWith("@newsletter")) continue;
        const fromMe = Boolean(m.key.fromMe);

        // Disappearing, view-once and edited messages wrap the real content.
        const content = normalizeMessageContent(m.message);
        const caption =
          content?.conversation ??
          content?.extendedTextMessage?.text ??
          content?.imageMessage?.caption ??
          content?.videoMessage?.caption ??
          content?.documentMessage?.caption ??
          "";
        const audio = content?.audioMessage;
        const file = content?.imageMessage ?? content?.documentMessage ?? content?.stickerMessage ?? content?.videoMessage;
        if (!caption && !audio && !file) continue; // reactions, locations, etc.

        const download = (mimetype: string): Download => async () => ({
          data: (await downloadMediaMessage(m, "buffer", {})) as Buffer,
          mimetype,
        });
        const mimetype = content?.stickerMessage ? "image/webp" : (file?.mimetype ?? undefined);
        const readable = Boolean(file && !content?.stickerMessage && canReadAttachment(mimetype ?? undefined));
        const text = audio ? "" : file && !readable ? [mediaPlaceholder(mimetype), caption].filter(Boolean).join(" ") : caption;

        if (fromMe) {
          await this.onMessage?.({ chatId, text, fromMe }).catch((err) => console.error("[baileys] handler error", err));
          continue;
        }

        try {
          await sock.readMessages([m.key]);
          await this.onMessage?.({
            chatId,
            text,
            senderName: m.pushName ?? undefined,
            voice: audio ? download(audio.mimetype ?? "audio/ogg") : undefined,
            attachment: readable ? download(mimetype!) : undefined,
          });
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

  async ownChatId(): Promise<string | undefined> {
    const id = this.sock?.user?.id;
    return id ? id.replace(/:\d+@/, "@") : undefined;
  }

  async getStatus(): Promise<WhatsAppStatus> {
    return this.state;
  }

  async connect(): Promise<void> {
    if (this.state.status === "STOPPED" || this.state.status === "FAILED") await this.open();
  }

  async getQr(): Promise<string | undefined> {
    return this.qr ? QRCode.toDataURL(this.qr, { margin: 1, width: 320 }) : undefined;
  }

  async requestPairingCode(phone: string): Promise<string> {
    if (!this.sock) throw new Error("Baileys not started");
    return this.sock.requestPairingCode(phone.replace(/\D/g, ""));
  }

  async logout(): Promise<void> {
    await this.sock?.logout().catch(() => {});
    await rm(this.authDir, { recursive: true, force: true });
    this.state = { status: "STOPPED", detail: "Logged out" };
  }

  async restart(): Promise<void> {
    this.sock?.end(undefined);
  }
}
