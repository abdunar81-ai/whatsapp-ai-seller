import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Turn } from "./seller.js";
import { recordUsage } from "../store/usage.js";

const client = new Anthropic();

// A small, cheap, fast model is enough to clean up a transcript.
const MODEL = "claude-haiku-5-5";

const SYSTEM = `You fix speech-to-text transcripts of WhatsApp voice notes that students send to GLUCOSE, an ҰБТ (ЕНТ) exam-prep center in Kazakhstan. Speakers mix Kazakh and Russian.

The recognizer often gets Kazakh letters wrong (ә ғ қ ң ө ұ ү һ і), splits or merges words, and mishears names, subjects, numbers and terms such as ҰБТ/ЕНТ, Glucose, Био/Хим, тарих, Kaspi, рассрочка, сынып, балл.

Using the conversation so far as context, return the corrected transcript:
- Fix misrecognized words, spelling and Kazakh letters, and add punctuation.
- Keep the speaker's language (Kazakh, Russian or the mix they used), meaning and wording. Don't translate, summarize, answer or add anything.
- If a part can't be understood even with context, leave it as it is.`;

const Output = z.object({ text: z.string() });

/** Correct a raw transcript using the recent conversation. Falls back to the raw text on any error. */
export async function correctTranscript(chatId: string, raw: string, history: Turn[]): Promise<string> {
  if (!raw.trim()) return raw;
  const context = history
    .slice(-12)
    .map((t) => `${t.role === "user" ? "Student" : "Center"}: ${t.text}`)
    .join("\n");
  try {
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: "low", format: zodOutputFormat(Output) },
      messages: [
        {
          role: "user",
          content: `<conversation>\n${context || "(this is the first message)"}\n</conversation>\n\n<transcript>\n${raw}\n</transcript>`,
        },
      ],
    });
    recordUsage(chatId, res.model, res.usage);
    if (res.stop_reason === "refusal" || !res.parsed_output?.text.trim()) return raw;
    return res.parsed_output.text.trim();
  } catch (err) {
    console.error("[voice] correction failed, using raw transcript", err);
    return raw;
  }
}
