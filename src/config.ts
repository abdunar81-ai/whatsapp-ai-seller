import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  SCRIPT_FILE: z.string().default("data/script.md"),
  KASPI_PAYMENT_LINK: z.string().default(""),
  WHATSAPP_PROVIDER: z.enum(["baileys", "waha"]).default("waha"),
  BAILEYS_AUTH_DIR: z.string().default("auth"),
  WAHA_URL: z.string().default("http://localhost:3001"),
  WAHA_API_KEY: z.string().default(""),
  WAHA_SESSION: z.string().default("default"),
  ADMIN_PHONE: z.string().default(""),
});

export const config = schema.parse(process.env);
