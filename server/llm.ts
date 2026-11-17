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

/** The model said "not now" (rate limited or overloaded) rather than "no": worth waiting out. */
export class ModelBusyError extends Error {
  constructor(
    readonly status: number,
    /** How long the endpoint asked callers to wait, when it said. */
    readonly retryAfterMs: number | null,
  ) {
    super(`model call failed: HTTP ${status} (busy)`);
  }
}

const BUSY_STATUSES = new Set([429, 503, 529]);

function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Resolves after `ms`, or as soon as `signal` aborts. */
export const sleepFor: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * For work that can afford to be slow, like the history import: a busy model is waited
 * out, longer each time, instead of costing the item it was asked about. The endpoint's
 * own estimate wins when it is longer, up to the longest wait. Still busy after the last
 * wait, stopped through `signal`, or any other failure, and the call fails as before.
 */
export function patient(llm: Llm, waitsMs: readonly number[], sleep: Sleep, signal?: AbortSignal): Llm {
  const longest = Math.max(0, ...waitsMs);
  return {
    get available() {
      return llm.available;
    },
    async complete(request) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await llm.complete(request);
        } catch (err) {
          const wait = waitsMs[attempt];
          if (!(err instanceof ModelBusyError) || wait === undefined || signal?.aborted) throw err;
          await sleep(Math.min(Math.max(wait, err.retryAfterMs ?? 0), longest), signal);
          if (signal?.aborted) throw err;
        }
      }
    },
  };
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
    if (BUSY_STATUSES.has(response.status)) throw new ModelBusyError(response.status, retryAfterMs(response.headers.get("retry-after")));
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
