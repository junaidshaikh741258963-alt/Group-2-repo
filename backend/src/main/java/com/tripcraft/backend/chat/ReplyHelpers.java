package com.tripcraft.backend.chat;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import com.tripcraft.backend.chat.AiSchema.AiReply;
import com.tripcraft.backend.chat.AiSchema.ItineraryDay;
import com.tripcraft.backend.chat.AiSchema.StructuredPlace;

/**
 * Client-side helpers for the structured AI reply — the port of
 * {@code aiReply.ts} (grouping, plan summary, profile folding). The card
 * vocabulary ({@link RecType}, {@link Recommendation}) mirrors the bits of
 * {@code recommendations.ts} these helpers need.
 */
public final class ReplyHelpers {

    private ReplyHelpers() {
    }

    /** The card categories the renderer knows, plus the airport extra. */
    public enum RecType {
        DESTINATION("destination", "📍", "#3b82f6", "Destination"),
        HOTEL("hotel", "🏨", "#a855f7", "Hotel"),
        RESTAURANT("restaurant", "🍽️", "#f97316", "Restaurant"),
        ATTRACTION("attraction", "🎯", "#10b981", "Attraction"),
        AIRPORT("airport", "✈️", "#38bdf8", "Airport");

        private final String wire;
        private final String emoji;
        private final String color;
        private final String label;

        RecType(String wire, String emoji, String color, String label) {
            this.wire = wire;
            this.emoji = emoji;
            this.color = color;
            this.label = label;
        }

        public String wire() {
            return wire;
        }

        public String emoji() {
            return emoji;
        }

        public String color() {
            return color;
        }

        public String label() {
            return label;
        }

        static RecType fromWire(String value) {
            for (RecType t : values()) {
                if (t.wire.equals(value)) {
                    return t;
                }
            }
            return null;
        }
    }

    /** Maps a raw category string ("hotel", "museum", "resort"…) to a RecType. */
    public static RecType coerceType(String value) {
        String t = Js.lower(Js.trim(value == null ? "" : value));
        if (VALID_TYPES.contains(t)) {
            return RecType.fromWire(t);
        }
        if (t.equals("attraction") || t.equals("sight") || t.equals("landmark") || t.equals("museum")) {
            return RecType.ATTRACTION;
        }
        if (t.equals("hostel") || t.equals("guesthouse") || t.equals("guest_house")
                || t.equals("motel") || t.equals("b&b") || t.equals("bnb") || t.equals("inn")
                || t.equals("lodge") || t.equals("lodging") || t.equals("resort")
                || t.equals("apartment")) {
            return RecType.HOTEL;
        }
        return RecType.ATTRACTION;
    }

    private static final java.util.Set<String> VALID_TYPES =
            java.util.Set.of("destination", "hotel", "restaurant", "attraction");

    /** One recommendation card as the chat helpers see it (optional parts null). */
    public record Recommendation(
            String id,
            String name,
            RecType type,
            Double lat,
            Double lng,
            String city,
            String description,
            Double rating,
            Integer reviews,
            String price,
            String source,
            String image,
            String propertyToken,
            String link) {
    }

    /** A labelled strip of same-category cards. */
    public record CardGroup(RecType type, String label, String color, List<Recommendation> items) {
    }

    /** Presentation order: where you're going → what you do → where you eat → where you sleep. */
    private static final List<RecType> CATEGORY_ORDER =
            List.of(RecType.DESTINATION, RecType.ATTRACTION, RecType.RESTAURANT, RecType.HOTEL);

    /**
     * Group a reply's places by card category (destination / attraction /
     * restaurant / hotel) so each group renders as its own labelled strip.
     * Groups follow CATEGORY_ORDER; unknown labels fall back to "attraction".
     */
    public static List<CardGroup> groupCardsByCategory(List<Recommendation> items) {
        Map<RecType, List<Recommendation>> buckets = new EnumMap<>(RecType.class);
        for (Recommendation item : items) {
            buckets.computeIfAbsent(item.type(), k -> new ArrayList<>()).add(item);
        }
        List<CardGroup> ordered = new ArrayList<>();
        for (RecType type : CATEGORY_ORDER) {
            List<Recommendation> bucket = buckets.get(type);
            if (bucket != null) {
                ordered.add(new CardGroup(type, type.label(), type.color(), bucket));
            }
        }
        return ordered;
    }

    /**
     * Which stage chip answer the follow-up question belongs to, so tapping a
     * chip lands on the right profile field. Falls back to the stage machine
     * when the question doesn't map to one.
     */
    public static PlanningField deriveFieldFromReply(AiReply reply, TripProfile profile) {
        String question = Js.trim(reply.followUpQuestion());
        if (!question.isEmpty()) {
            PlanningField inferred = ProfileLogic.inferQuestionField(question);
            if (inferred != null) {
                return inferred;
            }
        }
        return ProfileLogic.nextField(profile);
    }

    /** The reply's chips, capped at three as per the prompt contract. */
    public static List<String> replySuggestions(AiReply reply) {
        return new ArrayList<>(reply.suggestions().subList(0, Math.min(3, reply.suggestions().size())));
    }

    /** Map a raw {@code category} string from the model onto a card type. */
    public static RecType categoryToType(String category) {
        return coerceType(category);
    }

    /**
     * Compact "what is currently on the table" block echoed back on the next
     * request, so "make it cheaper" edits this plan instead of starting over.
     */
    public static String planSummary(AiReply reply) {
        if (reply == null) {
            return "";
        }
        List<String> lines = new ArrayList<>();
        if (Js.truthy(reply.destination())) {
            lines.add("destination: " + reply.destination());
        }
        if (Js.truthy(reply.dates())) {
            lines.add("dates: " + reply.dates());
        }
        if (reply.places().size() > 0) {
            List<String> names = new ArrayList<>();
            for (StructuredPlace p : reply.places()) {
                List<String> facts = new ArrayList<>();
                if (Js.truthy(p.city())) {
                    facts.add(p.city());
                }
                if (Js.truthy(p.priceLevel())) {
                    facts.add(p.priceLevel());
                } else if (Js.truthy(p.cost())) {
                    facts.add(p.cost());
                }
                if (Js.truthy(p.duration())) {
                    facts.add(p.duration());
                }
                String joined = String.join(", ", facts);
                names.add(p.name() + (!joined.isEmpty() ? " (" + joined + ")" : ""));
            }
            lines.add("places: " + String.join(", ", names));
        }
        for (ItineraryDay day : reply.itinerary()) {
            List<String> stops = new ArrayList<>();
            for (var i : day.items()) {
                List<String> parts = new ArrayList<>();
                if (Js.truthy(i.title())) {
                    parts.add(i.title());
                }
                if (Js.truthy(i.duration())) {
                    parts.add(i.duration());
                }
                if (Js.truthy(i.cost())) {
                    parts.add(i.cost());
                }
                String stop = String.join(" · ", parts);
                if (!stop.isEmpty()) {
                    stops.add(stop);
                }
            }
            if (stops.size() > 0) {
                lines.add("day " + day.day() + ": " + String.join(" → ", stops));
            }
        }
        if (Js.truthy(reply.followUpQuestion())) {
            lines.add("last question asked: " + reply.followUpQuestion());
        }
        return String.join("\n", lines);
    }

    /**
     * Fold what the model learned this turn back into the trip context, so the
     * next request never re-asks for the destination or the dates.
     *
     * <p>Returns the SAME profile instance when nothing changed (cheap identity
     * check — the caller writes the profile after every message).
     */
    public static TripProfile mergeProfileFromReply(TripProfile profile, AiReply reply) {
        String destination = Js.trim(reply.destination());
        if (destination.isEmpty()) {
            destination = null;
        }
        String dates = Js.trim(reply.dates());
        if (dates.isEmpty()) {
            dates = null;
        }
        if (Objects.equals(destination, profile.destination) && Objects.equals(dates, profile.dates)) {
            return profile;
        }
        profile.destination = destination != null ? destination : profile.destination;
        profile.dates = dates != null ? dates : profile.dates;
        return profile;
    }
}
