/**
 * Knowledge retriever: the bundled knowledge base (curated docs + ingested
 * Wikivoyage chunks) answers the question.
 *
 * There is no web-search leg any more — the paid provider is gone — so a
 * weak KB match widens the KB search instead of reaching for the open web.
 */

import { searchKnowledge } from "../knowledge/store";
import { KNOWLEDGE_LEXICAL_MIN } from "../rank";
import type { RetrievedDoc, RetrievalPlan } from "../types";
import { clip, entityTokens, overlapScore, queryTokens } from "../tokenize";

/** Below this hybrid score the KB answer is considered "no good match". */
const KB_STRONG = 0.3;

export async function retrieveKnowledge(plan: RetrievalPlan): Promise<RetrievedDoc[]> {
  const query = (plan.knowledgeQuery ?? "").trim();
  if (!query) return [];

  const kbDocs: RetrievedDoc[] = [];
  const hits = searchKnowledge(query, 4);
  for (const h of hits) {
    // Ingested Wikivoyage chunks carry url + city + fetchedAt; curated docs
    // fall back to the generic origin label.
    const ingested = h.doc.source === "wikivoyage";
    kbDocs.push({
      id: `knowledge-${h.doc.id}`,
      source: "knowledge",
      title: h.doc.title,
      text: clip(`${h.doc.title}. ${h.doc.text}`, 700),
      score: h.score,
      recency: 1,
      meta: ingested
        ? {
            category: h.doc.category,
            origin: `Wikivoyage travel guide${h.doc.city ? ` · ${h.doc.city}` : ""} · fetched ${h.doc.fetchedAt ?? "n/a"}`,
            url: h.doc.url ?? "",
          }
        : { category: h.doc.category, origin: "TripCraft travel knowledge base" },
    });
  }

  // The KB missed, barely matched — or matched on topic while being ABOUT ANOTHER
  // PLACE ("India — visas" for a Japan question). A confident wrong-entity hit
  // would mis-ground the answer.
  const entities = entityTokens(query);
  const top = kbDocs[0];
  // Mirror of rank's lexical gate: a KB doc the gate would drop must not
  // suppress the fallback either — otherwise rank empties the context the
  // retriever just declared good. Short questions keep rank's lenient
  // exception (they have nothing else to match on).
  const lexicalFloor = queryTokens(query).length <= 2 ? 0 : KNOWLEDGE_LEXICAL_MIN;
  const bestLexical = kbDocs.reduce(
    (best, d) => Math.max(best, overlapScore(query, `${d.title} ${d.text}`)),
    0
  );
  const weak = !top || (top.score ?? 0) < KB_STRONG || bestLexical < lexicalFloor;
  const wrongEntity =
    !!top &&
    entities.length > 0 &&
    !entities.some((e) => `${top.title} ${top.text}`.toLowerCase().includes(e));

  // No web-search provider is configured any more, so a weak KB match is
  // answered with what the knowledge base has — never with a wrong-entity
  // document dressed up as a confident hit.
  if (weak || wrongEntity) {
    const widened = searchKnowledge(query, 8);
    const widenedDocs: RetrievedDoc[] = widened
      .filter((h) => !kbDocs.some((d) => d.id === `knowledge-${h.doc.id}`))
      .map((h) => ({
        id: `knowledge-${h.doc.id}`,
        source: "knowledge",
        title: h.doc.title,
        text: clip(`${h.doc.title}. ${h.doc.text}`, 700),
        score: h.score,
        recency: 1,
        meta: {
          category: h.doc.category,
          origin:
            h.doc.source === "wikivoyage"
              ? `Wikivoyage travel guide${h.doc.city ? ` · ${h.doc.city}` : ""}`
              : "TripCraft travel knowledge base",
          url: h.doc.url ?? "",
        },
      }));
    return [...widenedDocs, ...kbDocs].slice(0, 5);
  }

  return kbDocs.slice(0, 5);
}
