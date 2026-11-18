package com.tripcraft.backend.rag.retrievers;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.external.SerpApiService;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.rag.Rank;
import com.tripcraft.backend.rag.RetrievalPlan;
import com.tripcraft.backend.rag.RetrievedDoc;
import com.tripcraft.backend.rag.RetrievalSource;
import com.tripcraft.backend.rag.Tokenizer;
import com.tripcraft.backend.rag.TtlCache;
import com.tripcraft.backend.rag.knowledge.KnowledgeStore;

/**
 * Knowledge retriever: bundled knowledge base first, web search only as a
 * fallback when the KB has nothing relevant for the question — the port of
 * {@code src/lib/rag/retrievers/knowledge.ts}.
 *
 * <p>The web leg is TTL-cached + single-flighted (via {@link TtlCache}), so a
 * burst of identical questions costs at most one SerpAPI call. SerpAPI being
 * out of quota simply yields {@code []} — the KB answer is returned as-is.
 */
@Component
public class KnowledgeRetriever {

    private static final Logger log = LoggerFactory.getLogger(KnowledgeRetriever.class);

    /** Below this hybrid score the KB answer is considered "no good match". */
    private static final double KB_STRONG = 0.3;
    private static final long WEB_TTL_MS = 10 * 60_000L;
    /** Web leg runs inside the 3s knowledge budget — never the 12s default. */
    private static final int WEB_SERP_TIMEOUT_MS = 2_500;

    private static final Pattern HTTP_URL = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);

    private final SerpApiService serp;

    public KnowledgeRetriever(SerpApiService serp) {
        this.serp = serp;
    }

    private record WebHit(String title, String url, String snippet) {
    }

    private List<WebHit> webSearch(String query) {
        if (query.trim().isEmpty() || !serp.available()) {
            return List.of();
        }
        String key = TtlCache.cacheKey("rag:web", Map.of("q",
                query.toLowerCase(java.util.Locale.ROOT).replaceAll("\\s+", " ").trim()));
        return TtlCache.cached(key, () -> {
            JsonNode data = serp.search(Map.of(
                    "engine", "google",
                    "q", query,
                    "num", 8), WEB_SERP_TIMEOUT_MS);
            List<WebHit> hits = new ArrayList<>();
            for (JsonNode r : Json.elements(data == null ? null : data.get("organic_results"))) {
                String title = textOrEmpty(r, "title").trim();
                String url = textOrEmpty(r, "link").trim();
                String snippet = textOrEmpty(r, "snippet").trim();
                if (title.isEmpty() || url.isEmpty() || !HTTP_URL.matcher(url).find()) {
                    continue;
                }
                hits.add(new WebHit(title, url, snippet));
                if (hits.size() >= 6) {
                    break;
                }
            }
            return hits;
        }, new TtlCache.Options(WEB_TTL_MS, null, false));
    }

    private static String textOrEmpty(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value != null && value.isTextual() ? value.asText() : "";
    }

    public List<RetrievedDoc> retrieve(RetrievalPlan plan) {
        String query = plan.knowledgeQuery() == null ? "" : plan.knowledgeQuery().trim();
        if (query.isEmpty()) {
            return List.of();
        }

        List<RetrievedDoc> kbDocs = new ArrayList<>();
        for (KnowledgeStore.KnowledgeHit hit : KnowledgeStore.search(query, 4)) {
            RetrievedDoc doc = RetrievedDoc.of(
                    "knowledge-" + hit.doc().id(),
                    RetrievalSource.KNOWLEDGE,
                    hit.doc().title(),
                    Tokenizer.clip(hit.doc().title() + ". " + hit.doc().text(), 700));
            doc.score(hit.score());
            doc.recency(1.0);
            doc.putMeta("category", hit.doc().category());
            doc.putMeta("origin", "TripCraft travel knowledge base");
            kbDocs.add(doc);
        }

        // KB missed, barely matched — or matched on topic while being ABOUT
        // ANOTHER PLACE ("India — visas" for a Japan question): a confident
        // wrong-entity hit would mis-ground the answer AND, without this check,
        // suppress the very search that could answer the question.
        List<String> entities = Tokenizer.entityTokens(query);
        RetrievedDoc top = kbDocs.isEmpty() ? null : kbDocs.get(0);
        // Mirror of rank's lexical gate: a KB doc the gate would drop must not
        // suppress the fallback either. Short questions keep rank's lenient
        // exception (they have nothing else to match on).
        double lexicalFloor = Tokenizer.queryTokens(query).size() <= 2
                ? 0 : Rank.KNOWLEDGE_LEXICAL_MIN;
        double bestLexical = 0;
        for (RetrievedDoc doc : kbDocs) {
            bestLexical = Math.max(bestLexical,
                    Tokenizer.overlapScore(query, doc.title() + " " + doc.text()));
        }
        boolean weak = top == null || (top.score() == null ? 0 : top.score()) < KB_STRONG
                || bestLexical < lexicalFloor;
        boolean wrongEntity = false;
        if (top != null && !entities.isEmpty()) {
            String hay = (top.title() + " " + top.text()).toLowerCase(java.util.Locale.ROOT);
            wrongEntity = true;
            for (String entity : entities) {
                if (hay.contains(entity)) {
                    wrongEntity = false;
                    break;
                }
            }
        }

        if (weak || wrongEntity) {
            try {
                List<WebHit> web = webSearch(query);
                if (!web.isEmpty()) {
                    List<RetrievedDoc> webDocs = new ArrayList<>();
                    for (int i = 0; i < web.size(); i++) {
                        WebHit w = web.get(i);
                        RetrievedDoc doc = RetrievedDoc.of("web-" + i, RetrievalSource.WEB,
                                w.title(), Tokenizer.clip(w.title() + ". " + w.snippet(), 500));
                        doc.score(0.5);
                        doc.recency(1.0);
                        doc.putMeta("url", w.url());
                        doc.putMeta("origin", "web search");
                        webDocs.add(doc);
                    }
                    // Web first: it is why we searched, so it must own the
                    // slice(0, 5) slots — wrong-entity KB entries can't crowd
                    // the real answer out.
                    List<RetrievedDoc> merged = new ArrayList<>(webDocs);
                    merged.addAll(kbDocs);
                    return merged.size() > 5 ? new ArrayList<>(merged.subList(0, 5)) : merged;
                }
            } catch (RuntimeException err) {
                log.warn("[rag:knowledge] web fallback failed: {}", messageOf(err));
            }
        }

        return kbDocs.size() > 5 ? new ArrayList<>(kbDocs.subList(0, 5)) : kbDocs;
    }

    private static String messageOf(Throwable err) {
        String message = err.getMessage();
        return message != null ? message : String.valueOf(err);
    }
}
