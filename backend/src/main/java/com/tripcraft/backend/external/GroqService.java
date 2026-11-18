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
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.config.EnvFile;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;

/**
 * Port of {@code src/lib/groq.ts} — the Groq chat-completions client.
 *
 * <p>API for the chat controller:
 * <ul>
 *   <li>{@link #chat(List)} — TS {@code groqChat}: one non-streaming request,
 *       returns the assistant text;</li>
 *   <li>{@link #run(List)} — the same call as a {@link ChatResult} carrying the
 *       {@link Finish} reason too, so the caller can spot a truncated
 *       ({@code length}) generation and retry with a bigger budget;</li>
 *   <li>{@link #chatStream(List, StreamHandler)} — TS {@code groqChatStream}:
 *       blocking read of the SSE body that pushes every content delta to the
 *       handler <em>as it arrives</em> (never batched) and returns the finish
 *       reason on completion. The handler's {@code onFinish}/{@code onError}
 *       are fired as well for object-style handlers; the return value is the
 *       completion signal for lambda callers.</li>
 * </ul>
 *
 * <p>Failures throw {@link IllegalStateException} carrying the upstream wording
 * the controller matches on — {@code Groq error 429: <body>} with the provider's
 * body text (so the route's {@code /429|rate limit/} test and its
 * {@code [debug: …]} hint see the real cause), {@code Groq unavailable after
 * retries (HTTP 429 …)} once the TS's bounded 3-attempt policy is exhausted,
 * and {@code GROQ_API_KEY is not set} exactly as {@code getConfig()} threw it.
 *
 * <p><b>The SSE line split — do not "simplify" it.</b> The buffer is drained
 * with:
 *
 * <pre>
 * String[] lines = buffer.split("\n", -1);   // KEEPS trailing empty strings
 * buffer = lines[lines.length - 1];
 * for (int i = 0; i &lt; lines.length - 1; i++) { ...process lines[i]... }
 * </pre>
 *
 * {@code String.split} <em>without</em> a limit drops trailing empty strings, so
 * {@code "data: a\ndata: b\n"} yields only 2 parts and the newline that
 * terminated the last complete line is discarded together with it. The next
 * chunk then appends to a tail that has no trailing newline, which makes
 * {@code lines[lines.length - 1]} always be "the rest": the inner loop never
 * runs, zero deltas are emitted and every turn silently wastes a provider call
 * (the root cause of the repeated HTTP 429s). With {@code -1} the same buffer
 * yields 3 parts {@code ["data: a", "data: b", ""]}: indices
 * {@code 0..length-2} are exactly the finished lines and the last part keeps the
 * separator for the next chunk. Chunks may split a line at any byte boundary;
 * each completed line is {@code trim()}ed, which also absorbs the CR of CRLF
 * framing before the {@code data:} prefix test.
 */
@Service
public class GroqService {

    /** {@code GROQ_HOST + GROQ_PATH} of the TS original. */
    private static final String GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
    private static final String DEFAULT_MODEL = "openai/gpt-oss-120b";
    private static final double DEFAULT_TEMPERATURE = 0.7;
    private static final int DEFAULT_MAX_TOKENS = 2048;

    /** Reserved for reasoning tokens so the visible answer always gets its budget. */
    private static final int MAX_TOKEN_HEADROOM = 768;

    /**
     * How much the model thinks before answering. "low" by default: on
     * {@code openai/gpt-oss-120b} reasoning tokens are billed against
     * {@code max_tokens} AND against the free tier's 8,000 TPM, and they delay
     * the first byte — measured 2.2s / 770 completion tokens at "low" vs 4.1s /
     * 1323 default. Bumping this to "high" reintroduces both the latency and
     * the 429s. No route overrides it, so unlike the TS {@code RequestOptions}
     * it stays a constant here.
     */
    private static final String REASONING_EFFORT = "low";

    /** Idle-stall guard for one streaming attempt — TS socket {@code timeout: 60_000}. */
    private static final int STREAM_IDLE_MS = 60_000;

    /** Non-streaming request budget — TS {@code timeout: 60_000}. */
    private static final int REQUEST_TIMEOUT_MS = 60_000;

    /** Never stall the chat longer than this, whatever the server hint says. */
    private static final long HINTED_WAIT_CAP_MS = 10_000;

    private static final Pattern HINT_PATTERN =
            Pattern.compile("try again in (\\d+(?:\\.\\d+)?)", Pattern.CASE_INSENSITIVE);

    /**
     * {@code infra.Http.stream()} is a streaming <em>GET</em>, but chat
     * completions need a streaming POST, so the SSE call owns a client with the
     * same policy as {@code infra.Http}'s (redirects followed, 15s connect).
     */
    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(Duration.ofSeconds(15))
            .build();

    /**
     * Breaks a response body that stops delivering: java.net.http's request
     * timeout only guards the connect/headers phase (verified empirically —
     * the body is free-running), while the TS socket timeout was idle-based
     * and every delta reset it.
     */
    private static final ScheduledExecutorService WATCHDOG =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "groq-stream-watchdog");
                t.setDaemon(true);
                return t;
            });

    private static final StreamHandler NOOP = new StreamHandler() {
        @Override
        public void onDelta(String text) {
        }
    };

    // ------------------------------------------------------------- messages

    /**
     * Port of the TS {@code GroqMessage} interface. Shared with
     * {@link OllamaService} because the TypeScript chat route passes its
     * {@code groqMessages} array to <em>both</em> providers (TS is structurally
     * typed) — one record type keeps that call site type-checking here too.
     */
    public record Message(String role, String content) {

        public static Message system(String content) {
            return new Message("system", content);
        }

        public static Message user(String content) {
            return new Message("user", content);
        }

        public static Message assistant(String content) {
            return new Message("assistant", content);
        }
    }

    /**
     * Why generation stopped: {@code STOP} (normal), {@code LENGTH} (hit the
     * token budget — the controller retries on this) or {@code UNKNOWN} (the
     * provider did not say).
     */
    public enum Finish {
        STOP,
        LENGTH,
        UNKNOWN;

        /** Maps the wire value of {@code finish_reason} / {@code done_reason}. */
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

        /** True when the provider ran out of {@code max_tokens} mid-reply. */
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

        /** Provider failed (after any retries) — the same error is rethrown right after. */
        default void onError(String message) {
        }
    }

    // ------------------------------------------------------- non-streaming

    /** TS {@code groqChat} — assistant text, default options. */
    public String chat(List<Message> messages) {
        return run(messages, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS).text();
    }

    /** {@code max_tokens} per call (temperature stays at the TS default 0.7). */
    public String chat(List<Message> messages, int maxTokens) {
        return run(messages, DEFAULT_TEMPERATURE, maxTokens).text();
    }

    /** TS {@code groqChat} with explicit options. */
    public String chat(List<Message> messages, double temperature, int maxTokens) {
        return run(messages, temperature, maxTokens).text();
    }

    /** Like {@link #chat(List)} but keeps the {@link Finish} reason. */
    public ChatResult run(List<Message> messages) {
        return run(messages, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS);
    }

    /** {@code max_tokens} per call; result carries the finish reason. */
    public ChatResult run(List<Message> messages, int maxTokens) {
        return run(messages, DEFAULT_TEMPERATURE, maxTokens);
    }

    /**
     * The "run once" call: one non-streaming POST to the Groq chat
     * completions endpoint, with the TS retry policy — three attempts on
     * network error / 429 / 503, fixed 800ms·n backoff overridden by the
     * "try again in Ns" hint Groq puts in the 429 body, any other non-2xx
     * throws immediately with the response body in the message.
     */
    public ChatResult run(List<Message> messages, double temperature, int maxTokens) {
        String apiKey = apiKey();
        String payload = buildPayload(messages, temperature, maxTokens, false);
        String lastError = "Groq request failed";
        // Delay for the NEXT attempt. Starts as the fixed backoff (800ms, then
        // 1600ms) but a 429 with a server hint overrides it — see hintedRetryDelayMs.
        long nextDelayMs = 800;
        for (int attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) {
                sleep(nextDelayMs);
            }
            long base = 800L * (attempt + 1);
            nextDelayMs = base;

            Http.Raw raw = Http.post(
                    GROQ_URL, payload, Map.of("Authorization", "Bearer " + apiKey), REQUEST_TIMEOUT_MS);
            int status = raw.status();
            String text = raw.body() == null ? "" : raw.body();
            if (status == 0) {
                // infra.Http collapses connect failures (empty body) and
                // transport errors (message) into status 0 → retry either way.
                lastError = text.isEmpty() ? "Groq request timed out" : text;
                continue;
            }
            if (status == 429 || status == 503) {
                lastError = "Groq error " + status + ": " + slice(text, 200);
                // 429: wait out the TPM window the body reports instead of guessing.
                if (status == 429) {
                    Long hinted = hintedRetryDelayMs(text);
                    if (hinted != null) {
                        nextDelayMs = hinted;
                    }
                }
                continue; // rate limit / overloaded → retry after the delay above
            }
            if (status < 200 || status >= 300) {
                throw new IllegalStateException("Groq error " + status + ": " + text);
            }
            JsonNode data = Json.parseOrNull(text);
            if (data == null) {
                throw new IllegalStateException("Groq returned invalid JSON: " + slice(text, 200));
            }
            JsonNode choice = data.path("choices").path(0);
            String content = Json.optStr(choice.path("message"), "content", "");
            Finish finish = Finish.from(Json.optStr(choice, "finish_reason", null));
            return new ChatResult(content, finish);
        }
        throw new IllegalStateException(lastError);
    }

    // ---------------------------------------------------------- streaming

    /** Streaming with default options (TS {@code groqChatStream}). */
    public Finish chatStream(List<Message> messages, StreamHandler handler) {
        return chatStream(messages, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, handler);
    }

    /** {@code max_tokens} per call; temperature stays at the TS default 0.7. */
    public Finish chatStream(List<Message> messages, int maxTokens, StreamHandler handler) {
        return chatStream(messages, DEFAULT_TEMPERATURE, maxTokens, handler);
    }

    /**
     * Streaming variant of {@link #run(List, double, int)}: SSE deltas are
     * pushed to {@code handler} the moment each line completes (first-token
     * latency matters — nothing is buffered until the end), and the finish
     * reason is returned once the stream ends. Same bounded 3-attempt retry as
     * the TS: 429/503 retry (honouring the "try again in Ns" hint), other
     * statuses throw with the body text, exhausted retries throw
     * {@code Groq unavailable after retries (<last reason>)}.
     */
    public Finish chatStream(List<Message> messages, double temperature, int maxTokens,
            StreamHandler handler) {
        StreamHandler sink = handler == null ? NOOP : handler;
        try {
            String apiKey = apiKey();
            String payload = buildPayload(messages, temperature, maxTokens, true);
            /** Why the most recent attempt gave up — surfaced if every retry fails. */
            String lastReason = "no response";
            /**
             * Delay before the next attempt: fixed backoff by default,
             * overridden by the 429 body's "try again in Ns" hint (see
             * hintedRetryDelayMs) so a TPM spike waits out its window instead
             * of failing all 3 attempts within it.
             */
            long nextDelayMs = 800;
            for (int attempt = 0; attempt < 3; attempt++) {
                if (attempt > 0) {
                    sleep(nextDelayMs);
                }
                // Reset to the fixed backoff first; runOnce overrides it below
                // only when the response is a 429 whose body carries a hint.
                long base = 800L * (attempt + 1);
                nextDelayMs = base;
                Attempt outcome = runOnce(payload, apiKey, sink, base);
                if (outcome.finish() != null) {
                    Finish finish = outcome.finish();
                    sink.onFinish(finish);
                    return finish;
                }
                lastReason = outcome.reason();
                nextDelayMs = outcome.delayMs();
                if (attempt == 2) {
                    throw new IllegalStateException(
                            "Groq unavailable after retries (" + lastReason + ")");
                }
            }
            throw new IllegalStateException("Groq unavailable after retries (" + lastReason + ")");
        } catch (RuntimeException e) {
            sink.onError(e.getMessage() == null ? e.toString() : e.getMessage());
            throw e;
        }
    }

    /** Outcome of one streaming attempt: {@code finish != null} → complete, else retry. */
    private record Attempt(Finish finish, String reason, long delayMs) {

        static Attempt done(Finish finish) {
            return new Attempt(finish, null, 0);
        }

        static Attempt retry(String reason, long delayMs) {
            return new Attempt(null, reason, delayMs);
        }
    }

    /**
     * One SSE attempt (the TS {@code runOnce}): opens the streaming POST and
     * drains it. Returns only on success — retryable failures come back as
     * {@link Attempt#retry}, fatal ones (non-2xx body, stall after start) throw.
     */
    private Attempt runOnce(String payload, String apiKey, StreamHandler sink, long baseDelay) {
        HttpResponse<InputStream> res;
        try {
            res = postStream(payload, apiKey, STREAM_IDLE_MS);
        } catch (HttpTimeoutException e) {
            return Attempt.retry("connect timeout", baseDelay);
        } catch (Exception e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return Attempt.retry("transport: " + msg(e, "socket error"), baseDelay);
        }

        int status = res.statusCode();
        InputStream in = res.body();
        if (status == 429 || status == 503) {
            String errText = readUpTo(in, 400);
            closeQuietly(in);
            long delay = baseDelay;
            if (status == 429) {
                // Groq states exactly when the per-minute window resets.
                Long hinted = hintedRetryDelayMs(errText);
                if (hinted != null) {
                    delay = hinted;
                }
            }
            String reason = "HTTP " + status + (errText.isEmpty() ? "" : " " + slice(errText, 240));
            return Attempt.retry(reason, delay);
        }
        if (status < 200 || status >= 300) {
            String errText = readAll(in);
            closeQuietly(in);
            // The controller matches on this body (429 wording, limits hints).
            throw new IllegalStateException("Groq error " + status + ": " + errText);
        }

        // --- 2xx: parse the SSE body incrementally -------------------------
        boolean started = false;
        Finish finish = Finish.UNKNOWN;
        String buffer = "";
        long[] lastActivity = { System.currentTimeMillis() };
        boolean[] idleFired = { false };
        ScheduledFuture<?> guard = WATCHDOG.scheduleAtFixedRate(() -> {
            if (System.currentTimeMillis() - lastActivity[0] >= STREAM_IDLE_MS) {
                idleFired[0] = true;
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
                started = true;
                lastActivity[0] = System.currentTimeMillis();
                buffer += new String(chars, 0, n);
                // *** split("\n", -1) — see the class javadoc. Without the -1
                // limit the trailing newline is dropped with the completed line,
                // lines[length-1] swallows everything, and this loop never runs.
                String[] lines = buffer.split("\n", -1);
                buffer = lines[lines.length - 1];
                for (int i = 0; i < lines.length - 1; i++) {
                    finish = onSseLine(lines[i], sink, finish);
                }
            }
            // Clean EOF: surface a final line that never got its newline (the TS
            // drops it, losing the last delta when the stream ends right after data).
            if (!buffer.isEmpty()) {
                finish = onSseLine(buffer, sink, finish);
            }
            if (idleFired[0]) {
                throw new IllegalStateException("Groq stream timed out");
            }
            return Attempt.done(finish);
        } catch (IOException e) {
            if (idleFired[0]) {
                throw new IllegalStateException("Groq stream timed out");
            }
            if (!started) {
                // Died before the first byte — the TS treats this as retryable.
                return Attempt.retry("transport: " + msg(e, "socket error"), baseDelay);
            }
            throw new IllegalStateException(msg(e, "socket error"));
        } finally {
            guard.cancel(false);
            closeQuietly(in);
        }
    }

    /**
     * One SSE line: honours the {@code data:} prefix, the {@code [DONE]}
     * sentinel and the {@code choices[0].delta.content} /
     * {@code finish_reason} fields the TS reads. Malformed JSON is ignored,
     * like the TS {@code try/catch} around {@code JSON.parse}.
     */
    private static Finish onSseLine(String line, StreamHandler sink, Finish current) {
        String trimmed = line.trim(); // trim() also absorbs the CR of a CRLF line
        if (!trimmed.startsWith("data:")) {
            return current;
        }
        String payload = trimmed.substring(5).trim();
        if (payload.isEmpty() || "[DONE]".equals(payload)) {
            return current;
        }
        JsonNode json = Json.parseOrNull(payload);
        if (json == null) {
            return current;
        }
        JsonNode choice = json.path("choices").path(0);
        JsonNode content = choice.path("delta").path("content");
        if (content.isTextual() && !content.asText().isEmpty()) {
            sink.onDelta(content.asText());
        }
        Finish finish = Finish.from(Json.optStr(choice, "finish_reason", null));
        return finish == Finish.UNKNOWN ? current : finish;
    }

    // ------------------------------------------------------------- payload

    private static String buildPayload(List<Message> messages, double temperature,
            int maxTokens, boolean stream) {
        ObjectNode node = Json.obj();
        node.put("model", model());
        writeMessages(node.putArray("messages"), messages);
        node.put("temperature", temperature);
        // +HEADROOM: reasoning shares this budget with the visible answer.
        // Without it a long think can burn every token and return an EMPTY
        // `content`, which fails validation and triggers a second (expensive)
        // generation.
        node.put("max_tokens", maxTokens + MAX_TOKEN_HEADROOM);
        node.put("reasoning_effort", REASONING_EFFORT);
        node.put("stream", stream);
        return Json.write(node);
    }

    /**
     * Serialises the shared message list. Package-private because
     * {@link OllamaService} writes the very same record type into its own
     * payload (the TS route hands one message array to both providers).
     */
    static void writeMessages(ArrayNode out, List<Message> messages) {
        if (messages == null) {
            return;
        }
        for (Message m : messages) {
            if (m == null) {
                continue;
            }
            ObjectNode o = out.addObject();
            o.put("role", m.role() == null ? "" : m.role());
            o.put("content", m.content() == null ? "" : m.content());
        }
    }

    // ------------------------------------------------------------- helpers

    /** Reads GROQ_API_KEY fresh each call; throws the TS getConfig() wording. */
    private static String apiKey() {
        String key = EnvFile.get("GROQ_API_KEY");
        if (key == null || key.isBlank()) {
            throw new IllegalStateException("GROQ_API_KEY is not set");
        }
        return key;
    }

    /** GROQ_MODEL from .env.local, defaulting like the TS {@code ||} expression. */
    private static String model() {
        String model = EnvFile.get("GROQ_MODEL");
        return model == null || model.isBlank() ? DEFAULT_MODEL : model;
    }

    /**
     * Groq's 429 body states exactly when the per-minute token window resets
     * ("...try again in 6.21749"). Honoring that turns a TPM spike — e.g. two
     * planning turns inside one minute — into a ~6s pause before a successful
     * retry. The old fixed 0.8s/1.6s backoff burned all 3 attempts inside the
     * SAME minute window, so the turn failed even though the limit cleared in
     * seconds. Returns {@code null} when no hint is parseable (caller keeps the
     * backoff).
     */
    private static Long hintedRetryDelayMs(String text) {
        Matcher m = HINT_PATTERN.matcher(text == null ? "" : text);
        if (!m.find()) {
            return null;
        }
        double seconds;
        try {
            seconds = Double.parseDouble(m.group(1));
        } catch (NumberFormatException e) {
            return null;
        }
        if (!Double.isFinite(seconds) || seconds <= 0) {
            return null;
        }
        return Math.min((long) Math.ceil(seconds * 1000) + 250, HINTED_WAIT_CAP_MS);
    }

    /**
     * Streaming POST. {@code HttpRequest.timeout} guards the connect/headers
     * phase only (the body is watched by the idle watchdog above); the TS
     * {@code timeout: 60_000} was an idle-stall guard, not a total budget.
     */
    private static HttpResponse<InputStream> postStream(String body, String apiKey, int timeoutMs)
            throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(GROQ_URL))
                // Same defaults as infra.Http's newRequest(): some providers
                // reject the JDK's built-in user agent.
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .header("User-Agent", "TripCraft/1.0")
                .header("Accept", "*/*")
                .timeout(Duration.ofMillis(timeoutMs))
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();
        return CLIENT.send(request, HttpResponse.BodyHandlers.ofInputStream());
    }

    /** TS {@code await sleep(ms)} between retry attempts (max 3 attempts). */
    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Groq retry wait interrupted", e);
        }
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

    private static String readUpTo(InputStream in, int max) {
        try {
            return new String(in.readNBytes(max), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
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
