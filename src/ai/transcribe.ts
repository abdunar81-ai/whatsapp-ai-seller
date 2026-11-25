import { config } from "../config.js";

// Words Whisper tends to mishear in this domain; a prompt nudges it toward the right spelling.
const PROMPT = "ҰБТ, ЕНТ, GLUCOSE, Глюкоза, Био/Хим, математика, физика, тарих, Kaspi, рассрочка, сынып, балл.";

export const voiceEnabled = () => Boolean(config.WHISPER_URL);

/** Speech-to-text for a voice note (Kazakh, Russian or mixed); returns the text. */
export async function transcribe(audio: { data: Buffer; mimetype: string }): Promise<string> {
  if (!config.WHISPER_URL) throw new Error("WHISPER_URL is not set");
  const ext = audio.mimetype.includes("ogg") ? "ogg" : audio.mimetype.includes("mp4") ? "m4a" : "audio";
  const form = new FormData();
  form.append("audio_file", new Blob([new Uint8Array(audio.data)], { type: audio.mimetype }), `voice.${ext}`);
  const params = new URLSearchParams({
    encode: "true",
    task: "transcribe",
    output: "json",
    vad_filter: "true",
    initial_prompt: PROMPT,
  });
  const started = Date.now();
  const res = await fetch(`${config.WHISPER_URL}/asr?${params}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Whisper failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { text?: string; language?: string };
  const text = (json.text ?? "").trim();
  console.log(`[voice] ${json.language ?? "?"} in ${((Date.now() - started) / 1000).toFixed(1)}s: ${text.slice(0, 80)}`);
  return text;
}
