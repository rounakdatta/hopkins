// A minimal Anthropic Messages client for the small, cheap model hopkins uses
// to notice open loops. Any endpoint speaking that API works (Anthropic itself,
// or a gateway). The key comes from a private file or an environment variable,
// never from plugin settings, which every connected app can read.

import fs from "node:fs";
import path from "node:path";
import { errorText } from "./log";

export interface LlmConfig {
  baseUrl: string;
  model: string;
}

export interface Llm {
  readonly available: boolean;
  complete(request: { system: string; user: string; maxTokens?: number }): Promise<string>;
}

export const KEY_FILE = "llm-key";

/** Reads the key from HOPKINS_LLM_API_KEY or `<dataDir>/llm-key` (first line). */
export function readKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.HOPKINS_LLM_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const file = path.join(dataDir, KEY_FILE);
    const key = fs.readFileSync(file, "utf8").split("\n")[0]!.trim();
    return key || null;
  } catch {
    return null;
  }
}

export class AnthropicLlm implements Llm {
  constructor(
    private readonly config: () => LlmConfig,
    private readonly key: () => string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get available(): boolean {
    return Boolean(this.key()) && Boolean(this.config().model);
  }

  async complete(request: { system: string; user: string; maxTokens?: number }): Promise<string> {
    const key = this.key();
    if (!key) throw new Error("no model key configured");
    const { baseUrl, model } = this.config();
    const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens ?? 2_000,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`model call failed: ${response.status} ${detail.slice(0, 160)}`);
    }
    const body = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    if (!text.trim()) throw new Error("model returned no text");
    return text;
  }
}

/** Pulls the first JSON object out of a model reply (tolerates code fences and prose around it). */
export function parseJsonObject<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in the model's reply");
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch (err) {
    throw new Error(`unreadable JSON from the model: ${errorText(err)}`);
  }
}

/**
 * Asks for JSON and parses it; on unreadable JSON, asks once more with the
 * parse error, since small models occasionally drop a comma in long lists.
 */
export async function completeJson<T>(llm: Llm, request: { system: string; user: string; maxTokens?: number }, parse: (reply: string) => T): Promise<T> {
  const first = await llm.complete(request);
  try {
    return parse(first);
  } catch (err) {
    const retry = await llm.complete({
      ...request,
      user: `${request.user}\n\nYour previous reply was not valid JSON (${errorText(err)}). Reply again with valid JSON only.`,
    });
    return parse(retry);
  }
}
