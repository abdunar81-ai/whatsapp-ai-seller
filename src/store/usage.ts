import type Anthropic from "@anthropic-ai/sdk";
import { db, now } from "../db.js";

/** USD per million tokens: input, output, cache read, cache write (5-minute). */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125], // prompts up to 100K tokens
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
};

const insert = db.prepare(
  `INSERT INTO usage (chat_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

/** Record one API call's token usage and estimated cost. */
export function recordUsage(chatId: string, model: string, u: Anthropic.Beta.BetaUsage): void {
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const [pIn, pOut, pRead, pWrite] = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
  const cost = (input * pIn + output * pOut + cacheRead * pRead + cacheWrite * pWrite) / 1_000_000;
  insert.run(chatId, model, input, output, cacheRead, cacheWrite, cost, now());
}
