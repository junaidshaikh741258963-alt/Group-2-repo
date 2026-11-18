const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma3:4b";

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaOptions {
  temperature?: number;
  num_predict?: number;
  top_p?: number;
  top_k?: number;
  /**
   * Abort the WHOLE request — headers as well as generation. Callers pass
   * `AbortSignal.timeout(...)` to put a hard ceiling on a turn: without it a
   * cold model load (or a CPU grinding through an itinerary) stalls the chat
   * while the in-loop deadline checks never even get a chance to run.
   * When omitted the original 300s / 120s guards apply.
   */
  signal?: AbortSignal;
}

export async function ollamaChat(
  messages: OllamaMessage[],
  options: OllamaOptions = {}
): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // stream:false sends headers only when generation finishes — abort before
    // undici's 300s headers timeout so the caller can fall back to the hosted provider.
    signal: options.signal ?? AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.num_predict ?? 2048,
        top_p: options.top_p ?? 0.9,
        top_k: options.top_k ?? 40,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama error: ${res.status} - ${err}`);
  }

  const data = await res.json();
  return data.message?.content || "";
}

/**
 * Streaming variant of `ollamaChat`: yields content deltas as they are
 * generated (NDJSON frames from `/api/chat` with `stream:true`).
 * Lets the chat show the intro immediately instead of waiting out a local
 * model that may need a minute or two on CPU.
 */
export async function* ollamaChatStream(
  messages: OllamaMessage[],
  options: OllamaOptions = {}
): AsyncGenerator<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Headers arrive when streaming starts — but a cold model load can delay
    // them for tens of seconds, so the caller's signal (not the in-loop
    // deadline) is what actually caps the turn.
    signal: options.signal ?? AbortSignal.timeout(300_000),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: true,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.num_predict ?? 2048,
        top_p: options.top_p ?? 0.9,
        top_k: options.top_k ?? 40,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama error: ${res.status} - ${err}`);
  }
  if (!res.body) throw new Error("Ollama returned no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const frame = JSON.parse(trimmed) as { message?: { content?: string } };
        const piece = frame.message?.content;
        if (piece) yield piece;
      } catch {
        // partial/keep-alive frame — the next read completes it
      }
    }
  }
}

export async function ollamaGenerate(
  prompt: string,
  system?: string,
  options: OllamaOptions = {}
): Promise<string> {
  const messages: OllamaMessage[] = [];

  if (system) {
    messages.push({ role: "system", content: system });
  }
  messages.push({ role: "user", content: prompt });

  return ollamaChat(messages, options);
}

export async function ollamaGenerateJSON(
  prompt: string,
  system?: string,
  options: OllamaOptions = {}
): Promise<unknown> {
  const jsonSystem =
    (system || "") +
    "\n\nYou MUST respond with valid JSON only. No markdown, no explanation, just the JSON object.";

  const text = await ollamaGenerate(prompt, jsonSystem, {
    temperature: options.temperature ?? 0.3,
    num_predict: options.num_predict ?? 4096,
    ...options,
  });

  // Try to parse JSON, handling potential markdown code blocks
  const cleaned = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON from the response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error("Failed to parse JSON from Ollama response");
  }
}

export async function checkOllamaConnection(): Promise<{
  connected: boolean;
  model: string;
  available: boolean;
}> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { connected: false, model: OLLAMA_MODEL, available: false };

    const data = await res.json();
    const models = data.models || [];
    const available = models.some(
      (m: { name: string }) => m.name === OLLAMA_MODEL || m.name.startsWith(OLLAMA_MODEL)
    );

    return { connected: true, model: OLLAMA_MODEL, available };
  } catch {
    return { connected: false, model: OLLAMA_MODEL, available: false };
  }
}
