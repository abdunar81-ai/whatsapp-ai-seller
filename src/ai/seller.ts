import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { config } from "../config.js";
import { LEAD_STAGES, upsertLead } from "../store/leads.js";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

const SCRIPT = readFileSync(config.SCRIPT_FILE, "utf8");

const PAYMENT_STEP = config.KASPI_PAYMENT_LINK
  ? `When the customer is ready to pay, send this payment link: ${config.KASPI_PAYMENT_LINK}`
  : "There is no payment link yet: when the customer is ready to pay, set stage ready_to_pay with save_lead and tell them the manager will send the payment link shortly.";

// Keep this text stable (no dates/ids) so prompt caching keeps hitting.
const SYSTEM_PROMPT = `You are the WhatsApp sales manager of an education center. Your sales script and all course facts are below, between <script> tags. Follow it.

How you work:
- Write like a real manager on WhatsApp: short, warm messages, a few lines each, emojis as in the script. WhatsApp formatting only (*bold*); no markdown headings, lists with "-", or tables.
- Language: Kazakh by default, as in the script. If the customer writes in Russian, answer in Russian.
- Go through the script steps in order, one step per message, and ask one question at a time. Wait for the answer before moving on. Adapt the wording to what the customer said (their subjects, specialty, goals); don't paste whole blocks they've already seen.
- If the customer asks something out of order (e.g. the price right away), answer it briefly and steer back to the next step.
- Only use facts, prices, bonuses and payment terms from the script. Never invent discounts, deadlines, guarantees or features. If you don't know, say a manager will clarify and call request_human.
- If someone sincerely asks whether they're talking to a bot, say honestly that you are GLUCOSE's AI assistant and a manager can join the chat.
- Call save_lead whenever you learn something new about the customer (name, grade, subjects, specialty, target score, what matters to them, parent's phone, payment preference) and when the conversation moves to a new stage. Don't mention that you're saving anything.
- ${PAYMENT_STEP}
- If the customer gives a parent's phone number for a call, save it (stage parent_call) and say the manager will call.
- Complaints, refunds, or anything you can't handle: call request_human and tell the customer a manager will reply soon.

<script>
${SCRIPT}
</script>`;

const MAX_HISTORY = 40;
const histories = new Map<string, Anthropic.Beta.BetaMessageParam[]>();

export interface SellerContext {
  chatId: string;
  senderName?: string;
  notifyHuman: (summary: string) => Promise<void>;
}

const NOTIFY_STAGES = new Set(["ready_to_pay", "parent_call"]);

function buildTools(ctx: SellerContext) {
  return [
    betaZodTool({
      name: "save_lead",
      description:
        "Save what you learned about this customer to the CRM. Pass only fields you learned or that changed; earlier values are kept.",
      inputSchema: z.object({
        name: z.string().optional(),
        grade: z.string().optional().describe("School grade, e.g. '11'"),
        subjects: z.string().optional().describe("Elective ҰБТ subjects, e.g. 'Био/Хим'"),
        specialty: z.string().optional().describe("Chosen specialty / university direction"),
        startedPrep: z.string().optional().describe("Whether and how they already prepare for ҰБТ"),
        targetScore: z.string().optional(),
        priorities: z.string().optional().describe("What matters to them in a course"),
        parentPhone: z.string().optional(),
        paymentPreference: z.string().optional().describe("Full payment or installments (and months)"),
        notes: z.string().optional(),
        stage: z.enum(LEAD_STAGES).optional(),
      }),
      run: async (fields) => {
        const { before, after } = await upsertLead(ctx.chatId, { whatsappName: ctx.senderName, ...fields });
        if (fields.stage && NOTIFY_STAGES.has(fields.stage) && before?.stage !== fields.stage) {
          await ctx.notifyHuman(
            `Lead ${after.stage}: ${after.name ?? ctx.senderName ?? ""} (${ctx.chatId}), ` +
              `${after.grade ?? "?"} сынып, ${after.subjects ?? "?"}` +
              (after.parentPhone ? `, ата-ана: ${after.parentPhone}` : "") +
              (after.paymentPreference ? `, төлем: ${after.paymentPreference}` : ""),
          );
        }
        return "saved";
      },
    }),
    betaZodTool({
      name: "request_human",
      description: "Hand the conversation to a human manager (complaints, refunds, questions the script doesn't cover).",
      inputSchema: z.object({ reason: z.string() }),
      run: async ({ reason }) => {
        await ctx.notifyHuman(`Customer ${ctx.senderName ?? ""} (${ctx.chatId}) needs a manager: ${reason}`);
        return "A manager has been notified.";
      },
    }),
  ];
}

/** Generate the seller's reply to one incoming customer message. */
export async function replyToCustomer(ctx: SellerContext, text: string): Promise<string> {
  const history = histories.get(ctx.chatId) ?? [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: "user", content: text }];

  const final = await client.beta.messages.toolRunner({
    model: config.CLAUDE_MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" },
    output_config: { effort: config.CLAUDE_EFFORT },
    // If a safety classifier declines, retry on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools: buildTools(ctx),
    max_iterations: 8,
    messages,
  });

  if (final.stop_reason === "refusal") {
    return "Кешіріңіз, бұл сұраққа менеджер жауап береді. Жақын арада хабарласамыз 🙏";
  }

  const reply = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Store only the visible turn; lead details live in data/leads.json.
  const updated: Anthropic.Beta.BetaMessageParam[] = [
    ...messages,
    { role: "assistant", content: reply || "…" },
  ];
  while (updated.length > MAX_HISTORY || (updated.length > 0 && updated[0]!.role !== "user")) {
    updated.shift();
  }
  histories.set(ctx.chatId, updated);

  return reply;
}

export function resetConversation(chatId: string): void {
  histories.delete(chatId);
}
