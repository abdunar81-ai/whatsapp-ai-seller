import { readFileSync, writeFileSync } from "node:fs";
import { db } from "../db.js";
import { config } from "../config.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Settings {
  botEnabled: boolean;
  effort: Effort;
  paymentLink: string;
  adminPhone: string;
}

const defaults = (): Settings => ({
  botEnabled: true,
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

export function writeScript(text: string): void {
  writeFileSync(config.SCRIPT_FILE, text);
}
