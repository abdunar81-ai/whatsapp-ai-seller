import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db.js";
import { config } from "../config.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;
export type Model = (typeof MODELS)[number];
export type Effort = (typeof EFFORTS)[number];

export interface Settings {
  botEnabled: boolean;
  model: string;
  effort: Effort;
  paymentLink: string;
  adminPhone: string;
}

const defaults = (): Settings => ({
  botEnabled: true,
  model: config.CLAUDE_MODEL,
  effort: config.CLAUDE_EFFORT,
  paymentLink: config.KASPI_PAYMENT_LINK,
  adminPhone: config.ADMIN_PHONE,
});

export function getSettings(): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const s = defaults();
  for (const { key, value } of rows) {
    if (key in s) (s as unknown as Record<string, unknown>)[key] = JSON.parse(value);
  }
  return s;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  for (const key of Object.keys(current) as (keyof Settings)[]) {
    if (patch[key] !== undefined) stmt.run(key, JSON.stringify(patch[key]));
  }
  return getSettings();
}

export function readScript(): string {
  return readFileSync(config.SCRIPT_FILE, "utf8");
}

// Every save keeps the previous script here, so a bad edit can be undone.
const SCRIPT_HISTORY_DIR = "data/script-history";
const KEEP_SCRIPT_VERSIONS = 30;

export function writeScript(text: string): void {
  if (existsSync(config.SCRIPT_FILE)) {
    const previous = readFileSync(config.SCRIPT_FILE, "utf8");
    if (previous === text) return;
    mkdirSync(SCRIPT_HISTORY_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(SCRIPT_HISTORY_DIR, `script-${stamp}.md`), previous);
    for (const old of listScriptVersions().slice(KEEP_SCRIPT_VERSIONS)) {
      rmSync(join(SCRIPT_HISTORY_DIR, old.name));
    }
  }
  writeFileSync(config.SCRIPT_FILE, text);
}

/** Earlier versions of the script, newest first. */
export function listScriptVersions(): { name: string; savedAt: string }[] {
  if (!existsSync(SCRIPT_HISTORY_DIR)) return [];
  return readdirSync(SCRIPT_HISTORY_DIR)
    .filter((f) => /^script-[\dT-]+Z\.md$/.test(f))
    .sort()
    .reverse()
    .map((name) => {
      // script-2026-11-26T10-15-30-123Z.md -> 2026-11-26T10:15:30.123Z
      const m = name.match(/^script-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.md$/);
      return { name, savedAt: m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : "" };
    });
}

export function readScriptVersion(name: string): string {
  if (!listScriptVersions().some((v) => v.name === name)) throw new Error("Версия не найдена");
  return readFileSync(join(SCRIPT_HISTORY_DIR, name), "utf8");
}
