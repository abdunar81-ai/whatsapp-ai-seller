export interface IncomingMessage {
  /** Chat id in WhatsApp JID form, e.g. 77011234567@s.whatsapp.net or 77011234567@c.us */
  chatId: string;
  text: string;
  senderName?: string;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export type ConnectionStatus =
  | "CONNECTED"
  | "SCAN_QR_CODE"
  | "STARTING"
  | "STOPPED"
  | "FAILED"
  | "UNKNOWN";

export interface WhatsAppStatus {
  status: ConnectionStatus;
  /** Linked phone number / name when connected. */
  me?: { id?: string; pushName?: string };
  detail?: string;
}

export interface WhatsAppClient {
  start(onMessage: MessageHandler): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  /** Show "typing..." while the bot thinks (best effort). */
  setTyping(chatId: string, typing: boolean): Promise<void>;
  /** Build a chat id for a plain phone number (digits only). */
  phoneToChatId(phone: string): string;

  // --- connection management (admin panel) ---
  getStatus(): Promise<WhatsAppStatus>;
  /** Start (or create) the WhatsApp session so a QR code appears. */
  connect(): Promise<void>;
  /** QR code as a PNG data URL, when status is SCAN_QR_CODE. */
  getQr(): Promise<string | undefined>;
  /** Link by code instead of QR: returns the code to type on the phone. */
  requestPairingCode(phone: string): Promise<string>;
  logout(): Promise<void>;
  restart(): Promise<void>;
}
