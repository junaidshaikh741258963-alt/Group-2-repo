/**
 * RAG orchestrator: route → retrieve (parallel, budgeted) → dedupe → rerank →
 * grounded context.
 *
 * - Fast path: stage-machine messages produce an empty plan with zero I/O.
 * - Every source runs behind a time budget so a slow upstream can never delay
 *   the chat answer beyond `OVERALL_BUDGET_MS`.
 * - The whole run is cached + single-flighted (`@/lib/cache`), so a burst
 *   of identical questions performs retrieval once.
 * - Fail-open: any error degrades to "no context", never to a failed chat.
 */

import { cached, cacheKey } from "@/lib/cache";
import { planRetrieval } from "./router";
import { RETRIEVERS } from "./registry";
import { knowledgeGateReason, rankCandidates, selectTop } from "./rank";
import { buildContext } from "./context";
import { emptyOutcome, type RagOutcome, type RetrievalContext, type RetrievedDoc } from "./types";

/**
 * Per-source budgets. The user waits on the slowest source, so live APIs get
 * 4s (their own Overpass sweep deadline is 3.5s) and local knowledge gets 3s.
 * The route allows 5s, leaving time to rank and build the context block.
 */
const OVERALL_BUDGET_MS = 4_000;
const KNOWLEDGE_BUDGET_MS = 3_000;
const RUN_TTL_MS = 60_000;
const RUN_STALE_MS = 5 * 60_000;

/** Resolve with `fallback` if `promise` is still pending after `ms`. */
function withBudget<T>(promise: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        console.warn(`[rag:${label}] failed:`, err instanceof Error ? err.message : err);
        resolve(fallback);
      }
    );
  });
}

function runKey(ctx: RetrievalContext): string {
  return cacheKey("rag:run", {
    q: ctx.question.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300),
    conv: ctx.conversationId ?? "",
    // Cheap structural fingerprint of the history (contents, not just count).
    turns: ctx.turns
      .map((t) => `${t.role[0]}${t.content.length}`)
      .join(",")
      .slice(0, 500),
    profile: JSON.stringify(ctx.profile).slice(0, 800),
    board: ctx.tripItems
      .map((i) => i.name)
      .join("|")
      .slice(0, 300),
  });
}

export interface RetrieveOptions {
  /** Drop these sources from the plan (used by diagnostics to skip live APIs). */
  excludeSources?: Array<import("./types").RetrievalSource>;
}

export async function retrieveForQuestion(
  ctx: RetrievalContext,
  opts: RetrieveOptions = {}
): Promise<RagOutcome> {
  const started = Date.now();
  const basePlan = planRetrieval(ctx);
  const plan = opts.excludeSources?.length
    ? { ...basePlan, sources: basePlan.sources.filter((s) => !opts.excludeSources!.includes(s)) }
    : basePlan;
  if (plan.sources.length === 0) return emptyOutcome(plan, 0);

  try {
    const outcome = await cached<RagOutcome>(
      runKey(ctx) + (opts.excludeSources?.length ? `|x=${opts.excludeSources.join(",")}` : ""),
      async () => {
        // Collect per-source results as they land instead of awaiting the
        // slowest one. A dead live API used to make the route's outer deadline
        // discard a perfectly good knowledge hit; now the answer is built from
        // whatever is ready by the deadline. Still-running retrievers warm
        // their caches for the next turn.
        const results: RetrievedDoc[][] = plan.sources.map(() => []);
        const pending = plan.sources.map((source, i) => {
          const budget = source === "knowledge" ? KNOWLEDGE_BUDGET_MS : OVERALL_BUDGET_MS;
          // `.then(…)` wraps the CALL itself: a retriever that throws
          // synchronously becomes a rejected promise (and then an empty
          // array) instead of blowing up the whole `Promise.all` — one bad
          // source must never take out the other three.
          return withBudget(
            Promise.resolve()
              .then(() => RETRIEVERS[source](ctx, plan))
              .catch(() => [] as RetrievedDoc[]),
            budget,
            [] as RetrievedDoc[],
            source
          ).then((docs) => {
            results[i] = docs;
          });
        });
        await Promise.race([
          Promise.all(pending),
          new Promise<void>((resolve) => setTimeout(resolve, OVERALL_BUDGET_MS)),
        ]);
        // Dedupe + rerank FIRST, then gate, then allocate context slots:
        // selecting before the gate let a to-be-dropped doc occupy a slot that
        // a legitimate doc could then never reach.
        const ranked = rankCandidates(results.flat(), ctx.question);
        // Gate applies to the *context pool* only — outcome.docs keeps every
        // reranked doc (gated ones tagged with the reason) for diagnostics.
        const gateReasons = ranked.map((d) =>
          knowledgeGateReason(d, ctx.question, {
            allowEntityMatch: plan.groundedRecommendation === true,
          })
        );
        const eligible = ranked.filter((_, i) => gateReasons[i] === null);
        const selected = selectTop(eligible);
        const { contextBlock, sources } = buildContext(selected, plan);
        const docs = ranked.map((d, i) => {
          const reason = gateReasons[i];
          return reason ? { ...d, meta: { ...d.meta, gated: reason } } : d;
        });
        return { plan, docs, contextBlock, sources, durationMs: 0 };
      },
      { ttlMs: RUN_TTL_MS, staleMs: RUN_STALE_MS }
    );
    return { ...outcome, durationMs: Date.now() - started };
  } catch (err) {
    console.warn("[rag] run failed:", err instanceof Error ? err.message : err);
    return emptyOutcome(plan, Date.now() - started);
  }
}

export { planRetrieval };
