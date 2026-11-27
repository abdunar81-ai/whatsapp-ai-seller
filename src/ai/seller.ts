import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { LEAD_STAGES, getLead, upsertLead } from "../store/leads.js";
import { setPaused } from "../store/chats.js";
import { getSettings, readScript } from "../store/settings.js";
import { knowledgeText } from "../store/questions.js";
import { recordUsage } from "../store/usage.js";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

// Kept byte-stable for a given script + payment link, so prompt caching keeps hitting.
function buildSystemPrompt(script: string, knowledge: string, paymentLink: string): string {
  // The script decides the sales flow; these rules only say how to work with it.
  const payment = paymentLink
    ? `\n- Payment link: ${paymentLink}. Send it only if the script has a payment step and the customer is ready to pay.`
    : "";

  return `You are the WhatsApp sales manager of an education center. Your sales script and all course facts are below, between <script> tags. The script decides what you offer and in what order: follow it, not your own sales ideas.

How you work:
- Write like a real manager on WhatsApp: short, warm messages, a few lines each, emojis as in the script. WhatsApp formatting only (*bold*); no markdown headings, lists with "-", or tables.
- Language: Kazakh by default, as in the script. If the customer writes in Russian, answer in Russian.
- Go through the script steps in order, one step per message, and wait for the customer's answer before moving on. Use the script's wording, adapted to what the customer said (their name, subjects, goals); don't repeat blocks they've already seen.
- If the customer asks something out of order, answer it briefly from the script or knowledge base and steer back to the current step.
- Only use facts, prices, offers, links and terms that are in the script or the knowledge base. Never invent discounts, deadlines, guarantees or features. If the script says the manager explains something (for example prices), don't state it yourself, even if earlier messages in this chat mentioned it: the script may have changed since.
- If the customer asks something the script and knowledge base don't answer, don't guess: call ask_manager with their question (keep their words), tell them you'll check with the manager, then continue the script.
- When the script says to connect the customer with the manager and they agree (for example they send "+"), or they ask for a real person, complain or ask for a refund: call request_human with a short summary of who they are and what they want, and tell them the manager will write to them soon. The manager then takes over this chat.
- Messages starting with 🎤 are voice notes, transcribed and then corrected automatically; a few words may still be wrong, so read them for meaning, and if one is unclear, ask the customer to repeat or write it.
- If someone sincerely asks whether they're talking to a bot, say honestly that you are GLUCOSE's AI assistant and a manager can join the chat.
- Call save_lead whenever you learn something new about the customer (name, grade, subjects, test result, target score, how they prepare now, preferred format, parent's phone) and when the conversation reaches a new stage. Don't mention that you're saving anything.${payment}
- Every turn must end with a message to the customer, even after calling tools.

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
        testResult: z.string().optional().describe("Trial test result they sent"),
        targetScore: z.string().optional(),
        priorities: z.string().optional().describe("Preferred study format / what matters to them in a course"),
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
      description:
        "Hand the customer to a human manager: when the script says to connect them with the manager and they agree (e.g. they send \"+\"), when they ask for a real person, or for complaints and refunds. The bot stops replying in this chat afterwards.",
      inputSchema: z.object({
        reason: z.string().describe("Short summary: who the customer is and what they want from the manager"),
      }),
      run: async ({ reason }) => {
        if (ctx.dryRun) return "Test mode: no manager was notified. In real chats the manager gets an alert and takes over.";
        const before = getLead(ctx.chatId);
        const lead = upsertLead(ctx.chatId, {
          whatsappName: ctx.senderName,
          ...(before?.stage === "paid" ? {} : { stage: "handed_over" as const }),
        }).after;
        const who = [
          lead.name ?? ctx.senderName,
          lead.grade && `${lead.grade} сынып`,
          lead.subjects,
          lead.testResult && `тест: ${lead.testResult}`,
          lead.targetScore && `мақсат: ${lead.targetScore}`,
        ]
          .filter(Boolean)
          .join(", ");
        await ctx.notifyHuman(`Нужен менеджер: ${who || "клиент"} (${ctx.chatId}). ${reason}`);
        // The manager answers from here on; the bot would only talk over them.
        setPaused(ctx.chatId, true);
        return "The manager has been notified and will write to the customer. Tell the customer that; the bot is now paused in this chat.";
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

  const text = (final?.content ?? [])
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (final && final.stop_reason !== "refusal" && text) return text;

  // Declined by a safety filter, or the bot ended without writing anything:
  // never promise a manager without actually telling one.
  const reason = final?.stop_reason === "refusal" ? "the AI declined to answer" : "the bot could not write a reply";
  const lastStudentMessage = [...history].reverse().find((t) => t.role === "user")?.text ?? "";
  console.warn(`[bot] ${reason} in ${ctx.chatId}; asking a manager`);
  if (!ctx.dryRun) await ctx.askManager(`(${reason}) ${lastStudentMessage}`);
  return HANDOFF_REPLY;
}

/** Sent when the bot hands a message to the managers instead of answering it. */
export const HANDOFF_REPLY = "Кешіріңіз, бұл сұраққа менеджер жауап береді. Жақын арада хабарласамыз 🙏";
