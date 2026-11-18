/**
 * Circuit breaker per external provider.
 *
 * States: closed (normal) → open (fail fast, serve fallbacks) → half-open
 * (single probe allowed) → closed again after a successful probe.
 *
 * This keeps one failing API from cascading: routes immediately fall back to
 * their next source instead of waiting on timeouts.
 */

import { config } from "./config";

type State = "closed" | "open" | "half-open";

interface Breaker {
  state: State;
  failures: number;
  openedAt: number;
  probing: boolean;
}

const breakers = new Map<string, Breaker>();

function get(name: string): Breaker {
  let b = breakers.get(name);
  if (!b) {
    b = { state: "closed", failures: 0, openedAt: 0, probing: false };
    breakers.set(name, b);
  }
  return b;
}

export class CircuitOpenError extends Error {
  constructor(public provider: string) {
    super(`circuit open for ${provider}`);
    this.name = "CircuitOpenError";
  }
}

export function canPass(name: string): boolean {
  const b = get(name);
  if (b.state === "closed") return true;
  const now = Date.now();
  if (b.state === "open" && now - b.openedAt >= config.breaker.cooldownMs) {
    b.state = "half-open";
    b.probing = false;
  }
  if (b.state === "half-open") {
    if (b.probing) return false;
    b.probing = true;
    return true;
  }
  return false;
}

export function recordSuccess(name: string): void {
  const b = get(name);
  b.failures = 0;
  b.state = "closed";
  b.probing = false;
}

export function recordFailure(name: string): void {
  const b = get(name);
  b.probing = false;
  if (b.state === "half-open") {
    trip(name);
    return;
  }
  b.failures += 1;
  if (b.failures >= config.breaker.failureThreshold) trip(name);
}

function trip(name: string): void {
  const b = get(name);
  b.state = "open";
  b.openedAt = Date.now();
  b.failures = 0;
  console.warn(`[breaker] ${name} circuit OPEN for ${config.breaker.cooldownMs}ms`);
}

export function breakerState(name: string): State | undefined {
  return get(name).state;
}

/** Test/diagnostic helper. */
export function resetBreaker(name?: string): void {
  if (name) breakers.delete(name);
  else breakers.clear();
}
