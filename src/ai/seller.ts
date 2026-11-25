import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { LEAD_STAGES, upsertLead } from "../store/leads.js";
import { getSettings, readScript } from "../store/settings.js";
import { knowledgeText } from "../store/questions.js";
import { recordUsage } from "../store/usage.js";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

// Kept byte-stable for a given script + payment link, so prompt caching keeps hitting.
function buildSystemPrompt(script: string, knowledge: string, paymentLink: string): string {
  const paymentStep = paymentLink
    ? `When the customer is ready to pay, send this payment link: ${paymentLink}`
    : "There is no payment link yet: when the customer is ready to pay, set stage ready_to_pay with save_lead and tell them the manager will send the payment link shortly.";

  return `You are the WhatsApp sales manager of an education center. Your sales script and all course facts are below, between <script> tags. Follow it.

How you work:
- Write like a real manager on WhatsApp: short, warm messages, a few lines each, emojis as in the script. WhatsApp formatting only (*bold*); no markdown headings, lists with "-", or tables.
- Language: Kazakh by default, as in the script. If the customer writes in Russian, answer in Russian.
- Go through the script steps in order, one step per message, and ask one question at a time. Wait for the answer before moving on. Adapt the wording to what the customer said (their subjects, specialty, goals); don't paste whole blocks they've already seen.
- If the customer asks something out of order (e.g. the price right away), answer it briefly and steer back to the next step.
- Only use facts, prices, bonuses and payment terms from the script and the knowledge base. Never invent discounts, deadlines, guarantees or features.
- If the customer asks something the script and knowledge base don't answer, don't guess: call ask_manager with their question (keep their words), tell them you'll check with the manager and get back to them, then continue the script where it makes sense.
- Messages starting with 🎤 are automatic transcripts of voice notes and may contain recognition mistakes; read them for meaning, and if one is unclear, ask the customer to repeat or write it.
- If someone sincerely asks whether they're talking to a bot, say honestly that you are GLUCOSE's AI assistant and a manager can join the chat.
- Call save_lead whenever you learn something new about the customer (name, grade, subjects, specialty, target score, what matters to them, parent's phone, payment preference) and when the conversation moves to a new stage. Don't mention that you're saving anything.
- ${paymentStep}
- If the customer gives a parent's phone number for a call, save it (stage parent_call) and say the manager will call.
- Complaints, refunds, or a customer who wants a real person: call request_human and tell the customer a manager will reply soon.

<script>
${script}
</script>

<knowledge_base>
Answers the managers gave to earlier questions. Use them like script facts.

${knowledge || "(empty)"}
</knowledge_base>`;
}

export interface SellerContext {
  chatId: string;
  senderName?: string;
  notifyHuman: (summary: string) => Promise<void>;
  /** Send a question the script can't answer to the managers; returns its number. */
  askManager: (question: string) => Promise<number>;
  /** Test chat from the admin panel: nothing is saved and nobody is notified. */
  dryRun?: boolean;
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
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
        if (ctx.dryRun) return "saved";
        const { before, after } = upsertLead(ctx.chatId, { whatsappName: ctx.senderName, ...fields });
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
      name: "ask_manager",
      description:
        "Ask the managers a question the script and knowledge base don't answer. They reply to the customer themselves.",
      inputSchema: z.object({
        question: z.string().describe("The customer's question, in their words"),
      }),
      run: async ({ question }) => {
        if (ctx.dryRun) return "Test mode: the question was not sent. In real chats the managers get it.";
        const id = await ctx.askManager(question);
        return `Question #${id} sent to the managers. They will answer the customer in this chat.`;
      },
    }),
    betaZodTool({
      name: "request_human",
      description: "Hand the conversation to a human manager (complaints, refunds, questions the script doesn't cover).",
      inputSchema: z.object({ reason: z.string() }),
      run: async ({ reason }) => {
        if (!ctx.dryRun) {
          await ctx.notifyHuman(`Customer ${ctx.senderName ?? ""} (${ctx.chatId}) needs a manager: ${reason}`);
        }
        return "A manager has been notified.";
      },
    }),
  ];
}

/**
 * Generate the seller's reply. `history` is the conversation so far (oldest
 * first) and must end with the customer's new message.
 */
export async function replyToCustomer(ctx: SellerContext, history: Turn[]): Promise<string> {
  const settings = getSettings();
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.text,
  }));
  while (messages.length > 0 && messages[0]!.role !== "user") messages.shift();
  if (messages.length === 0) return "";

  // Haiku has no server-side fallback (a fallbacks list is rejected), so only send it for Sonnet/Opus.
  const fallback = settings.model.startsWith("claude-haiku")
    ? {}
    : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

  const runner = client.beta.messages.toolRunner({
    model: settings.model,
    max_tokens: 16000,
    system: buildSystemPrompt(readScript(), knowledgeText(), settings.paymentLink),
    cache_control: { type: "ephemeral" },
    output_config: { effort: settings.effort },
    // If a safety classifier declines, retry on Anthropic's recommended fallback model.
    ...fallback,
    tools: buildTools(ctx),
    max_iterations: 8,
    messages,
  });

  let final: Anthropic.Beta.BetaMessage | undefined;
  for await (const message of runner) {
    recordUsage(ctx.dryRun ? "test:admin" : ctx.chatId, message.model, message.usage);
    final = message;
  }
  if (!final) return "";

  if (final.stop_reason === "refusal") {
    return "Кешіріңіз, бұл сұраққа менеджер жауап береді. Жақын арада хабарласамыз 🙏";
  }

  return final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
