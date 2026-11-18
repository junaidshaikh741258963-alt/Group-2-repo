package com.tripcraft.backend.api;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import jakarta.servlet.http.HttpServletRequest;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.rag.ChatTurn;
import com.tripcraft.backend.rag.RagOutcome;
import com.tripcraft.backend.rag.RagService;
import com.tripcraft.backend.rag.RetrievalContext;
import com.tripcraft.backend.rag.RetrievalSource;
import com.tripcraft.backend.rag.RetrievedDoc;
import com.tripcraft.backend.rag.SourceRef;
import com.tripcraft.backend.rag.TripItemLite;
import com.tripcraft.backend.rag.TripProfile;
import com.tripcraft.backend.rag.knowledge.KnowledgeStore;

/**
 * Retrieval diagnostics endpoint — the port of
 * {@code src/app/api/rag/route.ts}: run the RAG pipeline without calling the
 * LLM.
 *
 * <pre>
 * POST { question, messages?, profile?, tripItems?, conversationId?, allowLive? }
 * → { question, plan, docs, contextBlock, sources, durationMs, knowledgeCorpusSize }
 * </pre>
 *
 * <p>Used to verify routing/grounding for different question types.
 * {@code allowLive:false} (default: true) skips SerpAPI/OSM legs so probing
 * costs nothing.
 */
@RestController
@RequestMapping("/api/rag")
public class RagController {

    private static final Logger log = LoggerFactory.getLogger(RagController.class);

    private static final String REC_OPEN = "<recommendations>";
    private static final String REC_CLOSE = "</recommendations>";
    private static final String PLANNING_OPEN = "<planning>";

    /** TS {@code /```(?:json)?\s*$/i} — {@code \z} is JS's non-multiline {@code $}. */
    private static final Pattern TRAILING_FENCE =
            Pattern.compile("```(?:json)?\\s*\\z", Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CHARACTER_CLASS);

    private final RagService rag;

    public RagController(RagService rag) {
        this.rag = rag;
    }

    @GetMapping
    public ObjectNode usage() {
        ObjectNode node = Json.obj();
        node.put("usage", "POST { question, messages?, profile?, tripItems?, conversationId?, allowLive? }");
        node.put("knowledgeCorpusSize", KnowledgeStore.corpusSize());
        return node;
    }

    @PostMapping
    public ResponseEntity<ObjectNode> post(HttpServletRequest request) {
        try {
            // Read the raw body exactly like `await req.json()` does — the raw
            // bytes are UTF-8 (RFC 8259), never the ISO-8859-1 a String
            // converter would decode without an explicit charset.
            String raw;
            try (InputStream in = request.getInputStream()) {
                raw = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
            // A missing/blank body makes `req.json()` reject → 500, not 400.
            if (raw.isBlank()) {
                throw new IllegalArgumentException("empty body");
            }
            JsonNode body = Json.M.readTree(raw);
            if (body == null || body.isMissingNode()) {
                // A `null` root parses to nothing: TS then reads `body?.x`
                // (undefined for every field) → 400 "question required".
                body = NullNode.getInstance();
            }

            String question = clip(jsTrim(jsString(at(body, "question"))), 600);
            if (question.isEmpty()) {
                return ResponseEntity.badRequest().body(error("question required"));
            }

            List<ChatTurn> turns = parseMessages(at(body, "messages"));
            List<TripItemLite> tripItems = parseTripItems(at(body, "tripItems"));

            JsonNode conversationIdNode = at(body, "conversationId");
            RetrievalContext ctx = RetrievalContext.builder()
                    .question(question)
                    .turns(turns)
                    .profile(asProfile(at(body, "profile")))
                    .tripItems(tripItems)
                    .conversationId(conversationIdNode != null && conversationIdNode.isTextual()
                            ? clip(conversationIdNode.asText(), 64) : null)
                    .now(System.currentTimeMillis())
                    .build();

            // `allowLive !== false` — only the literal boolean false disables.
            JsonNode allowLiveNode = at(body, "allowLive");
            boolean allowLive = !(allowLiveNode != null && allowLiveNode.isBoolean() && !allowLiveNode.asBoolean());
            List<RetrievalSource> excludeSources =
                    allowLive ? List.of() : List.of(RetrievalSource.LIVE);

            RagOutcome outcome = rag.retrieveForQuestion(ctx, excludeSources);

            ObjectNode res = Json.obj();
            res.put("question", question);
            res.set("plan", outcome.plan().toJson());
            ArrayNode docs = res.putArray("docs");
            for (RetrievedDoc doc : outcome.docs()) {
                docs.add(doc.toJson());
            }
            res.put("contextBlock", outcome.contextBlock());
            ArrayNode sources = res.putArray("sources");
            for (SourceRef source : outcome.sources()) {
                sources.add(source.toJson());
            }
            res.put("durationMs", outcome.durationMs());
            res.put("knowledgeCorpusSize", KnowledgeStore.corpusSize());
            return ResponseEntity.ok(res);
        } catch (Exception err) {
            log.error("/api/rag error:", err);
            return ResponseEntity.internalServerError().body(error("retrieval failed"));
        }
    }

    // ------------------------------------------------------------- request

    private static List<ChatTurn> parseMessages(JsonNode messages) {
        List<ChatTurn> turns = new ArrayList<>();
        if (messages == null || !messages.isArray()) {
            return turns;
        }
        int from = Math.max(0, messages.size() - 30);
        for (int i = from; i < messages.size(); i++) {
            JsonNode m = messages.get(i);
            if (m == null || m.isNull()) {
                // TS reads `m.role` on a null element → TypeError → 500.
                throw new IllegalArgumentException("message must be an object");
            }
            String rawContent = jsString(at(m, "content"));
            String stripped = stripMetaBlocks(rawContent);
            String content = stripped.isEmpty() ? rawContent : stripped;
            if (jsTrim(content).isEmpty()) {
                continue;
            }
            String role = "assistant".equals(jsString(at(m, "role"))) ? "assistant" : "user";
            turns.add(new ChatTurn(role, content));
        }
        return turns;
    }

    private static List<TripItemLite> parseTripItems(JsonNode items) {
        List<TripItemLite> tripItems = new ArrayList<>();
        if (items == null || !items.isArray()) {
            return tripItems;
        }
        for (JsonNode item : items) {
            if (item == null || !item.isObject()) {
                continue;
            }
            String name = clip(jsString(at(item, "name")), 120);
            if (name.isEmpty()) {
                continue;
            }
            tripItems.add(new TripItemLite(name, stringOrNull(at(item, "category")),
                    stringOrNull(at(item, "price")), stringOrNull(at(item, "detail")),
                    stringOrNull(at(item, "description")), numberOrNull(at(item, "rating"))));
            if (tripItems.size() >= 60) {
                break;
            }
        }
        return tripItems;
    }

    /** TS {@code asProfile}: every {@code EMPTY_PROFILE} key, trimmed + clipped. */
    private static TripProfile asProfile(JsonNode raw) {
        if (raw == null || !raw.isObject()) {
            return TripProfile.empty();
        }
        Map<String, String> values = new LinkedHashMap<>();
        for (String field : TripProfile.FIELDS) {
            JsonNode value = at(raw, field);
            if (value == null || !value.isTextual()) {
                values.put(field, null);
                continue;
            }
            String trimmed = jsTrim(value.asText());
            values.put(field, trimmed.isEmpty() ? null : clip(trimmed, 160));
        }
        return TripProfile.of(values);
    }

    private static String stringOrNull(JsonNode node) {
        return node != null && node.isTextual() ? node.asText() : null;
    }

    private static Double numberOrNull(JsonNode node) {
        return node != null && node.isNumber() ? node.asDouble() : null;
    }

    private static JsonNode at(JsonNode node, String field) {
        return node == null ? null : node.get(field);
    }

    private static ObjectNode error(String message) {
        ObjectNode node = Json.obj();
        node.put("error", message);
        return node;
    }

    // -------------------------------------------------------------- strips

    /**
     * The port of {@code stripMetaBlocks} (tripProfile.ts): hide
     * {@code <recommendations>} blocks, cut at the first {@code <planning>}
     * tag, drop a trailing code fence.
     */
    static String stripMetaBlocks(String content) {
        String text = stripRecommendations(content);
        int open = text.indexOf(PLANNING_OPEN);
        if (open != -1) {
            text = text.substring(0, open);
        }
        return jsTrimEnd(TRAILING_FENCE.matcher(text).replaceAll(""));
    }

    /** TS {@code splitRecommendations().text} — removes closed blocks, hides an open one. */
    private static String stripRecommendations(String content) {
        int firstOpen = content.indexOf(REC_OPEN);
        if (firstOpen == -1) {
            return content;
        }
        // Hide a block that is still streaming in (open tag with no close yet).
        int cutAt = content.length();
        for (int i = firstOpen; i != -1; i = content.indexOf(REC_OPEN, i + 1)) {
            if (content.indexOf(REC_CLOSE, i) == -1) {
                cutAt = i;
                break;
            }
        }
        StringBuilder text = new StringBuilder();
        int cursor = 0;
        int search = 0;
        while (true) {
            int open = content.indexOf(REC_OPEN, search);
            if (open == -1 || open >= cutAt) {
                break;
            }
            int close = content.indexOf(REC_CLOSE, open);
            if (close == -1) {
                break;
            }
            text.append(content, cursor, open);
            cursor = close + REC_CLOSE.length();
            search = cursor;
        }
        if (cursor < cutAt) {
            text.append(content, cursor, cutAt);
        }
        return jsTrimEnd(TRAILING_FENCE.matcher(text).replaceAll(""));
    }

    // ------------------------------------------------------------ JS string

    /** JS {@code String(value ?? "")} for a request field. */
    private static String jsString(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return "";
        }
        return jsStringDeep(node);
    }

    /** JS {@code String(value)} — arrays join with {@code ,}, objects stringify plainly. */
    private static String jsStringDeep(JsonNode node) {
        if (node == null || node.isMissingNode()) {
            return "";
        }
        if (node.isNull()) {
            return "null";
        }
        if (node.isTextual()) {
            return node.asText();
        }
        if (node.isArray()) {
            StringBuilder joined = new StringBuilder();
            for (int i = 0; i < node.size(); i++) {
                if (i > 0) {
                    joined.append(',');
                }
                joined.append(jsStringDeep(node.get(i)));
            }
            return joined.toString();
        }
        if (node.isObject()) {
            return "[object Object]";
        }
        return node.asText();
    }

    /** JS {@code s.trim()} — whitespace per Unicode plus the BOM JS counts as space. */
    private static String jsTrim(String value) {
        int start = 0;
        int end = value.length();
        while (start < end && jsWhitespace(value.charAt(start))) {
            start++;
        }
        while (end > start && jsWhitespace(value.charAt(end - 1))) {
            end--;
        }
        return value.substring(start, end);
    }

    /** JS {@code s.trimEnd()}. */
    private static String jsTrimEnd(String value) {
        int end = value.length();
        while (end > 0 && jsWhitespace(value.charAt(end - 1))) {
            end--;
        }
        return value.substring(0, end);
    }

    private static boolean jsWhitespace(char c) {
        return Character.isWhitespace(c) || Character.isSpaceChar(c) || c == '\ufeff';
    }

    /** TS {@code s.slice(0, max)} — Java chars are UTF-16 units, like JS strings. */
    private static String clip(String value, int max) {
        return value.length() > max ? value.substring(0, max) : value;
    }
}
