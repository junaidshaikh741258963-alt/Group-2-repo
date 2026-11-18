/**
 * Structured logger — the single logging entry point for server code.
 *
 * - Production: one JSON object per line (easily shipped to any log drain).
 * - Development: compact human-readable lines.
 * - Level via `LOG_LEVEL` (debug | info | warn | error); default debug in dev,
 *   info in production.
 *
 * Keep `meta` flat and serializable; never log API keys or user secrets.
 */

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogMeta = Record<string, unknown>;

function currentLevel(): Level {
  const raw = process.env.LOG_LEVEL;
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function emit(level: Level, msg: string, meta?: LogMeta): void {
  if (ORDER[level] < ORDER[currentLevel()]) return;

  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  if (process.env.NODE_ENV === "production") {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));
    return;
  }
  const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  sink(`[${level}] ${msg}${suffix}`);
}

export const log = {
  debug: (msg: string, meta?: LogMeta) => emit("debug", msg, meta),
  info: (msg: string, meta?: LogMeta) => emit("info", msg, meta),
  warn: (msg: string, meta?: LogMeta) => emit("warn", msg, meta),
  error: (msg: string, meta?: LogMeta) => emit("error", msg, meta),
};
