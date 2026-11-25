export interface IncomingMessage {
  /** Chat id in WhatsApp JID form, e.g. 15551234567@s.whatsapp.net or 15551234567@c.us */
  chatId: string;
  text: string;
  senderName?: string;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface WhatsAppClient {
  start(onMessage: MessageHandler): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  /** Show "typing..." while the bot thinks (best effort). */
  setTyping(chatId: string, typing: boolean): Promise<void>;
  /** Build a chat id for a plain phone number (digits only). */
  phoneToChatId(phone: string): string;
}
