import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { config } from "../config.js";
import { createOrder, searchProducts } from "../store/catalog.js";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

// Keep this text stable (no dates/ids) so prompt caching keeps hitting.
const SYSTEM_PROMPT = `You are the sales assistant for "${config.STORE_NAME}", chatting with customers on WhatsApp.

How you work:
- Reply in the customer's language. Keep messages short and friendly, like a real shop assistant on WhatsApp: a few lines, no markdown headings or tables. Use *bold* sparingly (WhatsApp formatting).
- Always look products up with search_products before quoting a price, stock or option. Never invent products, prices, discounts or delivery promises.
- Prices are in ${config.STORE_CURRENCY}. If something is out of stock, say so and suggest an alternative.
- Help the customer choose, then close the sale: confirm items, options (size/color...), quantity, name and delivery address. Read the full order and total back and get an explicit "yes" before calling create_order.
- After create_order succeeds, share the order id and total.
- If the customer is angry, asks for a refund, or asks for something you can't do, call request_human and tell them a team member will follow up.

Store notes from the owner:
${config.STORE_NOTES || "(none)"}`;

const MAX_HISTORY = 30;
const histories = new Map<string, Anthropic.Beta.BetaMessageParam[]>();

export interface SellerContext {
  chatId: string;
  senderName?: string;
  notifyHuman: (summary: string) => Promise<void>;
}

function buildTools(ctx: SellerContext) {
  return [
    betaZodTool({
      name: "search_products",
      description:
        "Search the store catalog. Returns matching products with id, price, stock and options. Use an empty query to list everything.",
      inputSchema: z.object({
        query: z.string().describe("Keywords, e.g. 'black hoodie'. Empty string lists all products."),
      }),
      run: async ({ query }) => JSON.stringify(await searchProducts(query)),
    }),
    betaZodTool({
      name: "create_order",
      description:
        "Place an order. Only call after the customer explicitly confirmed the items, options, quantities, name and address.",
      inputSchema: z.object({
        customerName: z.string(),
        address: z.string(),
        items: z
          .array(
            z.object({
              productId: z.string(),
              quantity: z.number().int().positive(),
              options: z.record(z.string(), z.string()).optional(),
            }),
          )
          .min(1),
        notes: z.string().optional(),
      }),
      run: async (input) => {
        try {
          const order = await createOrder({ chatId: ctx.chatId, ...input });
          await ctx.notifyHuman(
            `New order ${order.id} from ${order.customerName} (${ctx.chatId}): ` +
              order.items.map((i) => `${i.quantity}x ${i.name}`).join(", ") +
              ` — total ${order.total} ${config.STORE_CURRENCY}`,
          );
          return JSON.stringify({ ok: true, orderId: order.id, total: order.total });
        } catch (err) {
          return JSON.stringify({ ok: false, error: (err as Error).message });
        }
      },
    }),
    betaZodTool({
      name: "request_human",
      description: "Hand the conversation to a human team member (complaints, refunds, special requests).",
      inputSchema: z.object({ reason: z.string() }),
      run: async ({ reason }) => {
        await ctx.notifyHuman(`Customer ${ctx.senderName ?? ""} (${ctx.chatId}) needs a human: ${reason}`);
        return "A team member has been notified.";
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
    return "Sorry, I can't help with that here. A team member will get back to you.";
  }

  const reply = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Store only the visible turn; tool calls are re-done from the catalog when needed.
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
