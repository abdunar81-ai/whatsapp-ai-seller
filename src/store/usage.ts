import type Anthropic from "@anthropic-ai/sdk";
import { db, now } from "../db.js";
import { config } from "../config.js";

const insert = db.prepare(
  `INSERT INTO usage (chat_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

/** Record one API call's token usage and estimated cost (prices per million tokens from config). */
export function recordUsage(chatId: string, model: string, u: Anthropic.Beta.BetaUsage): void {
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cost =
    (input * config.PRICE_INPUT +
      output * config.PRICE_OUTPUT +
      cacheRead * config.PRICE_CACHE_READ +
      cacheWrite * config.PRICE_CACHE_WRITE) /
    1_000_000;
  insert.run(chatId, model, input, output, cacheRead, cacheWrite, cost, now());
}
