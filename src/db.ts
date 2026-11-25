import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

mkdirSync("data", { recursive: true });
export const db = new DatabaseSync("data/bot.db");

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY,
  name TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  history_from TEXT,
  created_at TEXT NOT NULL,
  last_message_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'manual')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, id);
CREATE INDEX IF NOT EXISTS messages_time ON messages (created_at);
CREATE TABLE IF NOT EXISTS leads (
  chat_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_time ON usage (created_at);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  customer_name TEXT,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dismissed')),
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS questions_status ON questions (status, id);
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Columns added after the first release.
const messageCols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
if (!messageCols.includes("raw_text")) db.exec("ALTER TABLE messages ADD COLUMN raw_text TEXT");

export const now = () => new Date().toISOString();
