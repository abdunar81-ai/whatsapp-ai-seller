export type Download = () => Promise<{ data: Buffer; mimetype: string }>;

export interface IncomingMessage {
  /** Chat id in WhatsApp JID form, e.g. 77011234567@s.whatsapp.net or 77011234567@c.us */
  chatId: string;
  /** Text of the message (or the caption); empty for a voice note. Media the bot can't read is a placeholder like "(стикер)". */
  text: string;
  /** Sent from the store's own number (a manager writing from the phone, or the bot's own message coming back). */
  fromMe?: boolean;
  senderName?: string;
  /** Voice notes: the recognizer's text before the AI correction. */
  rawText?: string;
  /** Present for voice notes: downloads the audio. */
  voice?: Download;
  /** Present for photos and PDF documents: downloads the file. */
  attachment?: Download;
}

/** What to log for media the bot can't open, by MIME type. */
export function mediaPlaceholder(mimetype: string | undefined): string {
  if (!mimetype) return "(вложение)";
  if (mimetype === "image/webp") return "(стикер)";
  if (mimetype.startsWith("video/")) return "(видео)";
  if (mimetype.startsWith("image/")) return "(фото)";
  return "(файл)";
}

/** Photos and PDFs are read by the AI; other media is only noted. */
export const canReadAttachment = (mimetype: string | undefined) =>
  Boolean(mimetype && (/^image\/(jpeg|png|gif)$/.test(mimetype) || mimetype === "application/pdf"));

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
  /** The linked number's own chat ("You" / message yourself), when connected. */
  ownChatId(): Promise<string | undefined>;

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
