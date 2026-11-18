import { NextRequest } from "next/server";
import { retrieveForQuestion } from "@/lib/rag";
import { knowledgeCorpusSize } from "@/lib/rag/knowledge/store";
import type { ChatTurn, RetrievalContext, TripItemLite } from "@/lib/rag/types";
import { stripMetaBlocks, EMPTY_PROFILE, type TripProfile } from "@/lib/tripProfile";

export const runtime = "nodejs";

/**
 * Retrieval diagnostics: run the RAG pipeline without calling the LLM.
 *
 * POST { question, messages?, profile?, tripItems?, conversationId?, allowLive? }
 * → { plan, docs, contextBlock, sources, durationMs }
 *
 * Used to verify routing/grounding for different question types. `allowLive:false`
 * (default: true) skips the live/OSM legs so probing costs nothing.
 */

function asProfile(raw: unknown): TripProfile {
  if (!raw || typeof raw !== "object") return EMPTY_PROFILE;
  const p = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 160) : null);
  return {
    ...EMPTY_PROFILE,
    ...Object.fromEntries(Object.keys(EMPTY_PROFILE).map((k) => [k, str(p[k])])),
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const question = String(body?.question ?? "")
      .trim()
      .slice(0, 600);
    if (!question) {
      return Response.json({ error: "question required" }, { status: 400 });
    }

    const turns: ChatTurn[] = Array.isArray(body?.messages)
      ? body.messages
          .slice(-30)
          .map((m: { role?: string; content?: string }) => ({
            role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
            content: stripMetaBlocks(String(m.content ?? "")) || String(m.content ?? ""),
          }))
          .filter((t: ChatTurn) => t.content.trim())
      : [];

    const tripItems: TripItemLite[] = Array.isArray(body?.tripItems)
      ? body.tripItems
          .filter((i: unknown): i is Record<string, unknown> => Boolean(i) && typeof i === "object")
          .map((i: Record<string, unknown>) => ({
            name: String(i.name ?? "").slice(0, 120),
            category: typeof i.category === "string" ? i.category : undefined,
            price: typeof i.price === "string" ? i.price : undefined,
            detail: typeof i.detail === "string" ? i.detail : undefined,
            description: typeof i.description === "string" ? i.description : undefined,
            rating: typeof i.rating === "number" ? i.rating : undefined,
          }))
          .filter((i: TripItemLite) => i.name)
          .slice(0, 60)
      : [];

    const ctx: RetrievalContext = {
      question,
      turns,
      profile: asProfile(body?.profile),
      tripItems,
      conversationId:
        typeof body?.conversationId === "string" ? body.conversationId.slice(0, 64) : undefined,
      now: Date.now(),
    };

    const allowLive = body?.allowLive !== false;
    const outcome = await retrieveForQuestion(ctx, {
      excludeSources: allowLive ? [] : ["live"],
    });

    return Response.json({
      question,
      plan: outcome.plan,
      docs: outcome.docs.map((d) => ({
        id: d.id,
        source: d.source,
        title: d.title,
        text: d.text,
        score: Number((d.score ?? 0).toFixed(3)),
        lexical: Number((d.lexical ?? 0).toFixed(3)),
        meta: d.meta,
      })),
      contextBlock: outcome.contextBlock,
      sources: outcome.sources,
      durationMs: outcome.durationMs,
      knowledgeCorpusSize: knowledgeCorpusSize(),
    });
  } catch (err) {
    console.error("/api/rag error:", err);
    return Response.json({ error: "retrieval failed" }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({
    usage: "POST { question, messages?, profile?, tripItems?, conversationId?, allowLive? }",
    knowledgeCorpusSize: knowledgeCorpusSize(),
  });
}
