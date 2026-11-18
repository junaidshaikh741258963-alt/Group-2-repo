/**
 * Chat LLM client — one OpenAI-compatible wire format for every provider.
 *
 * Configure it in `.env.local` with three values:
 *
 *   API_KEY=gsk_...                                  # Groq, Gemini, …
 *   MODEL_NAME=llama-3.3-70b-versatile               # any model the provider serves
 *   BASE_URL=https://api.groq.com/openai/v1          # optional; inferred when omitted
 *
 * Everything the app needs (streaming, JSON mode, retries, rate-limit hints)
 * is provider-agnostic. Switching from Groq to Gemini — or to any other
 * OpenAI-compatible host — is an env edit, no code change:
 *
 *   Groq     BASE_URL=https://api.groq.com/openai/v1
 *            MODEL_NAME=llama-3.3-70b-versatile
 *   Gemini   BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
 *            MODEL_NAME=gemini-2.5-flash
 *   OpenAI   BASE_URL=https://api.openai.com/v1
 *            MODEL_NAME=gpt-4o-mini
 *
 * Legacy names (`GEMINI_API_KEY`, `GEMINI_MODEL`) still work, so existing
 * deployments keep running unchanged.
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type LlmProvider = "gemini" | "groq" | "openai" | "openai-compatible";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Configured in `.env.local` — inferred when omitted (see `inferBaseUrl`). */
export const DEFAULT_LLM_MODEL = "gemini-3.5-flash-lite";

/** Backwards-compatible alias for code that imported the old name. */
export const DEFAULT_GEMINI_MODEL = DEFAULT_LLM_MODEL;

export interface LlmConfig {
  apiKey: string;
  model: string;
  /** Normalised base URL, e.g. `https://api.groq.com/openai/v1`. */
  baseUrl: string;
  /** Fully-qualified chat-completions URL. */
  endpoint: string;
  provider: LlmProvider;
}

function pick(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function completionsEndpoint(baseUrl: string): string {
  const base = stripTrailingSlashes(baseUrl);
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function providerForUrl(baseUrl: string): LlmProvider {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // Not a parseable URL — fall through with the raw string.
  }
  if (host.includes("generativelanguage.googleapis.com")) return "gemini";
  if (host.includes("api.groq.com")) return "groq";
  if (host === "api.openai.com") return "openai";
  return "openai-compatible";
}

/**
 * When `BASE_URL` is not set, infer the host from the credential / model so a
 * Groq key never gets sent to Google (and vice versa).
 */
function inferBaseUrl(apiKey: string, model: string): string {
  if (/^gsk_/i.test(apiKey)) return GROQ_BASE_URL;
  if (/^sk-(?:proj-)?/i.test(apiKey) && !/^sk-or-/i.test(apiKey)) return OPENAI_BASE_URL;
  if (/^gemini/i.test(model)) return GEMINI_BASE_URL;
  if (/^(?:AIza|AQ\.)/.test(apiKey)) return GEMINI_BASE_URL;
  // Cosmetic default for custom gateways; the old behaviour was Gemini.
  return GEMINI_BASE_URL;
}

/** Sensible model per provider when `MODEL_NAME` is omitted. */
const DEFAULT_MODEL_BY_PROVIDER: Record<LlmProvider, string> = {
  gemini: DEFAULT_LLM_MODEL,
  groq: "llama-3.3-70b-versatile",
  openai: "gpt-4o-mini",
  "openai-compatible": DEFAULT_LLM_MODEL,
};

/** Read and normalise the configuration, or `null` when no key is set. */
export function readLlmConfig(): LlmConfig | null {
  // Uppercase is the documented form; lowercase is accepted so a `.env` copied
  // from the issue/README as `api_key=…` still works.
  const genericKey = pick(process.env.API_KEY, process.env.api_key, process.env.AI_API_KEY);
  const legacyKey = process.env.GEMINI_API_KEY?.trim();
  const apiKey = genericKey ?? legacyKey;
  if (!apiKey) return null;

  const explicitModel =
    pick(process.env.MODEL_NAME, process.env.model_name, process.env.AI_MODEL) ??
    (genericKey ? undefined : pick(process.env.GEMINI_MODEL));

  const explicitBase = pick(process.env.BASE_URL, process.env.base_url, process.env.AI_BASE_URL);
  const baseUrl = stripTrailingSlashes(explicitBase ?? inferBaseUrl(apiKey, explicitModel ?? ""));
  const provider = providerForUrl(baseUrl);

  return {
    apiKey,
    model: explicitModel ?? DEFAULT_MODEL_BY_PROVIDER[provider],
    baseUrl,
    endpoint: completionsEndpoint(baseUrl),
    provider,
  };
}

/** Same as `readLlmConfig`, but throws a message that says what to fix. */
export function getLlmConfig(): LlmConfig {
  const config = readLlmConfig();
  if (!config) {
    throw new Error(
      "No AI provider configured — set API_KEY (plus MODEL_NAME and optionally BASE_URL) in .env.local"
    );
  }
  return config;
}

/** True when a hosted provider is configured; false means Ollama / keyless mode. */
export function hasLlmConfig(): boolean {
  return readLlmConfig() !== null;
}

/** Human-readable provider/model pair, e.g. `groq/llama-3.3-70b-versatile`. */
export function llmProviderLabel(): string {
  const config = readLlmConfig();
  return config ? `${config.provider}/${config.model}` : "ollama";
}

interface RequestOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask for exactly one JSON object (provider JSON mode). */
  json?: boolean;
  /**
   * How much the model thinks before answering. Sent to Gemini by default
   * ("low" keeps chat snappy) and only sent elsewhere when set explicitly —
   * some providers reject the parameter for non-reasoning models.
   */
  reasoningEffort?: "low" | "medium" | "high";
}

const DEFAULT_EFFORT: NonNullable<RequestOptions["reasoningEffort"]> = "low";

/** Gemini bills thinking tokens against `max_tokens`; keep room for the answer. */
const GEMINI_TOKEN_HEADROOM = 768;

const CONNECT_TIMEOUT_MS = 90_000;
const STREAM_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;

function buildBody(
  config: LlmConfig,
  messages: LlmMessage[],
  options: RequestOptions,
  stream: boolean
): string {
  const maxTokens =
    (options.maxTokens ?? 2048) + (config.provider === "gemini" ? GEMINI_TOKEN_HEADROOM : 0);

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: maxTokens,
    ...(options.json ? { response_format: { type: "json_object" } } : {}),
    stream,
  };

  if (config.provider === "gemini" || options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort ?? DEFAULT_EFFORT;
  }

  return JSON.stringify(body);
}

function requestHeaders(config: LlmConfig): Record<string, string> {
  // Content-Length is set by fetch from the body itself.
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Closing/erroring an already-finished controller must never mask the cause. */
function safeClose(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    /* already closed */
  }
}

function safeError(controller: ReadableStreamDefaultController<Uint8Array>, error: unknown): void {
  try {
    controller.error(error);
  } catch {
    /* already closed */
  }
}

/** Never stall the chat longer than this, whatever the server hint says. */
const HINTED_WAIT_CAP_MS = 10_000;

/**
 * A 429 body often states exactly when the quota window resets
 * ("…try again in 6.21"). Honouring that turns a spike into a short pause
 * before a successful retry, instead of burning every attempt in the window.
 */
function hintedRetryDelayMs(text: string): number | null {
  const m =
    /try again in (\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i.exec(text) ??
    /retry after (\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i.exec(text);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] ?? "s").toLowerCase();
  const seconds = unit === "ms" ? value / 1000 : value;
  return Math.min(Math.ceil(seconds * 1000) + 250, HINTED_WAIT_CAP_MS);
}

function providerError(config: LlmConfig, status: number, text: string): Error {
  return new Error(`${config.provider} error ${status}: ${text.slice(0, 400)}`);
}

export async function llmChat(
  messages: LlmMessage[],
  options: RequestOptions = {}
): Promise<string> {
  const config = getLlmConfig();
  const body = buildBody(config, messages, options, false);

  let lastError: Error = new Error(`${config.provider} request failed`);
  // Delay for the NEXT attempt. Starts as fixed backoff (800ms, then 1600ms)
  // but a 429 with a "try again in …" hint overrides it.
  let nextDelayMs = 800;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(nextDelayMs);
    nextDelayMs = 800 * (attempt + 1);

    let res: Response;
    try {
      res = await fetch(config.endpoint, {
        method: "POST",
        headers: requestHeaders(config),
        body,
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue; // network error → retry
    }

    const text = await res.text();

    if (res.status === 429 || res.status === 503) {
      lastError = providerError(config, res.status, text);
      if (res.status === 429) nextDelayMs = hintedRetryDelayMs(text) ?? nextDelayMs;
      continue; // rate limit / overloaded → retry after the delay above
    }

    if (!res.ok) throw providerError(config, res.status, text);

    try {
      const data = JSON.parse(text);
      return data.choices?.[0]?.message?.content || "";
    } catch {
      throw new Error(`${config.provider} returned invalid JSON: ${text.slice(0, 200)}`);
    }
  }

  throw lastError;
}

export function llmChatStream(
  messages: LlmMessage[],
  options: RequestOptions = {}
): ReadableStream<Uint8Array> {
  const config = getLlmConfig();
  const body = buildBody(config, messages, options, true);

  const encoder = new TextEncoder();

  /** Why the most recent attempt gave up — surfaced if every retry fails. */
  let lastReason = "no response";
  let nextDelayMs = 800;

  const runOnce = (
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<"done" | "retry"> =>
    new Promise((resolve) => {
      let started = false;
      let settled = false;
      const settle = (result: "done" | "retry") => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      fetch(config.endpoint, {
        method: "POST",
        headers: requestHeaders(config),
        body,
        // Total ceiling for the streamed reply. Retries only ever happen
        // before the first delta, so an aborted in-flight stream ends the turn.
        signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
      })
        .then(async (res) => {
          const sc = res.status;

          if (sc === 429 || sc === 503) {
            const errText = await res.text().catch(() => "");
            lastReason = `HTTP ${sc}${errText ? ` ${errText.slice(0, 240)}` : ""}`;
            if (sc === 429) nextDelayMs = hintedRetryDelayMs(errText) ?? nextDelayMs;
            settle("retry");
            return;
          }

          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            safeError(controller, providerError(config, sc, errText));
            settle("done");
            return;
          }

          if (!res.body) {
            lastReason = "empty response body";
            settle("retry");
            return;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              started = true;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const payload = trimmed.slice(5).trim();
                if (!payload || payload === "[DONE]") continue;
                try {
                  const json = JSON.parse(payload);
                  const delta = json.choices?.[0]?.delta;
                  if (typeof delta?.content === "string" && delta.content) {
                    controller.enqueue(encoder.encode(delta.content));
                  }
                } catch {
                  // ignore malformed SSE lines / keep-alives
                }
              }
            }
            settle("done");
            safeClose(controller);
          } catch (err) {
            if (!started) {
              lastReason = `stream: ${err instanceof Error ? err.message : String(err)}`;
              settle("retry");
            } else {
              settle("done");
              safeError(controller, err);
            }
          }
        })
        .catch((err) => {
          if (!started) {
            lastReason = `transport: ${err instanceof Error ? err.message : String(err)}`;
            settle("retry");
          } else {
            settle("done");
            safeError(controller, err);
          }
        });
    });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(nextDelayMs);
        // Reset to the fixed backoff first; runOnce overrides it below only
        // when the response is a 429 whose body carries a retry hint.
        nextDelayMs = 800 * (attempt + 1);
        const result = await runOnce(controller);
        if (result === "done") return;
        if (attempt === MAX_ATTEMPTS - 1) {
          safeError(
            controller,
            new Error(`${config.provider} unavailable after retries (${lastReason})`)
          );
        }
      }
    },
    cancel() {
      // downstream no longer interested; the fetch signal ends the socket
    },
  });
}
