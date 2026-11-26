import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.js";

// A copy of the database every day, kept for two weeks (in data/backups on the server).
const DIR = "data/backups";
const KEEP_DAYS = 14;

function backupToday(): void {
  const day = new Date().toISOString().slice(0, 10);
  const file = join(DIR, `bot-${day}.db`);
  if (existsSync(file)) return;
  mkdirSync(DIR, { recursive: true });
  db.exec(`VACUUM INTO '${file}'`); // a consistent copy, safe while the bot is running
  const old = readdirSync(DIR).filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(KEEP_DAYS);
  for (const f of old) rmSync(join(DIR, f));
  console.log(`[backup] saved ${file}`);
}

export function startDailyBackups(): void {
  const run = () => {
    try {
      backupToday();
    } catch (err) {
      console.error("[backup] failed", err);
    }
  };
  run();
  setInterval(run, 60 * 60 * 1000).unref(); // checks hourly, writes once a day
}
