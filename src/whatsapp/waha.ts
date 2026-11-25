import type { Express, Request, Response } from "express";
import type { MessageHandler, WhatsAppClient } from "./types.js";

/**
 * Talks to a WAHA container (https://waha.devlike.pro). WAHA holds the
 * WhatsApp session; configure its webhook to POST "message" events to
 * http://<this-server>/webhooks/waha.
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
      const text: string | undefined = payload.body;
      if (!text) return;
      onMessage({
        chatId,
        text,
        senderName: payload._data?.notifyName ?? payload._data?.pushName,
      }).catch((err) =>
        console.error("[waha] handler error", err),
      );
    });
    console.log(`[waha] webhook ready at /webhooks/waha (session "${this.session}")`);
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { "X-Api-Key": this.apiKey } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`WAHA ${path} failed: ${res.status} ${await res.text()}`);
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
}
