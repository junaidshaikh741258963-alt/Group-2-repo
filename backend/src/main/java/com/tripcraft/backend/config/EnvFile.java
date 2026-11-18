package com.tripcraft.backend.config;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Loads {@code .env.local} from the frontend project root.
 *
 * <p>The original Next.js app read these keys through its own env pipeline, so
 * the port has to honour the same file: real GROQ/SERPAPI/GEMINI/OLLAMA keys
 * and the MySQL credentials live there rather than in application.yml.
 *
 * <p>Values are pushed as <em>system</em> properties before the Spring context
 * starts, which is why {@link com.tripcraft.backend.TravelPlannerApplication}
 * calls {@link #load()} before {@code SpringApplication.run}. A real process
 * environment variable still wins, so production can override the file.
 */
public final class EnvFile {

    private static final Map<String, String> LOADED = new LinkedHashMap<>();
    private static boolean done;

    private EnvFile() {
    }

    /**
     * Idempotent. Parses {@code KEY=VALUE} lines, ignoring blanks and {@code #}
     * comments, and strips optional surrounding quotes.
     */
    public static synchronized Map<String, String> load() {
        if (done) {
            return LOADED;
        }
        done = true;
        Path file = locate();
        if (file == null) {
            return LOADED;
        }
        final List<String> lines;
        try {
            lines = Files.readAllLines(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            // A missing/unreadable file is not fatal: system properties and
            // real env vars still configure the app.
            return LOADED;
        }
        for (String raw : lines) {
            String line = raw.trim();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            if (line.startsWith("export ")) {
                line = line.substring(7).trim();
            }
            int eq = line.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String key = line.substring(0, eq).trim();
            if (!key.matches("[A-Za-z_][A-Za-z0-9_]*")) {
                continue;
            }
            String value = line.substring(eq + 1).trim();
            if (value.length() >= 2
                    && ((value.startsWith("\"") && value.endsWith("\""))
                    || (value.startsWith("'") && value.endsWith("'")))) {
                value = value.substring(1, value.length() - 1);
            }
            if (value.isEmpty()) {
                continue;
            }
            LOADED.put(key, value);
            // System properties beat OS env in Spring's relaxed binding order
            // only for the same source, so set both without clobbering a real
            // environment variable that the operator exported deliberately.
            if (System.getProperty(key) == null && System.getenv(key) == null) {
                System.setProperty(key, value);
            }
        }
        return LOADED;
    }

    /** Direct read for callers that need a value without exposing it to Spring. */
    public static String get(String key) {
        load();
        String env = System.getenv(key);
        if (env != null && !env.isEmpty()) {
            return env;
        }
        return System.getProperty(key);
    }

    /**
     * backend/ sits directly under the project root, so {@code ../.env.local}
     * is the usual location; the extra candidates keep it working when the jar
     * is launched from a different working directory.
     */
    private static Path locate() {
        String[] candidates = {
            "../.env.local",
            ".env.local",
            "../../ai-travel-planner/.env.local",
            System.getProperty("travelplanner.root", "") + "/.env.local"
        };
        for (String candidate : candidates) {
            if (candidate == null || candidate.isEmpty() || candidate.startsWith("/")) {
                continue;
            }
            Path path = Paths.get(candidate).normalize();
            if (Files.isRegularFile(path)) {
                return path;
            }
        }
        // Absolute fallback: walk up from the working directory.
        Path dir = Paths.get("").toAbsolutePath();
        for (int i = 0; i < 5 && dir != null; i++) {
            Path candidate = dir.resolve(".env.local");
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        return null;
    }
}
