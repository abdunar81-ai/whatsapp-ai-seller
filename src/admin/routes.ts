import express, { type Express, type Request, type Response } from "express";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { config } from "../config.js";
import { db } from "../db.js";
import { recentLogs } from "../logs.js";
import { replyToCustomer, type Turn } from "../ai/seller.js";
import { chatMessages, getChat, listChats, logMessage, resetHistory, setPaused } from "../store/chats.js";
import { LEAD_STAGES, listLeads, upsertLead, type LeadStage } from "../store/leads.js";
import { EFFORTS, getSettings, readScript, updateSettings, writeScript, type Effort } from "../store/settings.js";
import type { WhatsAppClient } from "../whatsapp/types.js";
import { login, logout, requireAuth, isAuthed } from "./auth.js";

const startedAt = Date.now();

/** Wraps async handlers so errors become JSON 500s instead of crashing. */
const h =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      console.error("[admin]", err);
      if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
    }
  };

function stats() {
  const tz = `${config.TZ_OFFSET_HOURS >= 0 ? "+" : ""}${config.TZ_OFFSET_HOURS} hours`;
  const today = db.prepare(`SELECT date('now', ?) AS d`).get(tz) as { d: string };
  const one = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as T;

  const since = (days: number) => `date(created_at, '${tz}') > date('now', '${tz}', '-${days} days')`;

  const totals = {
    chats: one<{ n: number }>("SELECT COUNT(*) n FROM chats").n,
    leads: one<{ n: number }>("SELECT COUNT(*) n FROM leads").n,
    messagesToday: one<{ n: number }>(`SELECT COUNT(*) n FROM messages WHERE direction='in' AND ${since(1)}`).n,
    newChatsToday: one<{ n: number }>(`SELECT COUNT(*) n FROM chats WHERE ${since(1)}`).n,
    readyToPay: one<{ n: number }>(`SELECT COUNT(*) n FROM leads WHERE stage IN ('ready_to_pay','paid')`).n,
    paused: one<{ n: number }>("SELECT COUNT(*) n FROM chats WHERE paused = 1").n,
  };

  const cost = (days: number) =>
    one<{ usd: number | null; calls: number; input: number | null; output: number | null; cache_read: number | null }>(
      `SELECT SUM(cost_usd) usd, COUNT(*) calls, SUM(input_tokens + cache_write_tokens) input,
              SUM(output_tokens) output, SUM(cache_read_tokens) cache_read
       FROM usage WHERE ${since(days)}`,
    );

  const stages = db.prepare("SELECT stage, COUNT(*) n FROM leads GROUP BY stage").all() as {
    stage: string;
    n: number;
  }[];

  const daily = db
    .prepare(
      `WITH RECURSIVE days(d) AS (
         SELECT date('now', ?, '-13 days') UNION ALL SELECT date(d, '+1 day') FROM days WHERE d < date('now', ?)
       )
       SELECT d AS day,
         (SELECT COUNT(*) FROM messages WHERE direction='in' AND date(created_at, ?) = d) AS incoming,
         (SELECT COUNT(*) FROM chats WHERE date(created_at, ?) = d) AS new_chats,
         (SELECT COUNT(*) FROM leads WHERE stage IN ('ready_to_pay','paid') AND date(updated_at, ?) = d) AS ready,
         (SELECT COALESCE(SUM(cost_usd), 0) FROM usage WHERE date(created_at, ?) = d) AS cost
       FROM days`,
    )
    .all(tz, tz, tz, tz, tz, tz);

  return {
    today: today.d,
    totals,
    cost: { today: cost(1), week: cost(7), month: cost(30) },
    stages: LEAD_STAGES.map((s) => ({ stage: s, n: stages.find((x) => x.stage === s)?.n ?? 0 })),
    daily,
  };
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function mountAdmin(app: Express, wa: WhatsAppClient, notifyHuman: (s: string) => Promise<void>): void {
  if (!config.ADMIN_PASSWORD) {
    console.warn("[admin] ADMIN_PASSWORD is not set: the admin panel is disabled.");
    app.get("/admin", (_req, res) => res.status(503).send("Панель отключена: задайте ADMIN_PASSWORD в .env"));
    return;
  }

  app.get("/", (_req, res) => res.redirect("/admin/"));
  app.use("/admin", express.static("public/admin", { index: "index.html" }));

  const api = express.Router();
  app.use("/admin/api", api);

  // Panel pages: /admin/chats, /admin/chats/<id>, /admin/leads?stage=..., etc. all load the same app.
  const PAGES = /^\/admin(\/(overview|chats|leads|tuning|whatsapp|server)(\/[^/]*)?)?\/?$/;
  app.get(PAGES, (_req, res) => res.sendFile("index.html", { root: "public/admin" }));

  api.post("/login", login);
  api.post("/logout", logout);
  api.get("/me", (req, res) => res.json({ authed: isAuthed(req) }));
  api.use(requireAuth);

  // --- overview ---
  api.get("/stats", h(() => stats()));

  // --- conversations ---
  api.get("/chats", h(() => listChats()));
  api.get("/chats/:id/messages", h((req) => ({ chat: getChat(String(req.params.id)), messages: chatMessages(String(req.params.id)) })));
  api.post(
    "/chats/:id/pause",
    h((req) => setPaused(String(req.params.id), Boolean(req.body?.paused))),
  );
  api.post(
    "/chats/:id/reset",
    h((req) => resetHistory(String(req.params.id))),
  );
  api.post(
    "/chats/:id/send",
    h(async (req) => {
      const chatId = String(req.params.id);
      const text = String(req.body?.text ?? "").trim();
      if (!text) throw new Error("Пустое сообщение");
      await wa.sendText(chatId, text);
      logMessage(chatId, "manual", text);
      // A human answered: stop the bot in this chat until someone turns it back on.
      setPaused(chatId, true);
    }),
  );

  // --- leads ---
  api.get("/leads", h(() => listLeads()));
  api.post(
    "/leads/:id/stage",
    h((req) => {
      const stage = String(req.body?.stage) as LeadStage;
      if (!LEAD_STAGES.includes(stage)) throw new Error("Неизвестный этап");
      return upsertLead(String(req.params.id), { stage }).after;
    }),
  );
  api.get("/leads.csv", (_req, res) => {
    const cols = [
      "chatId", "name", "whatsappName", "grade", "subjects", "specialty", "startedPrep", "targetScore",
      "priorities", "parentPhone", "paymentPreference", "stage", "notes", "createdAt", "updatedAt",
    ] as const;
    const rows = listLeads().map((l) => cols.map((c) => csvEscape((l as unknown as Record<string, unknown>)[c])).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"');
    res.send("﻿" + [cols.join(","), ...rows].join("\n"));
  });

  // --- tuning: script, settings, test chat ---
  api.get("/script", h(() => ({ script: readScript() })));
  api.put(
    "/script",
    h((req) => {
      const script = String(req.body?.script ?? "");
      if (script.trim().length < 20) throw new Error("Скрипт слишком короткий");
      writeScript(script);
      console.log("[admin] sales script updated");
    }),
  );
  api.get("/settings", h(() => ({ settings: getSettings(), efforts: EFFORTS, model: config.CLAUDE_MODEL })));
  api.put(
    "/settings",
    h((req) => {
      const b = req.body ?? {};
      if (b.effort !== undefined && !EFFORTS.includes(b.effort)) throw new Error("Неизвестное значение effort");
      const s = updateSettings({
        botEnabled: b.botEnabled === undefined ? undefined : Boolean(b.botEnabled),
        effort: b.effort as Effort | undefined,
        paymentLink: b.paymentLink === undefined ? undefined : String(b.paymentLink).trim(),
        adminPhone: b.adminPhone === undefined ? undefined : String(b.adminPhone).replace(/\D/g, ""),
      });
      console.log("[admin] settings updated");
      return { settings: s };
    }),
  );
  api.post(
    "/test",
    h(async (req) => {
      const history = (Array.isArray(req.body?.history) ? req.body.history : []) as Turn[];
      const clean = history
        .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.text === "string")
        .slice(-40);
      const reply = await replyToCustomer({ chatId: "test:admin", dryRun: true, notifyHuman }, clean);
      return { reply };
    }),
  );

  // --- WhatsApp connection ---
  api.get("/whatsapp", h(() => wa.getStatus()));
  api.get(
    "/whatsapp/qr",
    h(async () => ({ qr: await wa.getQr() })),
  );
  api.post("/whatsapp/connect", h(() => wa.connect()));
  api.post(
    "/whatsapp/pairing-code",
    h(async (req) => ({ code: await wa.requestPairingCode(String(req.body?.phone ?? "")) })),
  );
  api.post("/whatsapp/logout", h(() => wa.logout()));
  api.post("/whatsapp/restart", h(() => wa.restart()));

  // --- server ---
  api.get(
    "/server",
    h(async () => {
      const disk = await statfs("data");
      return {
        provider: config.WHATSAPP_PROVIDER,
        model: config.CLAUDE_MODEL,
        node: process.version,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        hostUptimeSec: Math.round(os.uptime()),
        load: os.loadavg(),
        cpus: os.cpus().length,
        memory: { total: os.totalmem(), free: os.freemem(), process: process.memoryUsage().rss },
        disk: { total: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize },
      };
    }),
  );
  api.get("/logs", h(() => ({ lines: recentLogs() })));
  api.post("/restart", (_req, res) => {
    res.json({ ok: true });
    console.warn("[admin] restart requested from the panel");
    // Docker's restart policy brings the bot back up.
    setTimeout(() => process.exit(0), 300);
  });
}
