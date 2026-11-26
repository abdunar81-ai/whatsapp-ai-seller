import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

const COOKIE = "admin_session";
const TTL_MS = 7 * 24 * 3600 * 1000;
const secret = config.SESSION_SECRET || randomBytes(32).toString("hex"); // random = log out on restart

const sign = (value: string) => createHmac("sha256", secret).update(value).digest("hex");

function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function readCookie(req: Request): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function isAuthed(req: Request): boolean {
  const token = readCookie(req);
  if (!token) return false;
  const [expires, sig] = token.split(".");
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  return safeEqual(sig, sign(expires));
}

// Simple brute-force brake: per-IP failures within 15 minutes.
const failures = new Map<string, { count: number; until: number }>();

export function login(req: Request, res: Response): void {
  for (const [key, v] of failures) if (v.until <= Date.now()) failures.delete(key);
  const ip = req.ip ?? "?";
  const f = failures.get(ip);
  if (f && f.until > Date.now() && f.count >= 5) {
    res.status(429).json({ error: "Слишком много попыток. Попробуйте через 15 минут." });
    return;
  }
  const password = String(req.body?.password ?? "");
  if (!config.ADMIN_PASSWORD || !safeEqual(password, config.ADMIN_PASSWORD)) {
    failures.set(ip, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60_000 });
    setTimeout(() => res.status(401).json({ error: "Неверный пароль" }), 800);
    return;
  }
  failures.delete(ip);
  const expires = String(Date.now() + TTL_MS);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${expires}.${sign(expires)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${TTL_MS / 1000}` +
      (req.secure ? "; Secure" : ""),
  );
  res.json({ ok: true });
}

export function logout(_req: Request, res: Response): void {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "Требуется вход" });
}
