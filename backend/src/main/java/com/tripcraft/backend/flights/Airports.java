package com.tripcraft.backend.flights;

import java.text.Collator;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.infra.Json;

/**
 * Port of {@code src/lib/airports.ts} — local airport index (IATA codes, city,
 * country) bundled from the open airport-codes dataset so flight autocomplete
 * and station resolution keep working without any third-party key.
 *
 * <p>The dataset itself is embedded in {@link AirportData}; lookup precedence
 * (IATA code > city prefix > name prefix > city contains > name contains) and
 * the tie-breaks (major airports first, then name) are reproduced exactly.
 */
public final class Airports {

    /** Dataset entry: {@code c}=IATA, {@code n}=name, {@code y}=city, {@code k}=country, {@code t}=0 major / 1 regional. */
    public record LocalAirport(String c, String n, String y, String k, Integer t) {
    }

    /** One entry of the {@code airports} array on a suggestion. */
    public record AirportRef(String code, String name, String distance) {
    }

    /**
     * Port of the {@code AirportSuggestion} interface. Optional TS fields
     * ({@code subtitle?}, {@code code?}, {@code distance?}) are {@code null}
     * here and drop out of the JSON when absent — {@code subtitle} is omitted
     * when empty because the TS computes it with {@code || undefined}.
     */
    public record AirportSuggestion(String id, String title, String subtitle, String type,
                                    String code, List<AirportRef> airports) {

        public ObjectNode toJson() {
            ObjectNode node = Json.obj();
            node.put("id", id);
            node.put("title", title);
            Json.putIfPresent(node, "subtitle", subtitle);
            node.put("type", type);
            if (code != null) {
                node.put("code", code);
            }
            ArrayNode list = node.putArray("airports");
            for (AirportRef ref : airports) {
                ObjectNode air = Json.obj();
                air.put("code", ref.code());
                air.put("name", ref.name());
                Json.putIfPresent(air, "distance", ref.distance());
                list.add(air);
            }
            return node;
        }
    }

    private record Scored(LocalAirport ap, int score) {
    }

    private static final Pattern COMBINING = Pattern.compile("[\u0300-\u036f]");
    private static final Pattern CODE3 = Pattern.compile("[A-Za-z]{3}");

    private static final Map<String, String> COUNTRY_NAMES = Map.ofEntries(
            Map.entry("IN", "India"),
            Map.entry("US", "United States"),
            Map.entry("GB", "United Kingdom"),
            Map.entry("DE", "Germany"),
            Map.entry("FR", "France"),
            Map.entry("ES", "Spain"),
            Map.entry("IT", "Italy"),
            Map.entry("NL", "Netherlands"),
            Map.entry("PT", "Portugal"),
            Map.entry("IE", "Ireland"),
            Map.entry("CH", "Switzerland"),
            Map.entry("AT", "Austria"),
            Map.entry("SE", "Sweden"),
            Map.entry("NO", "Norway"),
            Map.entry("DK", "Denmark"),
            Map.entry("FI", "Finland"),
            Map.entry("PL", "Poland"),
            Map.entry("CZ", "Czechia"),
            Map.entry("GR", "Greece"),
            Map.entry("TR", "Turkey"),
            Map.entry("AE", "United Arab Emirates"),
            Map.entry("QA", "Qatar"),
            Map.entry("SA", "Saudi Arabia"),
            Map.entry("EG", "Egypt"),
            Map.entry("ZA", "South Africa"),
            Map.entry("KE", "Kenya"),
            Map.entry("NG", "Nigeria"),
            Map.entry("MA", "Morocco"),
            Map.entry("TH", "Thailand"),
            Map.entry("SG", "Singapore"),
            Map.entry("MY", "Malaysia"),
            Map.entry("ID", "Indonesia"),
            Map.entry("VN", "Vietnam"),
            Map.entry("PH", "Philippines"),
            Map.entry("CN", "China"),
            Map.entry("JP", "Japan"),
            Map.entry("KR", "South Korea"),
            Map.entry("HK", "Hong Kong"),
            Map.entry("TW", "Taiwan"),
            Map.entry("AU", "Australia"),
            Map.entry("NZ", "New Zealand"),
            Map.entry("CA", "Canada"),
            Map.entry("MX", "Mexico"),
            Map.entry("BR", "Brazil"),
            Map.entry("AR", "Argentina"),
            Map.entry("CL", "Chile"),
            Map.entry("CO", "Colombia"),
            Map.entry("PE", "Peru"),
            Map.entry("RU", "Russia"),
            Map.entry("UA", "Ukraine"),
            Map.entry("IL", "Israel"),
            Map.entry("JO", "Jordan"),
            Map.entry("LK", "Sri Lanka"),
            Map.entry("NP", "Nepal"),
            Map.entry("BD", "Bangladesh"),
            Map.entry("PK", "Pakistan"),
            Map.entry("KZ", "Kazakhstan"),
            Map.entry("IS", "Iceland"),
            Map.entry("LU", "Luxembourg"),
            Map.entry("BE", "Belgium"),
            Map.entry("HR", "Croatia"),
            Map.entry("HU", "Hungary"),
            Map.entry("RO", "Romania"),
            Map.entry("BG", "Bulgaria"));

    private static final List<LocalAirport> AIRPORTS = load();

    private Airports() {
    }

    private static List<LocalAirport> load() {
        JsonNode arr = Json.parseOrNull(AirportData.json());
        List<LocalAirport> out = new ArrayList<>();
        for (JsonNode n : Json.elements(arr)) {
            if (n == null || !n.isObject()) {
                continue;
            }
            JsonNode t = n.get("t");
            out.add(new LocalAirport(
                    Json.optStr(n, "c", ""),
                    Json.optStr(n, "n", ""),
                    Json.optStr(n, "y", ""),
                    Json.optStr(n, "k", ""),
                    t != null && t.isNumber() ? t.asInt() : null));
        }
        return out;
    }

    /** TS {@code normalize()} — lowercase, strip diacritics, trim. */
    private static String normalize(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String s = value.toLowerCase(Locale.ROOT);
        s = Normalizer.normalize(s, Normalizer.Form.NFD);
        s = COMBINING.matcher(s).replaceAll("");
        return s.trim();
    }

    private static String countryLabel(String code) {
        if (code == null || code.isEmpty()) {
            return "";
        }
        String upper = code.toUpperCase(Locale.ROOT);
        return COUNTRY_NAMES.getOrDefault(upper, upper);
    }

    private static Integer score(String q, LocalAirport ap) {
        String code = ap.c().toLowerCase(Locale.ROOT);
        String city = normalize(ap.y());
        String name = normalize(ap.n());
        if (code.equals(q)) {
            return 0;
        }
        if (!city.isEmpty() && city.startsWith(q)) {
            return 1;
        }
        if (name.startsWith(q)) {
            return 2;
        }
        if (!city.isEmpty() && city.contains(q)) {
            return 3;
        }
        if (name.contains(q)) {
            return 4;
        }
        return null;
    }

    private static String subtitle(LocalAirport ap) {
        List<String> parts = new ArrayList<>();
        if (ap.y() != null && !ap.y().isEmpty()) {
            parts.add(ap.y());
        }
        String country = countryLabel(ap.k());
        if (!country.isEmpty()) {
            parts.add(country);
        }
        return parts.isEmpty() ? null : String.join(", ", parts);
    }

    /** Ranked local matches for an airport/city query (code > city > name). */
    public static List<AirportSuggestion> searchLocalAirports(String rawQuery, int limit) {
        String q = normalize(rawQuery);
        if (q.length() < 2) {
            return List.of();
        }

        List<Scored> scored = new ArrayList<>();
        for (LocalAirport ap : AIRPORTS) {
            Integer s = score(q, ap);
            if (s == null) {
                continue;
            }
            scored.add(new Scored(ap, s));
        }
        // score || (t ?? 0) || name.localeCompare — stable sort, locale-aware name tie-break.
        Collator collator = Collator.getInstance(Locale.ENGLISH);
        scored.sort((a, b) -> {
            if (a.score() != b.score()) {
                return Integer.compare(a.score(), b.score());
            }
            int ta = a.ap().t() == null ? 0 : a.ap().t();
            int tb = b.ap().t() == null ? 0 : b.ap().t();
            if (ta != tb) {
                return Integer.compare(ta, tb);
            }
            return collator.compare(a.ap().n(), b.ap().n());
        });

        List<AirportSuggestion> out = new ArrayList<>();
        int n = Math.min(limit, scored.size());
        for (int i = 0; i < n; i++) {
            LocalAirport ap = scored.get(i).ap();
            out.add(new AirportSuggestion(
                    "local:" + ap.c(),
                    ap.n(),
                    subtitle(ap),
                    "airport",
                    ap.c(),
                    List.of(new AirportRef(ap.c(), ap.n(), null))));
        }
        return out;
    }

    /** Best-effort airport code for a typed city/airport name. */
    public static String resolveLocalAirport(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            return null;
        }
        if (CODE3.matcher(value).matches()) {
            return value.toUpperCase(Locale.ROOT);
        }
        List<AirportSuggestion> first = searchLocalAirports(value, 1);
        if (first.isEmpty()) {
            return null;
        }
        List<AirportRef> refs = first.get(0).airports();
        return refs.isEmpty() ? null : refs.get(0).code();
    }
}
