import { db, now } from "../db.js";

export const LEAD_STAGES = [
  "new",
  "qualifying",
  "test_sent",
  "presented",
  "handed_over",
  "price_sent",
  "ready_to_pay",
  "parent_call",
  "paid",
  "not_interested",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export interface LeadData {
  whatsappName?: string;
  name?: string;
  grade?: string;
  subjects?: string;
  specialty?: string;
  startedPrep?: string;
  testResult?: string;
  targetScore?: string;
  priorities?: string;
  parentPhone?: string;
  paymentPreference?: string;
  notes?: string;
}

export interface Lead extends LeadData {
  chatId: string;
  stage: LeadStage;
  createdAt: string;
  updatedAt: string;
}

interface LeadRow {
  chat_id: string;
  stage: LeadStage;
  data: string;
  created_at: string;
  updated_at: string;
}

const toLead = (r: LeadRow): Lead => ({
  ...(JSON.parse(r.data) as LeadData),
  chatId: r.chat_id,
  stage: r.stage,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getLead(chatId: string): Lead | undefined {
  const row = db.prepare("SELECT * FROM leads WHERE chat_id = ?").get(chatId) as LeadRow | undefined;
  return row ? toLead(row) : undefined;
}

/** Merge new fields into the chat's lead; returns the lead before and after. */
export function upsertLead(
  chatId: string,
  fields: LeadData & { stage?: LeadStage },
): { before?: Lead; after: Lead } {
  const before = getLead(chatId);
  const { stage, ...rest } = fields;
  const defined = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined && v !== ""),
  ) as LeadData;
  const t = now();
  const after: Lead = {
    ...before,
    ...defined,
    chatId,
    stage: stage ?? before?.stage ?? "new",
    createdAt: before?.createdAt ?? t,
    updatedAt: t,
  };
  const { chatId: _c, stage: s, createdAt, updatedAt, ...data } = after;
  db.prepare(
    `INSERT INTO leads (chat_id, stage, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (chat_id) DO UPDATE SET stage = excluded.stage, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(chatId, s, JSON.stringify(data), createdAt, updatedAt);
  return { before, after };
}

export function listLeads(): Lead[] {
  return (db.prepare("SELECT * FROM leads ORDER BY updated_at DESC").all() as unknown as LeadRow[]).map(toLead);
}
