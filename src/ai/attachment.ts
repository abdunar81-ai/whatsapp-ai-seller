import Anthropic from "@anthropic-ai/sdk";
import { recordUsage } from "../store/usage.js";

const client = new Anthropic({ timeout: 90_000, maxRetries: 2 });

// Reading a photo or a PDF is easy work for the small, fast model.
const MODEL = "claude-haiku-5-5";

const SYSTEM = `Students of GLUCOSE, an ҰБТ (ЕНТ) exam-prep center in Kazakhstan, send photos and PDFs on WhatsApp, most often a screenshot of a trial test result. Describe the file in one to three short sentences, in the language of the text in it (Kazakh or Russian; Russian if there is no text), so a sales manager who can't see it knows what was sent.
- For a test result: write the subjects and the scores exactly as shown, and the total if there is one.
- For a receipt or payment screenshot: the amount, the date and who was paid.
- Otherwise: what it shows and any text that matters.
Don't add advice or comments.`;

/** A short text description of a photo or PDF the customer sent, for the chat history. */
export async function describeAttachment(chatId: string, file: { data: Buffer; mimetype: string }): Promise<string> {
  const data = file.data.toString("base64");
  const block: Anthropic.ContentBlockParam =
    file.mimetype === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : {
          type: "image",
          source: { type: "base64", media_type: file.mimetype as "image/jpeg" | "image/png" | "image/gif", data },
        };
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: SYSTEM,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: [block, { type: "text", text: "Describe this file." }] }],
  });
  recordUsage(chatId, res.model, res.usage);
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}
