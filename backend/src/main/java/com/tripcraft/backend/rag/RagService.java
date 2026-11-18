package com.tripcraft.backend.rag;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * RAG orchestrator: route → retrieve (parallel, budgeted) → dedupe → rerank →
 * grounded context — the port of {@code src/lib/rag/index.ts}.
 *
 * <ul>
 *   <li>Fast path: stage-machine messages produce an empty plan with zero I/O.</li>
 *   <li>Every source runs behind a time budget so a slow upstream can never
 *       delay the answer beyond {@code OVERALL_BUDGET_MS}.</li>
 *   <li>The whole run is cached + single-flighted (see {@link TtlCache}), so a
 *       burst of identical questions performs retrieval once.</li>
 *   <li>Fail-open: any error degrades to "no context", never to a failed chat.</li>
 * </ul>
 */
@Service
public class RagService {

    private static final Logger log = LoggerFactory.getLogger(RagService.class);

    private static final long OVERALL_BUDGET_MS = 5_500;
    private static final long KNOWLEDGE_BUDGET_MS = 3_000;
    private static final long RUN_TTL_MS = 60_000;
    private static final long RUN_STALE_MS = 5 * 60_000;

    /** TS {@code /\s+/g} with the Unicode whitespace set JS uses. */
    private static final Pattern RUN_WS = Pattern.compile("\\s+", Pattern.UNICODE_CHARACTER_CLASS);

    private final Registry retrievers;

    public RagService(Registry retrievers) {
        this.retrievers = retrievers;
    }

    /** Pure routing step, re-exported by {@code index.ts} for diagnostics. */
    public RetrievalPlan planRetrieval(RetrievalContext ctx) {
        return Router.planRetrieval(ctx);
    }

    /**
     * Run the pipeline for one question.
     *
     * @param excludeSources sources dropped from the plan (diagnostics uses
     *                       {@code ["live"]} to skip SerpAPI/OSM legs)
     */
    public RagOutcome retrieveForQuestion(RetrievalContext ctx, List<RetrievalSource> excludeSources) {
        long started = System.currentTimeMillis();
        RetrievalPlan basePlan = Router.planRetrieval(ctx);
        boolean exclude = excludeSources != null && !excludeSources.isEmpty();
        RetrievalPlan plan;
        if (exclude) {
            List<RetrievalSource> filtered = new ArrayList<>();
            for (RetrievalSource source : basePlan.sources()) {
                if (!excludeSources.contains(source)) {
                    filtered.add(source);
                }
            }
            plan = basePlan.withSources(filtered);
        } else {
            plan = basePlan;
        }
        if (plan.sources().isEmpty()) {
            return RagOutcome.empty(plan, 0);
        }

        try {
            String suffix = "";
            if (exclude) {
                StringBuilder excluded = new StringBuilder("|x=");
                for (RetrievalSource source : excludeSources) {
                    if (excluded.length() > 2) {
                        excluded.append(',');
                    }
                    excluded.append(source.wire());
                }
                suffix = excluded.toString();
            }
            RagOutcome outcome = TtlCache.cached(runKey(ctx) + suffix, () -> run(plan, ctx),
                    new TtlCache.Options(RUN_TTL_MS, RUN_STALE_MS, true));
            // Copy: the cached instance must never be mutated (concurrent
            // readers would otherwise see each other's durationMs).
            return new RagOutcome(outcome.plan(), outcome.docs(), outcome.contextBlock(),
                    outcome.sources(), System.currentTimeMillis() - started);
        } catch (Exception err) {
            log.warn("[rag] run failed: {}", messageOf(err));
            return RagOutcome.empty(plan, System.currentTimeMillis() - started);
        }
    }

    /** One budgeted parallel retrieval pass + rank/gate/select/build. */
    private RagOutcome run(RetrievalPlan plan, RetrievalContext ctx) {
        List<RetrievalSource> sources = plan.sources();
        long t0 = System.currentTimeMillis();
        List<CompletableFuture<List<RetrievedDoc>>> futures = new ArrayList<>(sources.size());
        for (RetrievalSource source : sources) {
            // The inner catch wraps the CALL itself: a retriever that throws
            // synchronously becomes an empty array instead of blowing up the
            // whole batch — one bad source must never take out the others.
            futures.add(CompletableFuture.<List<RetrievedDoc>>supplyAsync(() -> {
                try {
                    return retrievers.retrieve(source, ctx, plan);
                } catch (Throwable inner) {
                    // TS `.catch(() => [])` — every failure degrades to no docs.
                    return List.of();
                }
            }, RagExec.pool()));
        }

        List<RetrievedDoc> flat = new ArrayList<>();
        for (int i = 0; i < sources.size(); i++) {
            RetrievalSource source = sources.get(i);
            long budget = source == RetrievalSource.KNOWLEDGE ? KNOWLEDGE_BUDGET_MS : OVERALL_BUDGET_MS;
            // Every leg's clock started at t0 (TS registers all the setTimeouts
            // synchronously), so only the remaining time is granted here.
            long remaining = budget - (System.currentTimeMillis() - t0);
            CompletableFuture<List<RetrievedDoc>> future = futures.get(i);
            List<RetrievedDoc> docs;
            if (remaining <= 0) {
                docs = future.isDone() ? future.getNow(List.of()) : List.of();
            } else {
                try {
                    docs = future.get(remaining, TimeUnit.MILLISECONDS);
                } catch (TimeoutException timeout) {
                    docs = List.of();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    docs = List.of();
                } catch (ExecutionException failed) {
                    log.warn("[rag:{}] failed: {}", source.wire(),
                            messageOf(failed.getCause() == null ? failed : failed.getCause()));
                    docs = List.of();
                }
            }
            flat.addAll(docs);
        }

        // Dedupe + rerank FIRST, then gate, then allocate context slots:
        // selecting before the gate let a to-be-dropped doc occupy a slot that
        // a legitimate doc could then never reach.
        List<RetrievedDoc> ranked = Rank.rankCandidates(flat, ctx.question());
        // Gate applies to the *context pool* only — outcome.docs keeps every
        // reranked doc (gated ones tagged with the reason) for diagnostics.
        List<String> gateReasons = new ArrayList<>(ranked.size());
        List<RetrievedDoc> eligible = new ArrayList<>();
        for (RetrievedDoc doc : ranked) {
            String reason = Rank.knowledgeGateReason(doc, ctx.question());
            gateReasons.add(reason);
            if (reason == null) {
                eligible.add(doc);
            }
        }
        List<RetrievedDoc> selected = Rank.selectTop(eligible);
        ContextBuilder.BuiltContext built = ContextBuilder.buildContext(selected, plan);

        List<RetrievedDoc> docs = new ArrayList<>(ranked.size());
        for (int i = 0; i < ranked.size(); i++) {
            RetrievedDoc doc = ranked.get(i);
            String reason = gateReasons.get(i);
            if (reason == null) {
                docs.add(doc);
            } else {
                RetrievedDoc gated = new RetrievedDoc(doc);
                gated.putMeta("gated", reason);
                docs.add(gated);
            }
        }
        return new RagOutcome(plan, docs, built.contextBlock(), built.sources(), 0);
    }

    /** Stable identity of one retrieval run (question + history fingerprint). */
    private static String runKey(RetrievalContext ctx) {
        Map<String, Object> params = new LinkedHashMap<>();
        String question = RUN_WS.matcher(ctx.question().toLowerCase(Locale.ROOT)).replaceAll(" ").trim();
        params.put("q", clip(question, 300));
        params.put("conv", ctx.conversationId() == null ? "" : ctx.conversationId());
        // Cheap structural fingerprint of the history (contents, not just count).
        StringBuilder turns = new StringBuilder();
        for (ChatTurn turn : ctx.turns()) {
            if (turns.length() > 0) {
                turns.append(',');
            }
            String role = turn.role();
            turns.append(role == null || role.isEmpty() ? "" : role.charAt(0));
            String content = turn.content();
            turns.append(content == null ? 0 : content.length());
        }
        params.put("turns", clip(turns.toString(), 500));
        params.put("profile", clip(ctx.profile().toJson().toString(), 800));
        StringBuilder board = new StringBuilder();
        for (TripItemLite item : ctx.tripItems()) {
            if (board.length() > 0) {
                board.append('|');
            }
            board.append(item.name());
        }
        params.put("board", clip(board.toString(), 300));
        return TtlCache.cacheKey("rag:run", params);
    }

    /** TS {@code s.slice(0, max)} — Java chars are UTF-16 units, like JS strings. */
    private static String clip(String value, int max) {
        return value.length() > max ? value.substring(0, max) : value;
    }

    private static String messageOf(Throwable err) {
        String message = err.getMessage();
        return message != null ? message : String.valueOf(err);
    }
}
