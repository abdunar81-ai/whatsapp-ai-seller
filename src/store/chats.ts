import { db, now } from "../db.js";

export type Direction = "in" | "out" | "manual";

export interface ChatRow {
  chat_id: string;
  name: string | null;
  paused: number;
  history_from: string | null;
  created_at: string;
  last_message_at: string | null;
}

export interface MessageRow {
  id: number;
  chat_id: string;
  direction: Direction;
  text: string;
  /** Voice notes: what the recognizer heard before the AI correction. */
  raw_text: string | null;
  created_at: string;
}

const upsertChat = db.prepare(`
  INSERT INTO chats (chat_id, name, created_at, last_message_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (chat_id) DO UPDATE SET
    name = COALESCE(excluded.name, chats.name),
    last_message_at = excluded.last_message_at
`);
const insertMessage = db.prepare(
  "INSERT INTO messages (chat_id, direction, text, raw_text, created_at) VALUES (?, ?, ?, ?, ?)",
);

export function logMessage(chatId: string, direction: Direction, text: string, name?: string, rawText?: string): void {
  const t = now();
  upsertChat.run(chatId, name ?? null, t, t);
  insertMessage.run(chatId, direction, text, rawText ?? null, t);
}

export function getChat(chatId: string): ChatRow | undefined {
  return db.prepare("SELECT * FROM chats WHERE chat_id = ?").get(chatId) as ChatRow | undefined;
}

export function setPaused(chatId: string, paused: boolean): void {
  db.prepare("UPDATE chats SET paused = ? WHERE chat_id = ?").run(paused ? 1 : 0, chatId);
}

/** Start the bot's memory over for this chat (the message log is kept). */
export function resetHistory(chatId: string): void {
  db.prepare("UPDATE chats SET history_from = ? WHERE chat_id = ?").run(now(), chatId);
}

/** The most recent messages the bot should remember, oldest first. */
export function recentHistory(chatId: string, limit: number): MessageRow[] {
  const chat = getChat(chatId);
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE chat_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, chat?.history_from ?? "", limit) as unknown as MessageRow[];
  return rows.reverse();
}

export function listChats(): unknown[] {
  return db
    .prepare(
      `SELECT c.chat_id, c.name, c.paused, c.last_message_at,
              l.stage, json_extract(l.data, '$.name') AS lead_name,
              (SELECT text FROM messages m WHERE m.chat_id = c.chat_id ORDER BY id DESC LIMIT 1) AS last_text,
              (SELECT direction FROM messages m WHERE m.chat_id = c.chat_id ORDER BY id DESC LIMIT 1) AS last_direction,
              (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id) AS message_count
       FROM chats c LEFT JOIN leads l ON l.chat_id = c.chat_id
       ORDER BY c.last_message_at DESC LIMIT 500`,
    )
    .all();
}

export function chatMessages(chatId: string): MessageRow[] {
  return db
    .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 500")
    .all(chatId)
    .reverse() as unknown as MessageRow[];
}
