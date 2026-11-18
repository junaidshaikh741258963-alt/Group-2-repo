/**
 * Error taxonomy + central JSON error responder for API routes.
 *
 * Usage in a route:
 *
 *   } catch (err) {
 *     return jsonError(err, "api/hotels POST");
 *   }
 *
 * - `AppError` (4xx) → its message is safe to show; logged at warn.
 * - Unknown errors (5xx) → generic message to the client, full detail in logs.
 */

import { log } from "./log";

export class AppError extends Error {
  constructor(
    message: string,
    public status = 500,
    public code = "internal",
    public meta?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, meta?: Record<string, unknown>) =>
  new AppError(message, 400, "bad_request", meta);

export const notFound = (message: string, meta?: Record<string, unknown>) =>
  new AppError(message, 404, "not_found", meta);

/** A provider failed after its fallbacks — the app should degrade, not crash. */
export const upstreamError = (message: string, meta?: Record<string, unknown>) =>
  new AppError(message, 502, "upstream_error", meta);

export function jsonError(err: unknown, where: string): Response {
  if (err instanceof AppError) {
    if (err.status >= 500) {
      log.error(`${where}: ${err.message}`, { code: err.code, ...err.meta });
    } else {
      log.warn(`${where}: ${err.message}`, { code: err.code, ...err.meta });
    }
    return Response.json({ error: err.message, code: err.code }, { status: err.status });
  }

  const detail = err instanceof Error ? err.message : String(err);
  log.error(`${where}: ${detail}`);
  return Response.json({ error: "Something went wrong", code: "internal" }, { status: 500 });
}
