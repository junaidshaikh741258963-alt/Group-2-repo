package com.tripcraft.backend.external;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.config.EnvFile;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;

/**
 * Port of {@code src/lib/ollama.ts} — the local Ollama {@code /api/chat}
 * client (keyless-mode backend and the TS route's only fallback).
 *
 * <p>API for the chat controller:
 * <ul>
 *   <li>{@link #chat(List)} — TS {@code ollamaChat}: one non-streaming request,
 *       returns the assistant text;</li>
 *   <li>{@link #run(List)} — the same call as a {@link ChatResult} carrying the
 *       {@link Finish} reason ({@code done_reason}) so a truncated
 *       ({@code length}) generation can be retried;</li>
 *   <li>{@link #chatStream(List, StreamHandler)} — TS {@code ollamaChatStream}:
 *       reads the NDJSON frames as they arrive and pushes each
 *       {@code message.content} to the handler, returning the finish reason
 *       when the stream ends.</li>
 * </ul>
 *
 * <p>Messages are {@link GroqService.Message}: the TypeScript chat route builds
 * {@code groqMessages} once and passes the same array to {@code groqChat},
 * {@code groqChatStream} <em>and</em> {@code ollamaChat} (TS is structurally
 * typed), so a single record type is what keeps that call site faithful here.
 *
 * <p>Timeouts: the TS used {@code AbortSignal.timeout(...)} per call — 120s for
 * {@code ollamaChat} (with {@code stream:false} Ollama only sends headers when
 * generation finishes, so the signal bounds the whole turn) and 300s for
 * {@code ollamaChatStream} (a cold model load can delay the first byte for
 * tens of seconds). The overloads with a {@code timeoutMs} parameter let the
 * controller pass the chat route's turn budgets (90s stream / 45s correction);
 * the defaults are the TS fallbacks above.
 *
 * <p><b>The line split — do not "simplify" it.</b> The NDJSON buffer is drained
 * with {@code buffer.split("\n", -1)} (trailing empties kept), exactly as in
 * {@link GroqService}: without the {@code -1} limit the newline terminating the
 * last complete frame is dropped with it, {@code lines[lines.length - 1]}
 * then swallows every following frame and the inner loop never runs — zero
 * deltas ever reach the caller. See the GroqService class javadoc for the full
 * trace.
 */
@Service
public class OllamaService {

    private static final String DEFAULT_BASE_URL = "http://localhost:11434";
    private static final String DEFAULT_MODEL = "gemma3:4b";
    private static final double DEFAULT_TEMPERATURE = 0.7;
    private static final int DEFAULT_NUM_PREDICT = 2048;
    private static final double TOP_P = 0.9;
    private static final int TOP_K = 40;

    /**
     * TS default for {@code ollamaChat}: {@code stream:false} sends headers
     * only when generation finishes — the signal must fire before undici's
     * 300s headers timeout or the turn stalls.
     */
    private static final int CHAT_TIMEOUT_MS = 120_000;

    /** TS default for {@code ollamaChatStream}: headers + generation under one signal. */
    private static final int STREAM_TIMEOUT_MS = 300_000;

    /**
     * {@code infra.Http.stream()} is a streaming GET, but Ollama's
     * {@code stream:true} endpoint needs a streaming POST, so this service owns
     * a client with the same policy as {@code infra.Http}'s.
     */
    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(Duration.ofSeconds(15))
            .build();

    /**
     * Enforces the total stream budget: java.net.http's request timeout only
     * guards the connect/headers phase, so a slow CPU generation is bounded by
     * this deadline (the TS {@code AbortSignal.timeout}) instead.
     */
    private static final ScheduledExecutorService WATCHDOG =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "ollama-stream-watchdog");
                t.setDaemon(true);
                return t;
            });

    private static final StreamHandler NOOP = new StreamHandler() {
        @Override
        public void onDelta(String text) {
        }
    };

    // ------------------------------------------------------------- results

    /**
     * Why generation stopped — {@code STOP} (normal), {@code LENGTH} (hit
     * {@code num_predict}, the controller retries on this) or {@code UNKNOWN}
     * (older Ollama builds that omit {@code done_reason} and did not report
     * {@code done:true} either).
     */
    public enum Finish {
        STOP,
        LENGTH,
        UNKNOWN;

        /** Maps the wire value of {@code done_reason}. */
        public static Finish from(String raw) {
            if (raw == null) {
                return UNKNOWN;
            }
            String value = raw.trim();
            if (value.equalsIgnoreCase("length")) {
                return LENGTH;
            }
            if (value.equalsIgnoreCase("stop")) {
                return STOP;
            }
            return UNKNOWN;
        }

        /** True only for a truncated generation. */
        public boolean truncated() {
            return this == LENGTH;
        }
    }

    /** Assistant text plus why generation stopped. */
    public record ChatResult(String text, Finish finish) {

        /** True when the local model ran out of {@code num_predict} mid-reply. */
        public boolean truncated() {
            return finish != null && finish.truncated();
        }
    }

    /**
     * Receives one streaming call. {@link #onDelta} is the only abstract
     * method, so a lambda works: {@code (text) -> send(text)}.
     */
    @FunctionalInterface
    public interface StreamHandler {

        /** One content delta, delivered as it arrives off the wire. */
        void onDelta(String text);

        /** Stream completed normally. Also mirrored by {@code chatStream}'s return value. */
        default void onFinish(Finish finish) {
        }

        /** Provider failed — the same error is rethrown right after. */
        default void onError(String message) {
        }
    }

    // ------------------------------------------------------- non-streaming

    /** TS {@code ollamaChat} — assistant text, default options (0.7 / 2048 / 120s). */
    public String chat(List<GroqService.Message> messages) {
        return run(messages, DEFAULT_TEMPERATURE, DEFAULT_NUM_PREDICT, CHAT_TIMEOUT_MS).text();
    }

    /** {@code num_predict} per call; temperature stays at the TS default 0.7. */
    public String chat(List<GroqService.Message> messages, int numPredict) {
        return run(messages, DEFAULT_TEMPERATURE, numPredict, CHAT_TIMEOUT_MS).text();
    }

    /** TS {@code ollamaChat} with explicit options. */
    public String chat(List<GroqService.Message> messages, double temperature, int numPredict) {
        return run(messages, temperature, numPredict, CHAT_TIMEOUT_MS).text();
    }

    /**
     * With an explicit budget — the controller passes the chat route's
     * {@code AbortSignal.timeout(budgetMs / 2)} for the correction retry.
     * {@code timeoutMs <= 0} keeps the TS default of 120s.
     */
    public String chat(List<GroqService.Message> messages, double temperature, int numPredict,
            int timeoutMs) {
        return run(messages, temperature, numPredict, timeoutMs).text();
    }

    /** Like {@link #chat(List)} but keeps the {@link Finish} reason. */
    public ChatResult run(List<GroqService.Message> messages) {
        return run(messages, DEFAULT_TEMPERATURE, DEFAULT_NUM_PREDICT, CHAT_TIMEOUT_MS);
    }

    /** {@code num_predict} per call; result carries the finish reason. */
    public ChatResult run(List<GroqService.Message> messages, int numPredict) {
        return run(messages, DEFAULT_TEMPERATURE, numPredict, CHAT_TIMEOUT_MS);
    }

    /** {@code num_predict} + temperature; result carries the finish reason. */
    public ChatResult run(List<GroqService.Message> messages, double temperature, int numPredict) {
        return run(messages, temperature, numPredict, CHAT_TIMEOUT_MS);
    }

    /**
     * The "run once" call: one non-streaming POST to {@code /api/chat}.
     * A non-2xx throws {@code Ollama error: <status> - <body>} exactly as the
     * TS did (the body is what the controller surfaces), matching
     * {@code fetch} + {@code res.ok} semantics through {@link Http#postJson}.
     */
    public ChatResult run(List<GroqService.Message> messages, double temperature, int numPredict,
            int timeoutMs) {
        int timeout = timeoutMs > 0 ? timeoutMs : CHAT_TIMEOUT_MS;
        Http.Raw raw = Http.postJson(
                baseUrl() + "/api/chat", buildPayload(messages, temperature, numPredict, false),
                timeout);
        int status = raw.status();
        String text = raw.body() == null ? "" : raw.body();
        if (status == 0) {
            // infra.Http collapses the timeout (empty body) and transport
            // errors (message) into status 0.
            throw new IllegalStateException(text.isEmpty() ? "Ollama request timed out" : text);
        }
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("Ollama error: " + status + " - " + text);
        }
        JsonNode data = Json.parseOrNull(text);
        if (data == null) {
            // TS res.json() rejected here; the route caught the SyntaxError.
            throw new IllegalStateException("Ollama returned invalid JSON: " + slice(text, 200));
        }
        String content = Json.optStr(data.path("message"), "content", "");
        return new ChatResult(content, finishOf(data));
    }

    // ---------------------------------------------------------- streaming

    /** Streaming with default options (TS {@code ollamaChatStream}). */
    public Finish chatStream(List<GroqService.Message> messages, StreamHandler handler) {
        return chatStream(messages, DEFAULT_TEMPERATURE, DEFAULT_NUM_PREDICT, STREAM_TIMEOUT_MS,
                handler);
    }

    /** {@code num_predict} per call; temperature stays at the TS default 0.7. */
    public Finish chatStream(List<GroqService.Message> messages, int numPredict,
            StreamHandler handler) {
        return chatStream(messages, DEFAULT_TEMPERATURE, numPredict, STREAM_TIMEOUT_MS, handler);
    }

    /** TS {@code ollamaChatStream} with explicit options. */
    public Finish chatStream(List<GroqService.Message> messages, double temperature, int numPredict,
            StreamHandler handler) {
        return chatStream(messages, temperature, numPredict, STREAM_TIMEOUT_MS, handler);
    }

    /**
     * Streaming variant of {@link #run(List, double, int, int)}: NDJSON frames
     * from {@code /api/chat} with {@code stream:true}, yielding content deltas
     * as they are generated so the chat shows the intro immediately instead of
     * waiting out a local model that may need a minute or two on CPU.
     * {@code timeoutMs <= 0} keeps the TS default of 300s for the whole call
     * (headers + generation). Failures throw with the wording the TS threw —
     * {@code Ollama error: <status> - <body>} carries the response body — and
     * also reach the handler's {@code onError} first.
     */
    public Finish chatStream(List<GroqService.Message> messages, double temperature, int numPredict,
            int timeoutMs, StreamHandler handler) {
        int budgetMs = timeoutMs > 0 ? timeoutMs : STREAM_TIMEOUT_MS;
        StreamHandler sink = handler == null ? NOOP : handler;
        try {
            HttpResponse<InputStream> res;
            try {
                res = postStream(buildPayload(messages, temperature, numPredict, true), budgetMs);
            } catch (HttpTimeoutException e) {
                throw new IllegalStateException("Ollama request timed out");
            } catch (Exception e) {
                if (e instanceof InterruptedException) {
                    Thread.currentThread().interrupt();
                }
                throw new IllegalStateException(msg(e, "Ollama request failed"));
            }
            int status = res.statusCode();
            InputStream in = res.body();
            if (in == null) {
                throw new IllegalStateException("Ollama returned no response body");
            }
            if (status < 200 || status >= 300) {
                String errText = readAll(in);
                closeQuietly(in);
                throw new IllegalStateException("Ollama error: " + status + " - " + errText);
            }

            // --- 2xx: parse one JSON object per complete line ---------------
            Finish finish = Finish.UNKNOWN;
            String buffer = "";
            boolean[] budgetFired = { false };
            long deadline = System.currentTimeMillis() + budgetMs;
            ScheduledFuture<?> guard = WATCHDOG.scheduleAtFixedRate(() -> {
                if (System.currentTimeMillis() >= deadline) {
                    budgetFired[0] = true;
                    Thread.ofVirtual().start(() -> closeQuietly(in));
                }
            }, 1, 1, TimeUnit.SECONDS);
            try {
                Reader reader = new InputStreamReader(in, StandardCharsets.UTF_8);
                char[] chars = new char[8192];
                int n;
                while ((n = reader.read(chars)) != -1) {
                    if (n == 0) {
                        continue;
                    }
                    buffer += new String(chars, 0, n);
                    // *** split("\n", -1) — see the class javadoc. Without the
                    // -1 limit no complete NDJSON frame would ever be processed.
                    String[] lines = buffer.split("\n", -1);
                    buffer = lines[lines.length - 1];
                    for (int i = 0; i < lines.length - 1; i++) {
                        finish = onFrame(lines[i], sink, finish);
                    }
                }
                // Clean EOF: surface a final frame that never got its newline.
                if (!buffer.isEmpty()) {
                    finish = onFrame(buffer, sink, finish);
                }
                if (budgetFired[0]) {
                    throw new IllegalStateException("Ollama stream timed out");
                }
                sink.onFinish(finish);
                return finish;
            } catch (IOException e) {
                if (budgetFired[0]) {
                    throw new IllegalStateException("Ollama stream timed out");
                }
                throw new IllegalStateException(msg(e, "socket error"));
            } finally {
                guard.cancel(false);
                closeQuietly(in);
            }
        } catch (RuntimeException e) {
            sink.onError(e.getMessage() == null ? e.toString() : e.getMessage());
            throw e;
        }
    }

    /**
     * One NDJSON frame: {@code message.content} is yielded when present, and
     * the finish reason comes from {@code done_reason} — falling back to
     * {@code STOP} when an explicit {@code done:true} carries no reason (older
     * builds). Partial / keep-alive frames that are not JSON yet are ignored;
     * the next read completes them (the TS {@code try/catch} around
     * {@code JSON.parse}).
     */
    private static Finish onFrame(String line, StreamHandler sink, Finish current) {
        String trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
            return current;
        }
        JsonNode frame = Json.parseOrNull(trimmed);
        if (frame == null) {
            return current;
        }
        JsonNode content = frame.path("message").path("content");
        if (content.isTextual() && !content.asText().isEmpty()) {
            sink.onDelta(content.asText());
        }
        Finish finish = finishOf(frame);
        return finish == Finish.UNKNOWN ? current : finish;
    }

    /**
     * {@code done_reason} of a response/frame — the same rule for the
     * streaming frames and the non-streaming reply. Older Ollama builds omit
     * the reason even on the final {@code done:true} frame, and that still
     * means a clean stop, so it maps to {@link Finish#STOP}.
     */
    private static Finish finishOf(JsonNode data) {
        Finish finish = Finish.from(Json.optStr(data, "done_reason", null));
        if (finish == Finish.UNKNOWN && data.path("done").asBoolean(false)) {
            return Finish.STOP;
        }
        return finish;
    }

    // ------------------------------------------------------------- payload

    private static String buildPayload(List<GroqService.Message> messages, double temperature,
            int numPredict, boolean stream) {
        ObjectNode node = Json.obj();
        node.put("model", model());
        GroqService.writeMessages(node.putArray("messages"), messages);
        node.put("stream", stream);
        ObjectNode options = node.putObject("options");
        options.put("temperature", temperature);
        options.put("num_predict", numPredict);
        options.put("top_p", TOP_P);
        options.put("top_k", TOP_K);
        return Json.write(node);
    }

    // ------------------------------------------------------------- helpers

    /** OLLAMA_BASE_URL from .env.local, defaulting like the TS constant. */
    private static String baseUrl() {
        String base = EnvFile.get("OLLAMA_BASE_URL");
        if (base == null || base.isBlank()) {
            base = DEFAULT_BASE_URL;
        }
        base = base.trim();
        // The TS concatenated blindly; strip slashes so base + "/api/chat"
        // never turns into a doubled "//" path.
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base;
    }

    /** OLLAMA_MODEL from .env.local, defaulting like the TS constant. */
    private static String model() {
        String model = EnvFile.get("OLLAMA_MODEL");
        return model == null || model.isBlank() ? DEFAULT_MODEL : model;
    }

    /**
     * Streaming POST. {@code HttpRequest.timeout} guards the connect/headers
     * phase (a cold model load delaying headers past the budget) — the total
     * budget over the body is enforced by the watchdog above.
     */
    private static HttpResponse<InputStream> postStream(String body, int timeoutMs) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl() + "/api/chat"))
                // Same defaults as infra.Http's newRequest().
                .header("Content-Type", "application/json")
                .header("User-Agent", "TripCraft/1.0")
                .header("Accept", "*/*")
                .timeout(Duration.ofMillis(timeoutMs))
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();
        return CLIENT.send(request, HttpResponse.BodyHandlers.ofInputStream());
    }

    private static String slice(String text, int max) {
        if (text == null) {
            return "";
        }
        return text.length() <= max ? text : text.substring(0, max);
    }

    private static String msg(Throwable e, String fallback) {
        String message = e == null ? null : e.getMessage();
        return message == null || message.isEmpty() ? fallback : message;
    }

    private static String readAll(InputStream in) {
        try {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static void closeQuietly(InputStream in) {
        if (in == null) {
            return;
        }
        try {
            in.close();
        } catch (IOException ignored) {
            // closing is best effort — the watchdog may already have closed it
        }
    }
}
