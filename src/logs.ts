import { format } from "node:util";

/** Keeps the last log lines in memory so the admin panel can show them. */
const MAX = 500;
const lines: string[] = [];

for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    lines.push(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${format(...args)}`);
    if (lines.length > MAX) lines.shift();
    original(...args);
  };
}

export const recentLogs = (): string[] => [...lines];
