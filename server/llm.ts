// A minimal Anthropic Messages client for the small, cheap model hopkins uses
// to notice open loops. Any endpoint speaking that API works (Anthropic itself,
// or a gateway). The key comes from a private file or an environment variable,
// never from plugin settings, which every connected app can read.

import fs from "node:fs";
import path from "node:path";
import { errorText } from "./log";

export interface LlmConfig {
  model: string;
}

export interface LlmCredentials {
  key: string;
  /** The endpoint the key belongs to; the key is never sent anywhere else. */
  baseUrl: string;
}

export interface Llm {
  readonly available: boolean;
  complete(request: { system: string; user: string; maxTokens?: number }): Promise<string>;
}

export const KEY_FILE = "llm-key";
export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * The key and its endpoint, from HOPKINS_LLM_API_KEY (+ HOPKINS_LLM_BASE_URL), or from
 * `<dataDir>/llm-key`: the key on the first line, optionally the endpoint on the second.
 */
export function readCredentials(dataDir: string, env: NodeJS.ProcessEnv = process.env): LlmCredentials | null {
  const fromEnv = env.HOPKINS_LLM_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, baseUrl: env.HOPKINS_LLM_BASE_URL?.trim() || DEFAULT_BASE_URL };
  try {
    const [key, baseUrl] = fs.readFileSync(path.join(dataDir, KEY_FILE), "utf8").split("\n").map((l) => l.trim());
    return key ? { key, baseUrl: baseUrl || env.HOPKINS_LLM_BASE_URL?.trim() || DEFAULT_BASE_URL } : null;
  } catch {
    return null;
  }
}

/** Kept for callers that only need to know whether a key exists. */
export function readKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return readCredentials(dataDir, env)?.key ?? null;
}

export class AnthropicLlm implements Llm {
  constructor(
    private readonly config: () => LlmConfig,
    private readonly credentials: () => LlmCredentials | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get available(): boolean {
    return Boolean(this.credentials()) && Boolean(this.config().model);
  }

  async complete(request: { system: string; user: string; maxTokens?: number }): Promise<string> {
    const creds = this.credentials();
    if (!creds) throw new Error("no model key configured");
    const url = `${creds.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": creds.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: this.config().model,
        max_tokens: request.maxTokens ?? 2_000,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    // Error bodies can echo the request, so only the status is kept: errors end up in a shared log.
    if (!response.ok) throw new Error(`model call failed: HTTP ${response.status}`);
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
  if (start === -1 || end <= start) throw new Error("the model's reply had no JSON object");
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    // The engine's message quotes part of the reply; keep that out of logs.
    throw new Error("the model's reply was not valid JSON");
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
