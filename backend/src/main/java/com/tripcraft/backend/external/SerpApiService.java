package com.tripcraft.backend.external;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.config.EnvFile;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;

/**
 * Port of {@code src/lib/serpapi.ts} — the ONLY place in the backend that
 * talks to serpapi.com. Routes, RAG retrievers and hotel/flight search all go
 * through {@link #search}, and {@code null} always means "use the free
 * fallback".
 *
 * <p>Rotation policy is preserved verbatim: one key at a time, advancing only
 * when the active key fails on its limit (quota 429, 401/403, invalid key),
 * with exhausted keys skipped until the 1st of the next month (or a 10 minute
 * cooldown for a transient rate limit). Only key <em>indexes</em> are ever
 * logged.
 */
@Service
public class SerpApiService {

    private static final Logger log = LoggerFactory.getLogger(SerpApiService.class);
    private static final int SERP_TIMEOUT = 12_000;
    private static final Path STATE_FILE = Paths.get(".data", "serpapi-state.json");

    /** Survives restarts the way {@code globalThis} survived dev reloads. */
    private static final Object LOCK = new Object();
    private static State state;
    private static String warnedAllExhaustedFor = "";

    /**
     * Mutable on purpose: the TypeScript original is a plain object that
     * survives in {@code globalThis}, and the rotation loop advances
     * {@code activeIndex} in place.
     */
    private static final class State {
        int activeIndex;
        final Map<String, Long> exhaustedUntil;
        final Map<String, String> exhaustedReason;
        final Map<String, Integer> calls;
        final Map<String, Boolean> warned80;
        String month;

        State(int activeIndex, Map<String, Long> exhaustedUntil, Map<String, String> exhaustedReason,
              Map<String, Integer> calls, Map<String, Boolean> warned80, String month) {
            this.activeIndex = activeIndex;
            this.exhaustedUntil = new LinkedHashMap<>(exhaustedUntil);
            this.exhaustedReason = new LinkedHashMap<>(exhaustedReason);
            this.calls = new LinkedHashMap<>(calls);
            this.warned80 = new LinkedHashMap<>(warned80);
            this.month = month;
        }
    }

    private enum Exhaustion { QUOTA, INVALID, TRANSIENT, NONE }

    // ---------------------------------------------------------------- keys

    /** Parsed fresh each call so editing .env.local is all you ever do. */
    public static List<String> loadKeys() {
        List<String> out = new ArrayList<>();
        for (String part : splitKeys(EnvFile.get("SERPAPI_KEYS"))) {
            String k = part.trim();
            if (!k.isEmpty() && !out.contains(k)) {
                out.add(k);
            }
        }
        String legacy = EnvFile.get("SERPAPI_KEY");
        if (legacy != null && !legacy.trim().isEmpty() && !out.contains(legacy.trim())) {
            out.add(legacy.trim());
        }
        return out;
    }

    private static List<String> splitKeys(String raw) {
        List<String> out = new ArrayList<>();
        if (raw == null || raw.isEmpty()) {
            return out;
        }
        for (String part : raw.split("[,\\n]")) {
            out.add(part);
        }
        return out;
    }

    public boolean available() {
        List<String> keys = loadKeys();
        if (keys.isEmpty()) {
            return false;
        }
        synchronized (LOCK) {
            State s = loadState();
            long now = System.currentTimeMillis();
            return keys.stream().anyMatch(k -> s.exhaustedUntil.getOrDefault(keyId(k), 0L) <= now);
        }
    }

    // ---------------------------------------------------------------- state

    private static int monthlyLimit() {
        String raw = EnvFile.get("SERPAPI_MONTHLY_LIMIT");
        if (raw != null) {
            try {
                double n = Double.parseDouble(raw);
                if (n > 0) {
                    return (int) Math.floor(n);
                }
            } catch (NumberFormatException ignored) {
                // fall through to the default
            }
        }
        return 100;
    }

    private static String currentMonth() {
        return LocalDate.now().format(DateTimeFormatter.ofPattern("yyyy-MM"));
    }

    private static long firstOfNextMonth() {
        LocalDate now = LocalDate.now();
        LocalDate first = now.withDayOfMonth(1).plusMonths(1);
        return first.atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli();
    }

    /** Non-crypto fingerprint so per-key state survives without storing keys. */
    private static String keyId(String key) {
        int h = 5381;
        for (int i = 0; i < key.length(); i++) {
            h = ((h << 5) + h + key.charAt(i)) & 0xFFFFFFFF;
        }
        return Integer.toHexString(h);
    }

    private static State freshState() {
        return new State(0, Map.of(), Map.of(), Map.of(), Map.of(), currentMonth());
    }

    private static State loadState() {
        if (state == null) {
            State fromFile = readStateFile();
            state = fromFile != null ? fromFile : freshState();
        }
        String month = currentMonth();
        if (!month.equals(state.month)) {
            // Monthly reset: quotas refresh on the 1st.
            state.month = month;
            state.exhaustedUntil.clear();
            state.exhaustedReason.clear();
            state.calls.clear();
            state.warned80.clear();
        }
        if (state.activeIndex < 0) {
            state.activeIndex = 0;
        }
        return state;
    }

    private static void saveState() {
        writeStateFile(state);
    }

    private static State readStateFile() {
        try {
            if (!Files.isRegularFile(STATE_FILE)) {
                return null;
            }
            JsonNode parsed = Json.parseOrNull(Files.readString(STATE_FILE, StandardCharsets.UTF_8));
            if (parsed == null || !parsed.isObject()) {
                return null;
            }
            State fresh = freshState();
            Map<String, Long> until = new LinkedHashMap<>(fresh.exhaustedUntil);
            Map<String, String> reason = new LinkedHashMap<>(fresh.exhaustedReason);
            Map<String, Integer> calls = new LinkedHashMap<>(fresh.calls);
            Map<String, Boolean> warned = new LinkedHashMap<>(fresh.warned80);
            parsed.get("exhaustedUntil").fields().forEachRemaining(e -> until.put(e.getKey(), e.getValue().asLong()));
            parsed.get("exhaustedReason").fields().forEachRemaining(e -> reason.put(e.getKey(), e.getValue().asText()));
            parsed.get("calls").fields().forEachRemaining(e -> calls.put(e.getKey(), e.getValue().asInt()));
            parsed.get("warned80").fields().forEachRemaining(e -> warned.put(e.getKey(), e.getValue().asBoolean()));
            return new State(parsed.path("activeIndex").asInt(0), until, reason, calls, warned,
                    parsed.path("month").asText(currentMonth()));
        } catch (Exception e) {
            return null;
        }
    }

    private static void writeStateFile(State s) {
        if (s == null) {
            return;
        }
        try {
            Files.createDirectories(STATE_FILE.getParent());
            ObjectNode node = Json.obj();
            node.put("activeIndex", s.activeIndex);
            node.put("month", s.month);
            ObjectNode until = node.putObject("exhaustedUntil");
            s.exhaustedUntil.forEach(until::put);
            ObjectNode reason = node.putObject("exhaustedReason");
            s.exhaustedReason.forEach(reason::put);
            ObjectNode calls = node.putObject("calls");
            s.calls.forEach(calls::put);
            ObjectNode warned = node.putObject("warned80");
            s.warned80.forEach(warned::put);
            Files.writeString(STATE_FILE, Json.write(node), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // Best effort only (read-only filesystems, serverless, etc.).
        }
    }

    // ---------------------------------------------------------------- search

    /**
     * The single SerpAPI funnel. Only the active key is used; on a limit
     * failure the key is marked skipped, the pointer advances, and the same
     * request is retried immediately.
     */
    public JsonNode search(Map<String, Object> params, int timeoutMs) {
        List<String> keys = loadKeys();
        if (keys.isEmpty()) {
            return null;
        }
        int timeout = timeoutMs > 0 ? timeoutMs : SERP_TIMEOUT;
        int limit = monthlyLimit();
        List<Integer> tried = new ArrayList<>();

        synchronized (LOCK) {
            State s = loadState();
            long now = System.currentTimeMillis();

            while (tried.size() < keys.size()) {
                int idx = -1;
                boolean activeUsable = s.activeIndex >= 0 && s.activeIndex < keys.size()
                        && !tried.contains(s.activeIndex)
                        && s.exhaustedUntil.getOrDefault(keyId(keys.get(s.activeIndex)), 0L) <= now;
                if (activeUsable) {
                    idx = s.activeIndex;
                } else {
                    for (int i = 0; i < keys.size(); i++) {
                        if (tried.contains(i)) {
                            continue;
                        }
                        if (s.exhaustedUntil.getOrDefault(keyId(keys.get(i)), 0L) <= System.currentTimeMillis()) {
                            idx = i;
                            break;
                        }
                    }
                }
                if (idx == -1) {
                    break;
                }
                tried.add(idx);

                String id = keyId(keys.get(idx));
                String callKey = s.month + ":" + id;
                int calls = s.calls.getOrDefault(callKey, 0) + 1;
                s.calls.put(callKey, calls);
                if (!s.warned80.getOrDefault(callKey, false) && calls >= limit * 0.8) {
                    s.warned80.put(callKey, true);
                    log.warn("[serpapi] key #{}/{} at {}/{} monthly calls (80%)",
                            idx + 1, keys.size(), calls, limit);
                }
                saveState();

                String url = buildUrl(params, keys.get(idx));
                Http.Raw raw = Http.get(url, timeout);
                if (raw.status() == 0) {
                    log.error("[serpapi] key #{}/{} network error", idx + 1, keys.size());
                    return null;
                }

                if (raw.ok()) {
                    if (s.activeIndex != idx) {
                        s.activeIndex = idx;
                        saveState();
                    }
                    return raw.json();
                }

                String text = raw.body() == null ? "" : raw.body();
                Exhaustion kind = exhaustionKind(raw.status(), text);
                if (kind != Exhaustion.NONE) {
                    markSkipped(s, idx, keys.size(), kind,
                            kind == Exhaustion.TRANSIENT
                                    ? "HTTP " + raw.status() + " rate-limited"
                                    : kind == Exhaustion.QUOTA
                                    ? "HTTP " + raw.status() + " quota exhausted"
                                    : "HTTP " + raw.status() + " invalid key");
                    saveState();
                    continue; // retry immediately on the next key
                }
                log.error("[serpapi] key #{}/{} status {} ({})",
                        idx + 1, keys.size(), raw.status(), params.get("engine"));
                return null;
            }

            String windowKey = currentMonth() + ":" + keys.size();
            if (!warnedAllExhaustedFor.equals(windowKey)) {
                warnedAllExhaustedFor = windowKey;
                log.warn("[serpapi] WARNING: all {} key(s) exhausted or cooling down — using free fallbacks",
                        keys.size());
            }
            return null;
        }
    }

    /** Convenience overload matching the usual {@code SERP_TIMEOUT}. */
    public JsonNode search(Map<String, Object> params) {
        return search(params, SERP_TIMEOUT);
    }

    private static String buildUrl(Map<String, Object> params, String key) {
        StringBuilder sb = new StringBuilder("https://serpapi.com/search?");
        try {
            for (Map.Entry<String, Object> e : params.entrySet()) {
                Object v = e.getValue();
                if (v == null) {
                    continue;
                }
                String s = String.valueOf(v);
                if (s.isEmpty()) {
                    continue;
                }
                sb.append(java.net.URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8))
                        .append('=')
                        .append(java.net.URLEncoder.encode(s, StandardCharsets.UTF_8))
                        .append('&');
            }
            sb.append("api_key=").append(java.net.URLEncoder.encode(key, StandardCharsets.UTF_8));
            String encoded = sb.toString();
            if (!params.containsKey("hl")) {
                encoded += "&hl=en";
            }
            if (!params.containsKey("gl")) {
                encoded += "&gl=us";
            }
            return encoded;
        } catch (Exception e) {
            return "https://serpapi.com/search";
        }
    }

    private static Exhaustion exhaustionKind(int status, String text) {
        if (status == 401 || status == 403) {
            return Exhaustion.INVALID;
        }
        if (status == 429) {
            return text.matches("(?s).*(out of searches|run out|quota|exhausted|billing|limit).*")
                    ? Exhaustion.QUOTA
                    : Exhaustion.TRANSIENT;
        }
        if (text.matches("(?s).*(invalid api key|unauthorized|access denied|forbidden).*")) {
            return Exhaustion.INVALID;
        }
        return Exhaustion.NONE;
    }

    private static void markSkipped(State s, int index, int total, Exhaustion kind, String reason) {
        List<String> keys = loadKeys();
        String id = keyId(index < keys.size() ? keys.get(index) : String.valueOf(index));
        long now = System.currentTimeMillis();
        if (kind == Exhaustion.TRANSIENT) {
            s.exhaustedUntil.put(id, now + 10 * 60_000L);
            s.exhaustedReason.put(id, "rate-limited (" + reason + "), retry in 10 min");
        } else {
            s.exhaustedUntil.put(id, firstOfNextMonth());
            s.exhaustedReason.put(id, reason);
        }
        log.warn("[serpapi] key #{} skipped: {}", index + 1, reason);
        // Advance the active pointer to the next usable key.
        List<String> fresh = loadKeys();
        for (int step = 1; step <= total; step++) {
            int next = (index + step) % total;
            String nid = keyId(next < fresh.size() ? fresh.get(next) : String.valueOf(next));
            if (s.exhaustedUntil.getOrDefault(nid, 0L) <= System.currentTimeMillis()) {
                s.activeIndex = next;
                break;
            }
        }
    }

    // ------------------------------------------------------------- helpers

    /** Resolve a google_hotels property_token from a token or hotel name. */
    public String resolvePropertyToken(String propertyToken, String name) {
        if (propertyToken != null && !propertyToken.isEmpty()) {
            return propertyToken;
        }
        String q = name == null ? "" : name.trim();
        if (q.isEmpty()) {
            return null;
        }
        LocalDate today = LocalDate.now();
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("engine", "google_hotels");
        params.put("q", q);
        params.put("check_in_date", today.plusDays(14).toString());
        params.put("check_out_date", today.plusDays(17).toString());
        params.put("adults", 2);
        params.put("currency", "USD");
        JsonNode data = search(params);
        if (data == null) {
            return null;
        }
        String hit = null;
        for (JsonNode p : Json.elements(data.get("properties"))) {
            String token = p.path("property_token").asText("");
            if (token.isEmpty()) {
                continue;
            }
            if (hit == null) {
                hit = token;
            }
            String pname = p.path("name").asText("");
            if (pname.equalsIgnoreCase(q)) {
                return token;
            }
        }
        return hit;
    }

    /** Read-only snapshot for the dev-only /api/serpapi-status route. No secrets. */
    public JsonNode status() {
        List<String> keys = loadKeys();
        synchronized (LOCK) {
            State s = loadState();
            long now = System.currentTimeMillis();
            ObjectNode out = Json.obj();
            out.put("keys", keys.size());
            out.put("activeIndex", keys.isEmpty() ? -1 : Math.min(s.activeIndex, keys.size() - 1));
            out.put("month", s.month);
            out.put("monthlyLimit", monthlyLimit());
            var exhausted = out.putArray("exhausted");
            for (int i = 0; i < keys.size(); i++) {
                String id = keyId(keys.get(i));
                long until = s.exhaustedUntil.getOrDefault(id, 0L);
                if (until > now) {
                    var e = exhausted.addObject();
                    e.put("index", i);
                    e.put("reason", s.exhaustedReason.getOrDefault(id, "skipped"));
                    e.put("retryAt", until);
                }
            }
            var callsThisMonth = out.putArray("callsThisMonth");
            for (int i = 0; i < keys.size(); i++) {
                var c = callsThisMonth.addObject();
                c.put("index", i);
                c.put("calls", s.calls.getOrDefault(s.month + ":" + keyId(keys.get(i)), 0));
            }
            return out;
        }
    }

    /** Exposed so the status route and tests can force a clean slate. */
    public static void resetForTests() {
        synchronized (LOCK) {
            state = freshState();
            warnedAllExhaustedFor = "";
        }
    }
}
