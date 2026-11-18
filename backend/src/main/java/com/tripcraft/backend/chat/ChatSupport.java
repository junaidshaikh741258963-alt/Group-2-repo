package com.tripcraft.backend.chat;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.UnaryOperator;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.chat.AiPrompt.HistoryTurn;
import com.tripcraft.backend.chat.AiPrompt.ShownPlace;
import com.tripcraft.backend.chat.AiSchema.AiReply;
import com.tripcraft.backend.config.EnvFile;
import com.tripcraft.backend.external.GroqService;
import com.tripcraft.backend.infra.Json;
import com.tripcraft.backend.rag.ChatTurn;
import com.tripcraft.backend.rag.ContextBuilder;
import com.tripcraft.backend.rag.RagExec;
import com.tripcraft.backend.rag.RagOutcome;
import com.tripcraft.backend.rag.RagService;
import com.tripcraft.backend.rag.RetrievalContext;
import com.tripcraft.backend.rag.SourceRef;
import com.tripcraft.backend.rag.TripItemLite;

/**
 * Request-side and prompt-side half of the structured chat route — the port of
 * the helpers in {@code src/app/api/chat/route.ts} that run BEFORE the model
 * is called: untrusted-body parsing, the verbatim history window, intent
 * classification, budgeted retrieval, the system prompt assembly and the
 * per-turn policy closure ({@code finalize}).
 *
 * <p>{@link #parse} returns {@code null} when the transcript is empty, which
 * the controller turns into the TS's 400 {@code {"error":"Messages required"}}
 * response.
 */
@Service
public class ChatSupport {

    private static final Logger log = LoggerFactory.getLogger(ChatSupport.class);

    /** Hard parse ceiling (defensive) — TS {@code MAX_HISTORY}. */
    static final int MAX_HISTORY = 200;
    /** Turns sent to the model verbatim — TS {@code RECENT_TURNS}. */
    static final int RECENT_TURNS = 16;
    /** Combined ceiling of that verbatim window — TS {@code MAX_HISTORY_CHARS}. */
    static final int MAX_HISTORY_CHARS = 6_000;
    /** Per-turn ceiling once sanitised — TS {@code TEXT_CLIP}. */
    static final int TEXT_CLIP = 2_000;

    /**
     * RAG for this turn may never delay the answer past this — the TS races
     * {@code retrieveForQuestion} against a {@code setTimeout(4500)} and takes
     * "no extra context" when the timeout wins.
     */
    private static final long RETRIEVAL_BUDGET_MS = 4_500;

    /** The final nudge that keeps the model on the JSON contract — TS {@code USER_MESSAGE}. */
    static final String USER_MESSAGE = "Respond now with the JSON object only.";

    /** TS {@code /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g}. */
    private static final Pattern CONTROL_CHARS =
            Pattern.compile("[\\x{0}-\\x{8}\\x{B}\\x{C}\\x{E}-\\x{1F}\\x{7F}]");
    /** TS {@code /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g}. */
    private static final Pattern INVISIBLE_CHARS =
            Pattern.compile("[\\x{200B}-\\x{200F}\\x{202A}-\\x{202E}\\x{2060}-\\x{2064}\\x{FEFF}]");
    /** TS {@code /\r\n?/g → "\n"}. */
    private static final Pattern CRLF = Pattern.compile("\\r\\n?");
    /** TS {@code /\b429\b|rate limit/i}. */
    private static final Pattern RATE_LIMITED = Pattern.compile("\\b429\\b|rate limit",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);

    private final RagService rag;

    public ChatSupport(RagService rag) {
        this.rag = rag;
    }

    // --------------------------------------------------------------- types

    /**
     * The validated request body: everything one turn needs, already sanitised
     * exactly like the TS helper functions do before the model is called.
     */
    public record Parsed(List<HistoryTurn> transcript, TripProfile profile, String plan,
            boolean planHasItinerary, List<ShownPlace> shownPlaces, List<TripItemLite> tripItems,
            String question, String conversationId) {
    }

    /**
     * One prepared turn: the classified intent, the exact message list for the
     * provider (system + verbatim window + USER_MESSAGE) and the TS
     * {@code finalize} closure — turn policy + safety disclaimer + sources
     * footer, applied to every reply before it ships.
     */
    public record Turn(AiIntent.TurnIntent intent, List<GroqService.Message> messages,
            UnaryOperator<AiReply> finisher) {
    }

    /** {@code readPlan} result — the plan currently on the table. */
    private record Plan(String summary, boolean hasItinerary) {

        static final Plan EMPTY = new Plan("", false);
    }

    /** {@code retrieveContext} result — grounded system block + visible sources. */
    record Retrieved(String contextBlock, List<SourceRef> sources) {
    }

    private static final Retrieved NO_CONTEXT = new Retrieved("", List.of());

    // --------------------------------------------------------------- parse

    /**
     * Port of the request helpers in the TS route ({@code asHistory},
     * {@code asProfile}, {@code readPlan}, {@code asShownPlaces},
     * {@code asTripItems}, {@code lastUserQuestion}). Returns {@code null}
     * when the transcript is empty — the controller answers that with the
     * TS's 400 {@code {"error":"Messages required"}}.
     */
    public Parsed parse(JsonNode body) {
        List<HistoryTurn> transcript = asHistory(at(body, "messages"));
        if (transcript.isEmpty()) {
            return null;
        }
        TripProfile profile = asProfile(at(body, "profile"));
        Plan plan = readPlan(at(body, "plan"));
        List<ShownPlace> shownPlaces = asShownPlaces(at(body, "shownPlaces"));
        List<TripItemLite> tripItems = asTripItems(at(body, "tripItems"));
        String question = lastUserQuestion(transcript);
        JsonNode conversationIdNode = at(body, "conversationId");
        String conversationId = conversationIdNode != null && conversationIdNode.isTextual()
                ? Js.slice(conversationIdNode.asText(), 0, 64) : null;
        return new Parsed(transcript, profile, plan.summary(), plan.hasItinerary(),
                shownPlaces, tripItems, question, conversationId);
    }

    /**
     * Sanitise untrusted chat text before it becomes a model message: strips
     * control/invisible characters, normalises newlines and trims. The wording
     * itself is left alone — instruction-shaped text is handled by the
     * prompt's untrusted-content rule rather than by mangling what the user
     * typed.
     */
    static String sanitizeUserText(String raw) {
        String text = CONTROL_CHARS.matcher(raw).replaceAll("");
        text = INVISIBLE_CHARS.matcher(text).replaceAll("");
        text = CRLF.matcher(text).replaceAll("\n");
        return Js.trim(text);
    }

    /** TS {@code asHistory} — never truncate from the tail: the latest turn is the question. */
    private static List<HistoryTurn> asHistory(JsonNode raw) {
        List<HistoryTurn> out = new ArrayList<>();
        if (raw == null || !raw.isArray()) {
            return out;
        }
        for (JsonNode m : raw) {
            if (m == null || !m.isObject()) {
                continue;
            }
            String role = "assistant".equals(Json.optStr(m, "role", null)) ? "assistant" : "user";
            JsonNode contentNode = m.get("content");
            String rawText = contentNode != null && contentNode.isTextual() ? contentNode.asText() : "";
            // Strip legacy <recommendations>/<planning> tags from old conversations.
            String stripped = ProfileLogic.stripMetaBlocks(rawText);
            String text = sanitizeUserText(stripped.isEmpty() ? rawText : stripped);
            if (text.isEmpty()) {
                continue;
            }
            out.add(new HistoryTurn(role, Js.slice(text, 0, TEXT_CLIP)));
            if (out.size() >= MAX_HISTORY) {
                break;
            }
        }
        return out;
    }

    /** TS {@code asProfile} — trim, clip to 160, "not established yet" as null. */
    private static TripProfile asProfile(JsonNode raw) {
        JsonNode p = raw != null && raw.isObject() ? raw : Json.obj();
        return new TripProfile(
                str(p, "destination"), str(p, "dates"), str(p, "people"), str(p, "budget"),
                str(p, "interests"), str(p, "duration"), str(p, "accommodation"),
                str(p, "hotel"), str(p, "restaurants"), str(p, "attractions"),
                str(p, "itinerary"));
    }

    /** TS {@code str(v)}: a trimmed, 160-clipped string, or null for anything else. */
    private static String str(JsonNode parent, String field) {
        JsonNode v = parent.get(field);
        if (v == null || !v.isTextual()) {
            return null;
        }
        String trimmed = Js.trim(v.asText());
        return trimmed.isEmpty() ? null : Js.slice(trimmed, 0, 160);
    }

    /**
     * The current plan (last assistant reply) echoed back for follow-up edits.
     * Validated through the same schema so a hand-crafted body can't inject
     * junk.
     */
    private static Plan readPlan(JsonNode raw) {
        if (raw == null || raw.isNull() || !(raw.isObject() || raw.isArray())) {
            return Plan.EMPTY;
        }
        try {
            AiSchema.ParseResult parsed = AiSchema.parseAiReply(Json.write(raw));
            if (!parsed.ok()) {
                return Plan.EMPTY;
            }
            return new Plan(ReplyHelpers.planSummary(parsed.reply()),
                    parsed.reply().itinerary().size() > 0);
        } catch (RuntimeException err) {
            return Plan.EMPTY;
        }
    }

    /** TS {@code asShownPlaces} — deduped by place key, capped at 80. */
    private static List<ShownPlace> asShownPlaces(JsonNode raw) {
        List<ShownPlace> out = new ArrayList<>();
        if (raw == null || !raw.isArray()) {
            return out;
        }
        Set<String> seen = new HashSet<>();
        for (JsonNode p : raw) {
            if (p == null || !p.isObject()) {
                continue;
            }
            String name = strSlice(p, "name", 120);
            if (name == null || name.isEmpty()) {
                continue;
            }
            String key = AiIntent.normalizePlaceKey(name);
            if (key.isEmpty() || seen.contains(key)) {
                continue;
            }
            seen.add(key);
            out.add(new ShownPlace(name, strSlice(p, "category", 24), strSlice(p, "city", 60)));
            if (out.size() >= 80) {
                break;
            }
        }
        return out;
    }

    /** Trip-board items the user saved (feeding preference/memory retrieval). */
    private static List<TripItemLite> asTripItems(JsonNode raw) {
        List<TripItemLite> out = new ArrayList<>();
        if (raw == null || !raw.isArray()) {
            return out;
        }
        for (JsonNode i : raw) {
            if (i == null || !i.isObject()) {
                continue;
            }
            String name = strSlice(i, "name", 120);
            if (name == null || name.isEmpty()) {
                continue;
            }
            JsonNode ratingNode = i.get("rating");
            Double rating = ratingNode != null && ratingNode.isNumber() ? ratingNode.asDouble() : null;
            out.add(new TripItemLite(name, rawStr(i, "category"), rawSlice(i, "price", 48),
                    rawSlice(i, "detail", 200), rawSlice(i, "description", 300), rating));
            if (out.size() >= 60) {
                break;
            }
        }
        return out;
    }

    /** TS {@code typeof v === "string" ? v.trim().slice(0, max) : undefined}. */
    private static String strSlice(JsonNode parent, String field, int max) {
        String raw = rawStr(parent, field);
        return raw == null ? null : Js.slice(Js.trim(raw), 0, max);
    }

    /** TS {@code typeof v === "string" ? v.slice(0, max) : undefined} (no trim). */
    private static String rawSlice(JsonNode parent, String field, int max) {
        String raw = rawStr(parent, field);
        return raw == null ? null : Js.slice(raw, 0, max);
    }

    /** TS {@code typeof v === "string" ? v : undefined}. */
    private static String rawStr(JsonNode parent, String field) {
        JsonNode v = parent.get(field);
        return v != null && v.isTextual() ? v.asText() : null;
    }

    /** The question this turn has to answer: the latest user message. */
    private static String lastUserQuestion(List<HistoryTurn> transcript) {
        for (int i = transcript.size() - 1; i >= 0; i--) {
            HistoryTurn turn = transcript.get(i);
            if ("user".equals(turn.role())) {
                return Js.trim(turn.content());
            }
        }
        HistoryTurn last = transcript.isEmpty() ? null : transcript.get(transcript.size() - 1);
        return last == null ? "" : Js.trim(last.content());
    }

    // ------------------------------------------------------------- prepare

    /**
     * Everything between "request parsed" and "stream the reply": the verbatim
     * history window, the intent, budgeted retrieval, the system prompt and
     * the {@code finalize} policy closure.
     */
    public Turn prepare(Parsed req) {
        List<HistoryTurn> transcript = req.transcript();

        // Newest turns go to the model verbatim — bounded by BOTH a turn count
        // and a character budget so a long chat cannot blow the free tier's
        // TPM and knock the correction retry offline. Everything older is
        // COMPRESSED into a digest (never dropped) — see buildHistoryDigest.
        List<HistoryTurn> history = new ArrayList<>();
        history.add(transcript.get(transcript.size() - 1));
        int historyChars = history.get(0).content().length();
        for (int i = transcript.size() - 2; i >= 0 && history.size() < RECENT_TURNS; i--) {
            HistoryTurn turn = transcript.get(i);
            if (historyChars + turn.content().length() > MAX_HISTORY_CHARS) {
                break;
            }
            history.add(0, turn);
            historyChars += turn.content().length();
        }
        List<HistoryTurn> olderTurns =
                new ArrayList<>(transcript.subList(0, transcript.size() - history.size()));
        String digest = AiPrompt.buildHistoryDigest(olderTurns, history.size());

        TripProfile profile = req.profile();
        String plan = req.plan();
        String question = req.question();

        // 1. What is this turn? (drives the prompt budget AND the post-check)
        AiIntent.TurnIntent intent = AiIntent.classifyIntent(new AiIntent.IntentInput(
                question,
                ProfileLogic.nextField(profile) != PlanningField.DONE,
                Js.truthy(profile.itinerary),
                Js.truthy(plan),
                req.planHasItinerary()));
        Set<String> shownKeys = new HashSet<>();
        for (ShownPlace shown : req.shownPlaces()) {
            shownKeys.add(AiIntent.normalizePlaceKey(shown.name()));
        }

        // 2. Routed retrieval: only the sources the intent router picks for
        //    this question. Memory retrieval sees the WHOLE transcript, not
        //    just the window. Any failure degrades to "no extra context".
        Retrieved retrieved;
        if (Js.truthy(question)) {
            List<ChatTurn> priorTurns = new ArrayList<>();
            int upto = "user".equals(transcript.get(transcript.size() - 1).role())
                    ? transcript.size() - 1 : transcript.size();
            for (int i = 0; i < upto; i++) {
                HistoryTurn h = transcript.get(i);
                priorTurns.add(new ChatTurn(h.role(), h.content()));
            }
            RetrievalContext ctx = RetrievalContext.builder()
                    .question(question)
                    .turns(priorTurns)
                    .profile(ragProfile(profile))
                    .tripItems(req.tripItems())
                    .conversationId(req.conversationId())
                    .now(System.currentTimeMillis())
                    .build();
            retrieved = retrieveContext(ctx);
        } else {
            retrieved = NO_CONTEXT;
        }

        // Ship a validated reply only after the turn's policy has been applied
        // and the safety disclaimer is guaranteed. The source footer goes on
        // LAST: it resolves the [Sn] ids the model cited into visible
        // labels/links, so nothing may clip it away.
        String sourcesFooter = ContextBuilder.buildSourcesFooter(retrieved.sources());
        UnaryOperator<AiReply> finalize = reply -> {
            AiReply shaped =
                    AiIntent.applySafetyDisclaimer(AiIntent.applyTurnIntent(reply, intent, shownKeys), question);
            return sourcesFooter.isEmpty() ? shaped : shaped.withIntro(shaped.intro() + sourcesFooter);
        };

        StringBuilder system = new StringBuilder();
        for (String block : List.of(AiPrompt.SYSTEM_PROMPT, digest,
                AiPrompt.buildTripContext(profile, plan), retrieved.contextBlock(),
                AiPrompt.buildTurnContext(intent, question, req.shownPlaces()))) {
            if (block != null && !block.isEmpty()) {
                if (system.length() > 0) {
                    system.append("\n\n");
                }
                system.append(block);
            }
        }

        List<GroqService.Message> messages = new ArrayList<>();
        messages.add(GroqService.Message.system(system.toString()));
        for (HistoryTurn turn : history) {
            messages.add(new GroqService.Message(turn.role(), turn.content()));
        }
        messages.add(GroqService.Message.user(USER_MESSAGE));

        return new Turn(intent, messages, finalize);
    }

    /**
     * RAG for this turn — budgeted: retrieval can never delay the answer past
     * the timeout, and any failure degrades to "no extra context" rather than
     * a failed chat.
     */
    private Retrieved retrieveContext(RetrievalContext ctx) {
        try {
            Future<RagOutcome> future =
                    RagExec.pool().submit(() -> rag.retrieveForQuestion(ctx, List.of()));
            try {
                RagOutcome outcome = future.get(RETRIEVAL_BUDGET_MS, TimeUnit.MILLISECONDS);
                return new Retrieved(outcome.contextBlock(), outcome.sources());
            } catch (TimeoutException budget) {
                // TS Promise.race resolves null on timeout: plain "no context",
                // no warning — the retrieval keeps running in the background.
                return NO_CONTEXT;
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            log.warn("[chat] retrieval skipped: {}", "interrupted");
            return NO_CONTEXT;
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause() == null ? failed : failed.getCause();
            log.warn("[chat] retrieval skipped: {}", messageOf(cause));
            return NO_CONTEXT;
        }
    }

    /** The RAG pipeline's profile type, fed from the chat profile's same-named fields. */
    private static com.tripcraft.backend.rag.TripProfile ragProfile(TripProfile profile) {
        Map<String, String> values = new LinkedHashMap<>();
        for (String field : com.tripcraft.backend.rag.TripProfile.FIELDS) {
            values.put(field, profile.get(PlanningField.fromWire(field)));
        }
        return com.tripcraft.backend.rag.TripProfile.of(values);
    }

    // -------------------------------------------------------------- errors

    /**
     * Groq could not answer — the TS {@code failTurn}: wording that matches
     * the cause, plus the {@code [debug: …]} development hint carrying the
     * raw reason.
     */
    public static String failMessage(String reason) {
        String devHint = isProduction() ? "" : " [debug: " + reason + "]";
        String base = rateLimited(reason)
                ? "The AI service is busy right now — please try again in a moment."
                : "Something went wrong while planning. Please try again.";
        return base + devHint;
    }

    /** TS {@code /\b429\b|rate limit/i.test(reason)}. */
    static boolean rateLimited(String reason) {
        return RATE_LIMITED.matcher(reason == null ? "" : reason).find();
    }

    /**
     * TS {@code process.env.NODE_ENV !== "production"}: an unset NODE_ENV is
     * development, so the debug hint ships by default and only disappears
     * when the operator explicitly sets {@code NODE_ENV=production}.
     */
    private static boolean isProduction() {
        String env = EnvFile.get("NODE_ENV");
        return env != null && env.trim().equalsIgnoreCase("production");
    }

    // -------------------------------------------------------------- helpers

    private static JsonNode at(JsonNode node, String field) {
        return node == null ? null : node.get(field);
    }

    private static String messageOf(Throwable err) {
        String message = err.getMessage();
        return message == null || message.isEmpty() ? String.valueOf(err) : message;
    }
}
