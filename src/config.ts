import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  CLAUDE_MODEL: z.string().default("claude-haiku-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  SCRIPT_FILE: z.string().default("data/script.md"),
  KASPI_PAYMENT_LINK: z.string().default(""),
  WHATSAPP_PROVIDER: z.enum(["baileys", "waha"]).default("waha"),
  BAILEYS_AUTH_DIR: z.string().default("auth"),
  WAHA_URL: z.string().default("http://localhost:3001"),
  WAHA_API_KEY: z.string().default(""),
  WAHA_SESSION: z.string().default("default"),
  ADMIN_PHONE: z.string().default(""),
  // Admin panel (empty password = panel disabled)
  ADMIN_PASSWORD: z.string().default(""),
  // Public address of the admin panel, used in links sent to WhatsApp
  DOMAIN: z.string().default(""),
  // Whisper speech-to-text service for voice notes (empty = voice notes not supported)
  WHISPER_URL: z.string().default(""),
  // Hours from UTC for daily stats (Kazakhstan = 5)
  TZ_OFFSET_HOURS: z.coerce.number().default(5),
  SESSION_SECRET: z.string().default(""),
});

export const config = schema.parse(process.env);
