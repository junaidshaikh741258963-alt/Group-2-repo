/**
 * Retriever registry — the single place to plug a new source in.
 *
 * Add a `RetrievalSource`, implement `Retriever`, register it here, and add it
 * to the router's PRIORITY list. Nothing else in the pipeline needs changes.
 */

import type { RetrievedDoc, RetrievalContext, RetrievalPlan, RetrievalSource } from "./types";
import { retrieveMemory } from "./retrievers/memory";
import { retrievePreferences } from "./retrievers/preferences";
import { retrieveKnowledge } from "./retrievers/knowledge";
import { retrieveLive } from "./retrievers/live";

export type Retriever = (
  ctx: RetrievalContext,
  plan: RetrievalPlan
) => Promise<RetrievedDoc[]> | RetrievedDoc[];

export const RETRIEVERS: Record<RetrievalSource, Retriever> = {
  memory: (ctx) => retrieveMemory(ctx),
  preferences: (ctx) => retrievePreferences(ctx),
  knowledge: (_ctx, plan) => retrieveKnowledge(plan),
  live: (_ctx, plan) => retrieveLive(plan),
  // "web" is produced inside the knowledge retriever as a fallback (it only
  // makes sense after the local knowledge base has already missed).
  web: async () => [],
};
