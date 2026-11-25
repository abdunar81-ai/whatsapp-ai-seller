import type { Express, Request, Response } from "express";
import type { ConnectionStatus, MessageHandler, WhatsAppClient, WhatsAppStatus } from "./types.js";

/**
 * Talks to a WAHA container (https://waha.devlike.pro). WAHA holds the
 * WhatsApp session and POSTs "message" events to /webhooks/waha
 * (WHATSAPP_HOOK_URL in docker-compose.yml).
 */
export class WahaClient implements WhatsAppClient {
  constructor(
    private app: Express,
    private baseUrl: string,
    private apiKey: string,
    private session: string,
  ) {}

  async start(onMessage: MessageHandler): Promise<void> {
    this.app.post("/webhooks/waha", (req: Request, res: Response) => {
      // Ack immediately; WAHA retries slow webhooks.
      res.sendStatus(200);
      const { event, payload } = req.body ?? {};
      if (event !== "message" || !payload || payload.fromMe) return;
      const chatId: string = payload.from;
      if (!chatId || chatId.endsWith("@g.us") || chatId === "status@broadcast") return;
      const text: string = payload.body ?? "";
      const media = payload.media as { url?: string; mimetype?: string; error?: unknown } | undefined;
      const isAudio = Boolean(payload.hasMedia && media?.mimetype?.startsWith("audio/"));
      if (!text && !isAudio) return; // stickers, images without caption, etc.
      onMessage({
        chatId,
        text: isAudio ? "" : text,
        senderName: payload._data?.notifyName ?? payload._data?.pushName,
        voice: isAudio ? () => this.download(media!) : undefined,
      }).catch((err) => console.error("[waha] handler error", err));
    });
    console.log(`[waha] webhook ready at /webhooks/waha (session "${this.session}")`);
  }

  /** Fetch a media file WAHA saved; its URL may name WAHA's own host, so use ours. */
  private async download(media: { url?: string; mimetype?: string; error?: unknown }) {
    if (!media.url) throw new Error(`WAHA did not provide the file: ${JSON.stringify(media.error ?? "no url")}`);
    const u = new URL(media.url);
    const res = await fetch(`${this.baseUrl}${u.pathname}${u.search}`, {
      headers: this.apiKey ? { "X-Api-Key": this.apiKey } : {},
    });
    if (!res.ok) throw new Error(`WAHA file download failed: ${res.status}`);
    return { data: Buffer.from(await res.arrayBuffer()), mimetype: media.mimetype ?? "audio/ogg" };
  }

  async ownChatId(): Promise<string | undefined> {
    const s = await this.getStatus();
    return s.status === "CONNECTED" && s.me?.id ? s.me.id : undefined;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<globalThis.Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.apiKey ? { "X-Api-Key": this.apiKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  private async post(path: string, body?: unknown): Promise<unknown> {
    const res = await this.call("POST", path, body);
    if (!res.ok) throw new Error(`WAHA ${path} failed: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.post("/api/sendText", { session: this.session, chatId, text });
  }

  async setTyping(chatId: string, typing: boolean): Promise<void> {
    await this.post(typing ? "/api/startTyping" : "/api/stopTyping", {
      session: this.session,
      chatId,
    }).catch(() => {});
  }

  phoneToChatId(phone: string): string {
    return `${phone.replace(/\D/g, "")}@c.us`;
  }

  async getStatus(): Promise<WhatsAppStatus> {
    let res: globalThis.Response;
    try {
      res = await this.call("GET", `/api/sessions/${this.session}`);
    } catch (err) {
      return { status: "FAILED", detail: `WAHA unreachable: ${(err as Error).message}` };
    }
    if (res.status === 404) return { status: "STOPPED", detail: "Session not created yet" };
    if (!res.ok) return { status: "FAILED", detail: `WAHA ${res.status}` };
    const s = (await res.json()) as { status: string; me?: { id?: string; pushName?: string } };
    const map: Record<string, ConnectionStatus> = {
      WORKING: "CONNECTED",
      SCAN_QR_CODE: "SCAN_QR_CODE",
      STARTING: "STARTING",
      STOPPED: "STOPPED",
      FAILED: "FAILED",
    };
    return { status: map[s.status] ?? "UNKNOWN", me: s.me ?? undefined, detail: s.status };
  }

  async connect(): Promise<void> {
    const res = await this.call("GET", `/api/sessions/${this.session}`);
    if (res.status === 404) {
      await this.post("/api/sessions", { name: this.session, start: true });
      return;
    }
    const { status } = (await res.json()) as { status: string };
    if (status === "STOPPED" || status === "FAILED") {
      await this.post(`/api/sessions/${this.session}/start`);
    }
  }

  async getQr(): Promise<string | undefined> {
    const res = await this.call("GET", `/api/${this.session}/auth/qr?format=image`);
    if (!res.ok) return undefined;
    const type = res.headers.get("content-type") ?? "";
    if (type.startsWith("image/")) {
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      return `data:${type};base64,${b64}`;
    }
    const json = (await res.json()) as { mimetype?: string; data?: string };
    return json.data ? `data:${json.mimetype ?? "image/png"};base64,${json.data}` : undefined;
  }

  async requestPairingCode(phone: string): Promise<string> {
    const json = (await this.post(`/api/${this.session}/auth/request-code`, {
      phoneNumber: phone.replace(/\D/g, ""),
    })) as { code?: string };
    if (!json?.code) throw new Error("WAHA did not return a code");
    return json.code;
  }

  async logout(): Promise<void> {
    await this.post(`/api/sessions/${this.session}/logout`);
  }

  async restart(): Promise<void> {
    await this.post(`/api/sessions/${this.session}/restart`);
  }
}
