package com.tripcraft.backend.infra;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * The project's {@code fetch()} replacement.
 *
 * <p>Every upstream call the Next.js routes made with {@code fetch} goes
 * through here so timeouts, redirect handling and error semantics stay in one
 * place. Semantics are matched to {@code fetch}: a non-2xx status does not
 * throw — it is reported in {@link Raw#status()} — and callers decide whether
 * that is fatal, exactly as {@code res.ok} did.
 */
public final class Http {

    /** Redirects followed like the browser default ({@code redirect: follow}). */
    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(Duration.ofSeconds(15))
            .build();

    /** Status + raw body, mirroring a completed {@code Response}. */
    public record Raw(int status, String body) {
        public boolean ok() {
            return status >= 200 && status < 300;
        }

        /** Parsed body, or {@code null} when it is not valid JSON. */
        public JsonNode json() {
            if (body == null || body.isEmpty()) {
                return null;
            }
            return Json.parseOrNull(body);
        }
    }

    private Http() {
    }

    public static Raw get(String url, int timeoutMs) {
        return send(timed(newRequest(url, null), timeoutMs).GET().build(), timeoutMs);
    }

    /** GET with extra headers (Authorization, User-Agent, Accept, …). */
    public static Raw get(String url, Map<String, String> headers, int timeoutMs) {
        return send(timed(newRequest(url, headers), timeoutMs).GET().build(), timeoutMs);
    }

    /** POST of a raw body with an explicit Content-Type. */
    public static Raw post(String url, String body, Map<String, String> headers, int timeoutMs) {
        HttpRequest.Builder builder = timed(newRequest(url, headers), timeoutMs)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body, java.nio.charset.StandardCharsets.UTF_8));
        return send(builder.build(), timeoutMs);
    }

    /** POST a JSON body — the common shape for the provider chat endpoints. */
    public static Raw postJson(String url, String json, int timeoutMs) {
        return post(url, json, Map.of(), timeoutMs);
    }

    /** Parsed JSON for a 2xx response, otherwise {@code null}. */
    public static JsonNode getJson(String url, int timeoutMs) {
        Raw raw = get(url, timeoutMs);
        return raw.ok() ? raw.json() : null;
    }

    /** Response text for a 2xx response, otherwise {@code null}. */
    public static String getText(String url, int timeoutMs) {
        Raw raw = get(url, timeoutMs);
        return raw.ok() ? raw.body() : null;
    }

    /**
     * Streaming GET used for SSE (Groq/Ollama token streams). The status line
     * is delivered first, then every chunk of the body as it arrives, so the
     * caller can parse incrementally instead of waiting for the whole stream.
     */
    public static int stream(String url, Map<String, String> headers, int timeoutMs, ChunkSink sink) throws Exception {
        HttpRequest request = timed(newRequest(url, headers), timeoutMs).GET().build();

        HttpResponse<java.io.InputStream> response =
                CLIENT.send(request, HttpResponse.BodyHandlers.ofInputStream());
        int status = response.statusCode();
        try (java.io.InputStream in = response.body()) {
            sink.onStatus(status);
            if (status >= 400) {
                // Providers put the useful wording in the error body; callers
                // match on it exactly like `await res.text()` did.
                sink.onChunk(new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
                return status;
            }
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                if (read > 0) {
                    sink.onChunk(new String(buffer, 0, read, java.nio.charset.StandardCharsets.UTF_8));
                }
            }
        }
        return status;
    }

    /** Receives streamed body fragments. */
    @FunctionalInterface
    public interface ChunkSink {
        void onChunk(String text) throws Exception;

        default void onStatus(int status) {
        }
    }

    /**
     * Applies the caller's headers, adding the defaults ONLY when the caller
     * has not set them itself. {@code Builder.header()} appends, so blindly
     * adding {@code Accept}/{@code User-Agent} put two header lines on the wire
     * — enough for some upstreams (OctoTrip answered 406, eRail 400) to reject
     * a request the TypeScript original would have made fine.
     */
    private static HttpRequest.Builder newRequest(String url, Map<String, String> headers) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url));
        if (!hasHeader(headers, "User-Agent")) {
            builder.header("User-Agent", "TripCraft/1.0");
        }
        if (!hasHeader(headers, "Accept")) {
            builder.header("Accept", "*/*");
        }
        if (headers != null) {
            headers.forEach(builder::header);
        }
        return builder;
    }

    private static boolean hasHeader(Map<String, String> headers, String name) {
        if (headers == null || headers.isEmpty()) {
            return false;
        }
        return headers.keySet().stream().anyMatch(k -> k.equalsIgnoreCase(name));
    }

    private static HttpRequest.Builder timed(HttpRequest.Builder builder, int timeoutMs) {
        // Guards the response deadline, matching AbortSignal.timeout() in the
        // TypeScript. Streaming bodies get their own watchdog instead.
        int ms = timeoutMs > 0 ? timeoutMs : 30_000;
        return builder.timeout(Duration.ofMillis(ms));
    }

    private static Raw send(HttpRequest request, int timeoutMs) {
        try {
            HttpResponse<String> response = CLIENT.send(
                    request, HttpResponse.BodyHandlers.ofString(java.nio.charset.StandardCharsets.UTF_8));
            return new Raw(response.statusCode(), response.body() == null ? "" : response.body());
        } catch (java.net.http.HttpTimeoutException e) {
            return new Raw(0, "");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Raw(0, "");
        } catch (Exception e) {
            return new Raw(0, e.getMessage() == null ? "" : e.getMessage());
        }
    }
}
