import { readFile, writeFile } from "node:fs/promises";

export const LEAD_STAGES = [
  "new",
  "qualifying",
  "presented",
  "price_sent",
  "ready_to_pay",
  "parent_call",
  "not_interested",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export interface Lead {
  chatId: string;
  whatsappName?: string;
  name?: string;
  grade?: string;
  subjects?: string;
  specialty?: string;
  startedPrep?: string;
  targetScore?: string;
  priorities?: string;
  parentPhone?: string;
  paymentPreference?: string;
  notes?: string;
  stage: LeadStage;
  createdAt: string;
  updatedAt: string;
}

const LEADS_FILE = "data/leads.json";

async function loadLeads(): Promise<Record<string, Lead>> {
  try {
    return JSON.parse(await readFile(LEADS_FILE, "utf8")) as Record<string, Lead>;
  } catch {
    return {};
  }
}

// Serialize writes so two chats saving at once don't clobber the file.
let writeChain: Promise<unknown> = Promise.resolve();

/** Merge new fields into the chat's lead; returns the lead before and after. */
export function upsertLead(
  chatId: string,
  fields: Partial<Omit<Lead, "chatId" | "createdAt" | "updatedAt">>,
): Promise<{ before?: Lead; after: Lead }> {
  const job = writeChain.then(async () => {
    const leads = await loadLeads();
    const before = leads[chatId];
    const now = new Date().toISOString();
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined && v !== ""),
    );
    const after: Lead = {
      ...before,
      ...defined,
      stage: (defined.stage as LeadStage | undefined) ?? before?.stage ?? "new",
      createdAt: before?.createdAt ?? now,
      chatId,
      updatedAt: now,
    };
    leads[chatId] = after;
    await writeFile(LEADS_FILE, JSON.stringify(leads, null, 2));
    return { before, after };
  });
  writeChain = job.catch(() => undefined);
  return job;
}
