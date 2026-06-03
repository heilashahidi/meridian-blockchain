import { ChatAnthropic } from "@langchain/anthropic";
import type { z } from "zod";

import { MODEL } from "./config.js";

/**
 * Build a Claude model. Sonnet 4.6 rejects requests that set BOTH temperature
 * and top_p, but @langchain/anthropic always includes its top_p/top_k
 * sentinels — null them so only temperature goes out.
 */
function model() {
  // 4096: a full set of 6 detailed hypotheses serialises past 2k tokens; a
  // truncated reply yields unbalanced JSON that won't parse.
  const m = new ChatAnthropic({ model: MODEL, temperature: 0, maxTokens: 4096 });
  (m as unknown as { topP?: number; topK?: number }).topP = undefined;
  (m as unknown as { topP?: number; topK?: number }).topK = undefined;
  return m;
}

const shared = model();

/** Pull the first balanced JSON object out of a model response. Tolerates
 *  ```json fences and leading prose. */
function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) return body.slice(start, i + 1);
  }
  return null;
}

/**
 * Ask the model for JSON matching `schema` and parse it. We use text JSON (not
 * tool-calling) because Claude + withStructuredOutput intermittently emits an
 * empty tool call ({}) for single array-property schemas. One retry on a parse
 * miss, feeding the error back.
 */
export async function callJson<S extends z.ZodTypeAny>(
  system: string,
  human: string,
  schema: S,
  shapeHint: string,
): Promise<z.infer<S>> {
  const base =
    `${human}\n\nRespond with ONLY a JSON object matching exactly this shape ` +
    `(no prose, no markdown fences):\n${shapeHint}`;
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = attempt === 0 ? base : `${base}\n\nYour previous reply did not parse: ${lastErr}. Return valid JSON only.`;
    const res = await shared.invoke([
      ["system", system],
      ["human", msg],
    ]);
    const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const json = extractJson(text);
    if (!json) {
      lastErr = "no JSON object found";
      continue;
    }
    try {
      return schema.parse(JSON.parse(json));
    } catch (e) {
      lastErr = (e as Error).message.slice(0, 200);
    }
  }
  throw new Error(`callJson failed after retries: ${lastErr}`);
}
