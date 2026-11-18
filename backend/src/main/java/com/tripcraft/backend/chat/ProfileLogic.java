package com.tripcraft.backend.chat;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Json;

/**
 * Conversation stage machine — the port of {@code tripProfile.ts}.
 *
 * <p>One stage per reply: destination → dates → people → budget → interests →
 * hotel → restaurants → attractions → itinerary (only on explicit user
 * request). duration/accommodation remain on the profile for legacy chats but
 * are no longer asked.
 */
public final class ProfileLogic {

    private ProfileLogic() {
    }

    /** Matches the TS regexes' {@code i} flag (JS {@code /i} is Unicode-aware). */
    private static final int RE_FLAGS = Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE;

    public static final TripProfile EMPTY_PROFILE = new TripProfile();

    /** Stage machine order — one stage per reply. */
    public static final List<PlanningField> FIELD_ORDER = List.of(
            PlanningField.DESTINATION,
            PlanningField.DATES,
            PlanningField.PEOPLE,
            PlanningField.BUDGET,
            PlanningField.INTERESTS,
            PlanningField.HOTEL,
            PlanningField.RESTAURANTS,
            PlanningField.ATTRACTIONS);

    /** Which stage chip answer a follow-up question belongs to. */
    public record PlanningHint(PlanningField field, List<String> chips) {
    }

    /** Hotel-search payload derived from the profile (optional parts stay null). */
    public record HotelsPayload(String destination, String checkIn, String checkOut, Integer adults) {
    }

    private static final String PLANNING_OPEN = "<planning>";
    private static final String PLANNING_CLOSE = "</planning>";
    private static final String OPEN_TAG = "<recommendations>";
    private static final String CLOSE_TAG = "</recommendations>";

    private static final Pattern REC_BLOCK =
            Pattern.compile("<recommendations>([\\s\\S]*?)</recommendations>");
    private static final Pattern TRAILING_FENCE =
            Pattern.compile("```(?:json)?\\s*$", Pattern.CASE_INSENSITIVE);

    /** TS truthiness for a profile slot: null and "" both mean "missing". */
    private static boolean filled(String v) {
        return v != null && !v.isEmpty();
    }

    // ------------------------------------------------------- meta blocks

    /**
     * Text of a message with every COMPLETE {@code <recommendations>} block
     * removed (an unclosed block — still streaming — is hidden too). This is
     * the text half of {@code splitRecommendations()} from
     * {@code recommendations.ts}; the item parsing lives with the card
     * rendering, this port only needs the visible text.
     */
    private static String stripRecommendationBlocks(String content) {
        int firstOpen = content.indexOf(OPEN_TAG);
        if (firstOpen == -1) {
            return content;
        }

        // Hide a block that is still streaming in (open tag with no close yet).
        int cutAt = content.length();
        for (int i = firstOpen; i != -1; i = content.indexOf(OPEN_TAG, i + 1)) {
            if (content.indexOf(CLOSE_TAG, i) == -1) {
                cutAt = i;
                break;
            }
        }

        StringBuilder text = new StringBuilder();
        int cursor = 0;
        Matcher m = REC_BLOCK.matcher(content);
        while (m.find()) {
            if (m.start() >= cutAt) {
                break;
            }
            text.append(content, cursor, m.start());
            cursor = m.end();
        }
        text.append(content, cursor, cutAt);

        return Js.trimEnd(TRAILING_FENCE.matcher(text.toString()).replaceFirst(""));
    }

    public static String stripMetaBlocks(String content) {
        String text = stripRecommendationBlocks(content);
        int open = text.indexOf(PLANNING_OPEN);
        if (open != -1) {
            text = text.substring(0, open);
        }
        return Js.trimEnd(TRAILING_FENCE.matcher(text).replaceFirst(""));
    }

    public static PlanningHint parsePlanning(String content) {
        int open = content.indexOf(PLANNING_OPEN);
        if (open == -1) {
            return null;
        }
        int close = content.indexOf(PLANNING_CLOSE, open);
        if (close == -1) {
            return null;
        }
        String raw = Js.trim(content.substring(open + PLANNING_OPEN.length(), close));
        JsonNode data = Json.parseOrNull(raw);
        if (data == null) {
            return null;
        }
        // TS: String(data.field || "").toLowerCase()
        String fieldValue = Json.optStr(data, "field", "");
        PlanningField field = PlanningField.fromWire(Js.lower(fieldValue));
        if (field == null) {
            return null;
        }
        List<String> chips = new ArrayList<>();
        JsonNode chipsNode = data.get("chips");
        if (chipsNode != null && chipsNode.isArray()) {
            for (JsonNode c : chipsNode) {
                if (c.isTextual()) {
                    chips.add(c.asText());
                }
                if (chips.size() >= 6) {
                    break;
                }
            }
        }
        return new PlanningHint(field, chips);
    }

    // ------------------------------------------------------ stage machine

    /** Every FIELD_ORDER slot except destination that is still empty. */
    public static List<PlanningField> missingFields(TripProfile profile) {
        List<PlanningField> missing = new ArrayList<>();
        for (PlanningField f : FIELD_ORDER) {
            if (f != PlanningField.DESTINATION && !filled(profile.get(f))) {
                missing.add(f);
            }
        }
        return missing;
    }

    public static boolean isProfileComplete(TripProfile profile) {
        for (PlanningField f : FIELD_ORDER) {
            if (!filled(profile.get(f))) {
                return false;
            }
        }
        return true;
    }

    /**
     * Stage machine. Returns the next stage to ask about.
     * {@code ITINERARY} = profile complete but the user has not explicitly
     * asked for the full plan yet (invite them, do not build it).
     * {@code DONE} = itinerary requested.
     */
    public static PlanningField nextField(TripProfile profile) {
        if (!filled(profile.destination)) {
            return PlanningField.DESTINATION;
        }
        for (PlanningField f : FIELD_ORDER) {
            if (!filled(profile.get(f))) {
                return f;
            }
        }
        return filled(profile.itinerary) ? PlanningField.DONE : PlanningField.ITINERARY;
    }

    public static boolean isReadyForItinerary(TripProfile profile) {
        return nextField(profile) == PlanningField.DONE;
    }

    public static String profileSummary(TripProfile profile) {
        List<PlanningField> missing = missingFields(profile);
        List<String> lines = new ArrayList<>();
        for (PlanningField f : FIELD_ORDER) {
            String v = profile.get(f);
            lines.add("- " + f.label() + ": " + (filled(v) ? v : "unknown"));
        }
        if (filled(profile.duration)) {
            lines.add("- Trip duration: " + profile.duration);
        }
        if (filled(profile.accommodation)) {
            lines.add("- Stay type: " + profile.accommodation);
        }
        if (filled(profile.itinerary)) {
            lines.add("- Itinerary: explicitly requested by the user");
        }
        StringBuilder missingLabels = new StringBuilder();
        for (PlanningField f : missing) {
            if (missingLabels.length() > 0) {
                missingLabels.append(", ");
            }
            missingLabels.append(f.label());
        }
        lines.add("- Missing: " + (missing.size() > 0 ? missingLabels.toString() : "none"));
        PlanningField next = nextField(profile);
        if (next == PlanningField.ITINERARY) {
            lines.add("- Next: profile complete — invite the user to create the itinerary (do NOT write it yet)");
        } else if (next == PlanningField.DONE) {
            lines.add("- Next: itinerary explicitly requested — build the full day-by-day plan");
        } else {
            lines.add("- Next single field to ask: " + next.label());
        }
        return String.join("\n", lines);
    }

    /** Which stage the assistant's follow-up question belongs to, if any. */
    public static PlanningField inferQuestionField(String question) {
        String q = Js.lower(question);
        if (P_INFER_ITINERARY.matcher(q).find()) {
            return PlanningField.ITINERARY;
        }
        if (P_INFER_DATES.matcher(q).find()) {
            return PlanningField.DATES;
        }
        if (P_INFER_PEOPLE.matcher(q).find()) {
            return PlanningField.PEOPLE;
        }
        if (P_INFER_BUDGET.matcher(q).find()) {
            return PlanningField.BUDGET;
        }
        if (P_INFER_INTERESTS.matcher(q).find()) {
            return PlanningField.INTERESTS;
        }
        if (P_INFER_HOTEL.matcher(q).find()) {
            return PlanningField.HOTEL;
        }
        if (P_INFER_RESTAURANTS.matcher(q).find()) {
            return PlanningField.RESTAURANTS;
        }
        if (P_INFER_ATTRACTIONS.matcher(q).find()) {
            return PlanningField.ATTRACTIONS;
        }
        if (P_INFER_DURATION.matcher(q).find()) {
            return PlanningField.DURATION;
        }
        if (P_INFER_STAY.matcher(q).find()) {
            return PlanningField.HOTEL;
        }
        if (P_INFER_DESTINATION.matcher(q).find()) {
            return PlanningField.DESTINATION;
        }
        return null;
    }

    private static final Pattern P_INFER_ITINERARY =
            Pattern.compile("\\b(itinerary|day-by-day|full plan|whole trip|build my trip|create my trip|final plan)\\b", RE_FLAGS);
    private static final Pattern P_INFER_DATES =
            Pattern.compile("\\b(date|dates|when are you|travel dates|which month|what month|depart|return)\\b", RE_FLAGS);
    private static final Pattern P_INFER_PEOPLE =
            Pattern.compile("\\b(people|person|travelers|travellers|adults?|kids?|children|how many|group size|couple|solo)\\b", RE_FLAGS);
    private static final Pattern P_INFER_BUDGET =
            Pattern.compile("\\b(budget|cost|price range|how much|spend|expensive|cheap)\\b", RE_FLAGS);
    private static final Pattern P_INFER_INTERESTS =
            Pattern.compile("\\b(interest|into|like to|prefer|vibe|theme|hobby)\\b", RE_FLAGS);
    private static final Pattern P_INFER_HOTEL =
            Pattern.compile("\\b(hotel|hostel|where to stay|accommodation|lodging|resort|airbnb|guesthouse|place to sleep)\\b", RE_FLAGS);
    private static final Pattern P_INFER_RESTAURANTS =
            Pattern.compile("\\b(restaurants?|where to eat|dining|food spots|meals?)\\b", RE_FLAGS);
    private static final Pattern P_INFER_ATTRACTIONS =
            Pattern.compile("\\b(attractions?|things to do|activities|sights|what to see)\\b", RE_FLAGS);
    private static final Pattern P_INFER_DURATION =
            Pattern.compile("\\b(duration|how long|how many days|days?|nights?|weekend|week)\\b", RE_FLAGS);
    private static final Pattern P_INFER_STAY =
            Pattern.compile("\\b(accommodation|where to stay|hotel|hostel|airbnb|lodging|stay|resort|guesthouse)\\b", RE_FLAGS);
    private static final Pattern P_INFER_DESTINATION =
            Pattern.compile("\\b(destination|where do you want|which city|where to go)\\b", RE_FLAGS);

    // ----------------------------------------------------- field extractors

    private static final Pattern P_CLEAN_TAIL =
            Pattern.compile("\\s+(?:for|and|with|during|that|this|next|in)\\s+.*$", RE_FLAGS);

    private static String cleanPlace(String raw) {
        String first = raw.split("[.?,!;\\n]", 2)[0];
        String cleaned = P_CLEAN_TAIL.matcher(first).replaceAll("");
        cleaned = Js.collapse(cleaned);
        cleaned = Js.trim(cleaned);
        return cleaned.length() >= 2 ? cleaned : "";
    }

    private static final Pattern P_DEST_VISIT = Pattern.compile(
            "\\b(?:want to|would like to|love to|plan to|plan on|hope to|get to)?\\s*(?:visit|visiting|go to|going to|travel to|trip to|vacation (?:in|to)|holiday (?:in|to)|explore)\\s+([A-Za-z][A-Za-z\\s'-]{1,40})",
            RE_FLAGS);
    private static final Pattern P_DEST_HOTELS = Pattern.compile(
            "\\bhotels?\\s+(?:in|near|at|around)\\s+([A-Za-z][A-Za-z\\s'-]{1,40})",
            RE_FLAGS);
    private static final Pattern P_DEST_TRIP = Pattern.compile(
            "\\b(?:trip|itinerary|stay)\\s+(?:to|in)\\s+([A-Za-z][A-Za-z\\s'-]{1,40})",
            RE_FLAGS);
    /** Case-sensitive in the TS — an "in <Capitalised>" is a place, "in a" is not. */
    private static final Pattern P_DEST_IN = Pattern.compile(
            "\\bin\\s+([A-Z][a-zA-Z\\s'-]{2,40})");

    public static String extractDestination(String... texts) {
        StringBuilder joined = new StringBuilder();
        for (String text : texts) {
            if (filled(text)) {
                if (joined.length() > 0) {
                    joined.append('\n');
                }
                joined.append(text);
            }
        }
        Pattern[] patterns = {P_DEST_VISIT, P_DEST_HOTELS, P_DEST_TRIP, P_DEST_IN};
        for (Pattern p : patterns) {
            Matcher m = p.matcher(joined.toString());
            if (m.find() && m.group(1) != null) {
                String place = cleanPlace(m.group(1));
                if (place.length() >= 3) {
                    return place;
                }
            }
        }
        return null;
    }

    private static final Pattern P_FLEXIBLE =
            Pattern.compile("\\b(asap|flexible|not sure|don't know|do not know|whenever|no idea|tbd)\\b", RE_FLAGS);
    private static final Pattern P_RANGE_MON_FIRST = Pattern.compile(
            "\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s*\\d{1,2}\\s*(?:-|–|—|to|through|until)\\s*\\d{1,2}(?:,\\s*\\d{2,4})?",
            RE_FLAGS);
    private static final Pattern P_RANGE_DAY_FIRST = Pattern.compile(
            "\\b\\d{1,2}\\s*(?:-|–|—|to|through)\\s*\\d{1,2}\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?(?:,\\s*\\d{2,4})?",
            RE_FLAGS);
    private static final Pattern P_RANGE_MON_TO_MON = Pattern.compile(
            "\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}\\s*(?:-|–|—|to)\\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}(?:,\\s*\\d{2,4})?",
            RE_FLAGS);
    private static final Pattern P_SINGLE_DAY = Pattern.compile(
            "\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?(?:,\\s*\\d{2,4})?",
            RE_FLAGS);
    private static final Pattern P_MONTH_YEAR = Pattern.compile(
            "\\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\.?(?:\\s+\\d{4})?\\b",
            RE_FLAGS);
    private static final Pattern P_TRIP_WORDS =
            Pattern.compile("\\b(trip|travel|visit|go|going|leave|flying|dates?|when)\\b", RE_FLAGS);
    private static final Pattern P_ISO = Pattern.compile("\\b\\d{4}-\\d{2}-\\d{2}\\b");

    public static String extractDates(String text) {
        String t = Js.trim(text);
        if (P_FLEXIBLE.matcher(t).find()) {
            return "Flexible / not decided";
        }
        // TS: first of the three range shapes that matches wins.
        String range = firstMatch(P_RANGE_MON_FIRST, t);
        if (range == null) {
            range = firstMatch(P_RANGE_DAY_FIRST, t);
        }
        if (range == null) {
            range = firstMatch(P_RANGE_MON_TO_MON, t);
        }
        if (range != null) {
            return Js.trim(Js.collapse(range));
        }

        Matcher single = P_SINGLE_DAY.matcher(t);
        if (single.find()) {
            return Js.trim(single.group());
        }

        Matcher monthYear = P_MONTH_YEAR.matcher(t);
        if (monthYear.find() && P_TRIP_WORDS.matcher(t).find()) {
            return Js.trim(monthYear.group());
        }

        if (P_THIS_WEEKEND.matcher(t).find()) {
            return "This weekend";
        }
        if (P_NEXT_WEEKEND.matcher(t).find()) {
            return "Next weekend";
        }
        if (P_NEXT_MONTH.matcher(t).find()) {
            return "Next month";
        }
        if (P_NEXT_WEEK.matcher(t).find()) {
            return "Next week";
        }

        Matcher iso = P_ISO.matcher(t);
        if (iso.find()) {
            return iso.group();
        }
        return null;
    }

    private static String firstMatch(Pattern p, String text) {
        Matcher m = p.matcher(text);
        return m.find() ? m.group() : null;
    }

    private static final Pattern P_THIS_WEEKEND = Pattern.compile("\\bthis weekend\\b", RE_FLAGS);
    private static final Pattern P_NEXT_WEEKEND = Pattern.compile("\\bnext weekend\\b", RE_FLAGS);
    private static final Pattern P_NEXT_MONTH = Pattern.compile("\\bnext month\\b", RE_FLAGS);
    private static final Pattern P_NEXT_WEEK = Pattern.compile("\\bnext week\\b", RE_FLAGS);

    private static final Pattern P_COUPLE = Pattern.compile("\\bcouple\\b", RE_FLAGS);
    private static final Pattern P_PAIR = Pattern.compile(
            "\\b(\\d{1,2})\\s*(?:adults?|people|persons?|travelers?|travellers?|pax)\\b", RE_FLAGS);
    private static final Pattern P_KIDS_COUNT = Pattern.compile(
            "\\b(?:family of|we are|with)\\s+(\\d{1,2})\\b", RE_FLAGS);
    private static final Pattern P_WITH_KIDS = Pattern.compile(
            "\\b(\\d{1,2})\\s*(?:adults?\\s*and\\s*)?(\\d{1,2})?\\s*kids?\\b", RE_FLAGS);
    private static final Pattern P_FAMILY = Pattern.compile("\\bfamily\\b", RE_FLAGS);
    private static final Pattern P_WITH_KIDS_PHRASE = Pattern.compile("\\bwith kids?\\b", RE_FLAGS);

    public static String extractPeople(String text) {
        String t = Js.trim(text);
        if (P_JUST_ME.matcher(t).find() || P_SOLO_ANY.matcher(t).find() || P_ALONE.matcher(t).find()) {
            return "Just me (solo)";
        }
        if (P_COUPLE.matcher(t).find()) {
            return "Couple (2)";
        }
        Matcher pair = P_PAIR.matcher(t);
        if (pair.find()) {
            return pair.group(1) + " travelers";
        }
        Matcher kids = P_KIDS_COUNT.matcher(t);
        if (kids.find()) {
            return "Family of " + kids.group(1);
        }
        Matcher withKids = P_WITH_KIDS.matcher(t);
        if (withKids.find()) {
            return Js.trim(Js.collapse(withKids.group()));
        }
        if (P_FAMILY.matcher(t).find()) {
            return "Family";
        }
        if (P_WITH_KIDS_PHRASE.matcher(t).find()) {
            return "Family with kids";
        }
        return null;
    }

    private static final Pattern P_JUST_ME = Pattern.compile("\\bjust me\\b", RE_FLAGS);
    private static final Pattern P_SOLO_ANY = Pattern.compile("\\bsolo\\b", RE_FLAGS);
    private static final Pattern P_ALONE = Pattern.compile("\\balone\\b", RE_FLAGS);

    private static final Pattern P_DAYS =
            Pattern.compile("\\b(\\d{1,2})\\s*(?:-|–|—)?\\s*(?:day|days|night|nights)\\b", RE_FLAGS);
    private static final Pattern P_WEEKEND = Pattern.compile("\\bweekend\\b", RE_FLAGS);
    private static final Pattern P_ONE_WEEK = Pattern.compile("\\b(?:a|one|1)\\s*week\\b", RE_FLAGS);
    private static final Pattern P_TWO_WEEKS = Pattern.compile("\\b(?:two|2)\\s*weeks?\\b", RE_FLAGS);
    private static final Pattern P_THREE_WEEKS = Pattern.compile("\\b(?:three|3)\\s*weeks?\\b", RE_FLAGS);
    private static final Pattern P_ONE_MONTH = Pattern.compile("\\b(?:a|one|1)\\s*month\\b", RE_FLAGS);
    private static final Pattern P_DAY_TRIP = Pattern.compile("\\bday trip\\b", RE_FLAGS);

    public static String extractDuration(String text) {
        String t = Js.trim(text);
        Matcher days = P_DAYS.matcher(t);
        if (days.find()) {
            return days.group(1) + " days";
        }
        if (P_WEEKEND.matcher(t).find()) {
            return "Weekend (2 days)";
        }
        if (P_ONE_WEEK.matcher(t).find()) {
            return "7 days";
        }
        if (P_TWO_WEEKS.matcher(t).find()) {
            return "14 days";
        }
        if (P_THREE_WEEKS.matcher(t).find()) {
            return "21 days";
        }
        if (P_ONE_MONTH.matcher(t).find()) {
            return "30 days";
        }
        if (P_DAY_TRIP.matcher(t).find()) {
            return "Day trip";
        }
        return null;
    }

    private static final Pattern P_BUDGET_FLEX =
            Pattern.compile("\\b(flexible|no limit|money is no object|sky is the limit)\\b", RE_FLAGS);
    private static final Pattern P_PER_DAY =
            Pattern.compile("\\b\\$?\\s?(\\d{2,5})\\s*(?:/|per|a)\\s*day\\b", RE_FLAGS);
    private static final Pattern P_TOTAL =
            Pattern.compile("\\b\\$?\\s?(\\d{3,6})\\s*total\\b", RE_FLAGS);
    private static final Pattern P_STATED =
            Pattern.compile("\\b(?:budget|cost|spend(?:ing)?)(?:\\s+(?:around|of|about|is|:))?\\s*\\$?\\s?(\\d{3,6})\\b", RE_FLAGS);
    private static final Pattern P_LUXURY = Pattern.compile("\\bluxur(?:y|ious)\\b", RE_FLAGS);
    private static final Pattern P_UPSCALE = Pattern.compile("\\bboutique|premium|high-end|high end\\b", RE_FLAGS);
    private static final Pattern P_CHEAP = Pattern.compile("\\bbudget|cheap|backpack|hostel|save money|affordable\\b", RE_FLAGS);
    private static final Pattern P_MID = Pattern.compile("\\bmid[- ]?range|moderate|comfortable\\b", RE_FLAGS);
    private static final Pattern P_BAND = Pattern.compile("\\b(low|high|medium)\\s*budget\\b", RE_FLAGS);

    public static String extractBudget(String text) {
        String t = Js.trim(text);
        if (P_BUDGET_FLEX.matcher(t).find()) {
            return "Flexible";
        }
        Matcher perDay = P_PER_DAY.matcher(t);
        if (perDay.find()) {
            return "$" + perDay.group(1) + "/day";
        }
        Matcher total = P_TOTAL.matcher(t);
        if (total.find()) {
            return "$" + total.group(1) + " total";
        }
        Matcher stated = P_STATED.matcher(t);
        if (stated.find()) {
            return "$" + stated.group(1) + " total";
        }
        if (P_LUXURY.matcher(t).find()) {
            return "Luxury";
        }
        if (P_UPSCALE.matcher(t).find()) {
            return "Upscale / boutique";
        }
        if (P_CHEAP.matcher(t).find()) {
            return "Budget";
        }
        if (P_MID.matcher(t).find()) {
            return "Mid-range";
        }
        Matcher band = P_BAND.matcher(t);
        if (band.find()) {
            String b = band.group(1);
            return Character.toUpperCase(b.charAt(0)) + b.substring(1) + " budget";
        }
        return null;
    }

    /** (pattern, label) pairs — tested against the LOWERCASED text, no i flag (as in the TS). */
    private static final Pattern[][] INTEREST_CATALOG = {
        {Pattern.compile("\\b(food|foodie|cuisine|culinary|eating|restaurants?)\\b")},
        {Pattern.compile("\\b(culture|history|museums?|art|heritage)\\b")},
        {Pattern.compile("\\b(nature|hiking|trekking|mountains?|outdoors?|scenery)\\b")},
        {Pattern.compile("\\b(beach|beaches|island|coast|snorkel|surf)\\b")},
        {Pattern.compile("\\b(nightlife|bars?|clubs?|party|pubs?)\\b")},
        {Pattern.compile("\\b(shopping|markets?|boutiques)\\b")},
        {Pattern.compile("\\b(adventure|sports?|skiing|diving|kayak)\\b")},
        {Pattern.compile("\\b(family|kids?|children|theme parks?)\\b")},
        {Pattern.compile("\\b(romance|romantic|honeymoon)\\b")},
        {Pattern.compile("\\b(photography|instagram|scenic)\\b")},
        {Pattern.compile("\\b(relax|wellness|spa|slow travel)\\b")},
        {Pattern.compile("\\b(night market|street food|local life)\\b")},
    };

    private static final String[] INTEREST_LABELS = {
        "Food & cuisine",
        "Culture & history",
        "Nature & outdoors",
        "Beaches & islands",
        "Nightlife",
        "Shopping",
        "Adventure",
        "Family-friendly",
        "Romance",
        "Photography spots",
        "Relaxation & wellness",
        "Local street culture",
    };

    private static final Pattern P_INTEREST_ANYTHING =
            Pattern.compile("\\banything|open|no preference|surprise me|whatever\\b", RE_FLAGS);

    public static String extractInterests(String text) {
        String t = Js.lower(text);
        List<String> hits = new ArrayList<>();
        for (int i = 0; i < INTEREST_CATALOG.length; i++) {
            if (INTEREST_CATALOG[i][0].matcher(t).find()) {
                hits.add(INTEREST_LABELS[i]);
            }
        }
        if (hits.size() > 0) {
            return String.join(", ", hits.size() > 4 ? hits.subList(0, 4) : hits);
        }
        if (P_INTEREST_ANYTHING.matcher(t).find()) {
            return "Open to anything";
        }
        return null;
    }

    private static final Pattern P_HOSTEL = Pattern.compile("\\bhostels?\\b", RE_FLAGS);
    private static final Pattern P_AIRBNB = Pattern.compile("\\bairbnb|vacation rental|apartment\\b", RE_FLAGS);
    private static final Pattern P_BOUTIQUE = Pattern.compile("\\bboutique\\b", RE_FLAGS);
    private static final Pattern P_RESORT = Pattern.compile("\\bresorts?\\b", RE_FLAGS);
    private static final Pattern P_GUESTHOUSE = Pattern.compile("\\bguest ?houses?\\b", RE_FLAGS);
    private static final Pattern P_RYOKAN = Pattern.compile("\\bryokan\\b", RE_FLAGS);
    private static final Pattern P_HOMESTAY = Pattern.compile("\\bhomestay\\b", RE_FLAGS);
    private static final Pattern P_HOTEL = Pattern.compile("\\bhotels?\\b", RE_FLAGS);
    private static final Pattern P_LUXURY_STAY = Pattern.compile("\\bluxury\\b", RE_FLAGS);
    private static final Pattern P_BUDGET_STAY = Pattern.compile("\\bbudget stay|cheap (?:hotel|place)\\b", RE_FLAGS);
    private static final Pattern P_OPEN_SUGGESTIONS =
            Pattern.compile("\\bnot sure|no preference|anything|whatever|flexible\\b", RE_FLAGS);

    public static String extractAccommodation(String text) {
        String t = Js.trim(text);
        if (P_HOSTEL.matcher(t).find()) {
            return "Hostels";
        }
        if (P_AIRBNB.matcher(t).find()) {
            return "Airbnb / apartments";
        }
        if (P_BOUTIQUE.matcher(t).find()) {
            return "Boutique hotels";
        }
        if (P_RESORT.matcher(t).find()) {
            return "Resorts";
        }
        if (P_GUESTHOUSE.matcher(t).find()) {
            return "Guesthouses";
        }
        if (P_RYOKAN.matcher(t).find()) {
            return "Ryokans";
        }
        if (P_HOMESTAY.matcher(t).find()) {
            return "Homestays";
        }
        if (P_HOTEL.matcher(t).find()) {
            return "Hotels";
        }
        if (P_LUXURY_STAY.matcher(t).find()) {
            return "Luxury hotels";
        }
        if (P_BUDGET_STAY.matcher(t).find()) {
            return "Budget stays";
        }
        if (P_OPEN_SUGGESTIONS.matcher(t).find()) {
            return "Open to suggestions";
        }
        return null;
    }

    // -------------------------------------------------- user answer folding

    private static final Pattern SKIP_RE = Pattern.compile(
            "^\\s*(?:i'?m not sure|not sure|idk|i don'?t know|no idea|skip|whatever|any|anything|flexible|surprise me|up to you|you decide|no preference)\\s*[.!]?\\s*$",
            RE_FLAGS);

    private static final Pattern P_ITINERARY_REQUEST = Pattern.compile(
            "\\b(itinerary|day[\\s-]?by[\\s-]?day|full plan|entire trip|whole trip|create my|build my|generate my|make my)\\b",
            RE_FLAGS);

    private static final Pattern P_DEST_CHANGE = Pattern.compile(
            "\\b(?:switch to|change (?:destination|city|place) to|actually|instead)\\s+(?:to\\s+)?([A-Za-z][A-Za-z\\s'-]{2,40})",
            RE_FLAGS);

    private static final Pattern P_ANY_PREF =
            Pattern.compile("\\b(any|anything|no preference)\\b", RE_FLAGS);

    /**
     * Fold what the user just said into the profile: the itinerary request, a
     * destination (or destination change), and every field an extractor
     * recognises. Returns a COPY — the input profile is never mutated.
     */
    public static TripProfile applyUserAnswer(TripProfile profile, String userText) {
        TripProfile next = profile.copy();
        String text = Js.trim(userText);
        if (text.isEmpty()) {
            return next;
        }

        if (P_ITINERARY_REQUEST.matcher(text).find()) {
            next.itinerary = "requested";
        }

        if (!filled(next.destination)) {
            String dest = extractDestination(text);
            if (dest != null) {
                next.destination = dest;
            }
        } else {
            Matcher destChange = P_DEST_CHANGE.matcher(text);
            if (destChange.find() && destChange.group(1) != null) {
                String cleaned = cleanPlace(destChange.group(1));
                next.destination = filled(cleaned) ? cleaned : next.destination;
            }
        }

        if (SKIP_RE.matcher(text).find()) {
            if (Js.lower(text).contains("flexible") && !filled(next.dates)) {
                next.dates = "Flexible / not decided";
            }
            if (!filled(next.budget) && P_FLEXIBLE_WORD.matcher(text).find()) {
                next.budget = "Flexible";
            }
            if (!filled(next.accommodation) && P_ANY_PREF.matcher(text).find()) {
                next.accommodation = "Open to suggestions";
            }
            return next;
        }

        next.dates = orKeep(next.dates, extractDates(text));
        next.people = orKeep(next.people, extractPeople(text));
        next.budget = orKeep(next.budget, extractBudget(text));
        next.interests = orKeep(next.interests, extractInterests(text));
        next.duration = orKeep(next.duration, extractDuration(text));
        next.accommodation = orKeep(next.accommodation, extractAccommodation(text));
        return next;
    }

    private static final Pattern P_FLEXIBLE_WORD = Pattern.compile("\\bflexible\\b", RE_FLAGS);

    /** TS {@code if (value) next[field] = value}. */
    private static String orKeep(String prev, String value) {
        return filled(value) ? value : prev;
    }

    private static final Set<String> STAGE_DEFAULTS = Set.of("Open to suggestions", "Flexible");

    /**
     * Free-form answer for the hotel / restaurants / attractions stages.
     * The whole reply is the answer (a picked name, a style, a chip value);
     * leading conversational verbs are stripped. Skips become sensible defaults.
     */
    private static String stageAnswer(String text) {
        String t = Js.trim(Js.collapse(text));
        if (t.isEmpty()) {
            return null;
        }
        if (SKIP_RE.matcher(t).find()) {
            return P_FLEXIBLE_WORD.matcher(t).find() ? "Flexible" : "Open to suggestions";
        }
        if (t.length() > 90 || t.contains("?")) {
            return null;
        }
        String cleaned = P_STAGE_VERB.matcher(t).replaceAll("");
        cleaned = P_STAGE_THANKS.matcher(cleaned).replaceAll("");
        cleaned = P_STAGE_PUNCT.matcher(cleaned).replaceAll("");
        return cleaned.length() >= 2 ? Js.slice(cleaned, 0, 90) : null;
    }

    private static final Pattern P_STAGE_VERB = Pattern.compile(
            "^(?:i'?ll\\s+(?:go\\s+with|go\\s+for|pick|choose|take)\\s+|let'?s\\s+(?:go\\s+with|pick)\\s+|go\\s+with\\s+|choose\\s+|pick\\s+|book\\s+)",
            RE_FLAGS);
    private static final Pattern P_STAGE_THANKS =
            Pattern.compile("\\s*(?:please|thanks|thank you)\\b[.!]?$", RE_FLAGS);
    private static final Pattern P_STAGE_PUNCT = Pattern.compile("^[,;:\\s]+|[,;:\\s]+$");

    private static String appendList(String prev, String value) {
        if (!filled(prev) || STAGE_DEFAULTS.contains(prev)) {
            return value;
        }
        List<String> parts = new ArrayList<>();
        for (String s : prev.split(",")) {
            String trimmed = Js.trim(s);
            if (!trimmed.isEmpty()) {
                parts.add(trimmed);
            }
        }
        for (String p : parts) {
            if (Js.lower(p).equals(Js.lower(value))) {
                return prev;
            }
        }
        parts.add(value);
        String merged = String.join(", ", parts);
        return merged.length() <= 220 ? merged : prev;
    }

    /**
     * Apply a user reply, targeting the stage the assistant just asked about.
     * For hotel/restaurants/attractions the reply itself becomes the value, so a
     * tapped card ("Hotel New York") or a chip ("Boutique hotel") always lands.
     */
    public static TripProfile applyStageAnswer(TripProfile profile, PlanningField field, String userText) {
        TripProfile next = applyUserAnswer(profile, userText);
        if (field == null || Js.trim(userText).isEmpty()) {
            return next;
        }
        String value = stageAnswer(userText);
        if (value == null) {
            return next;
        }
        boolean isDefault = STAGE_DEFAULTS.contains(value);
        if (field == PlanningField.HOTEL) {
            if (!filled(next.hotel)) {
                next.hotel = value;
            }
        } else if (field == PlanningField.RESTAURANTS) {
            if (!(isDefault && filled(next.restaurants))) {
                next.restaurants = appendList(next.restaurants, value);
            }
        } else if (field == PlanningField.ATTRACTIONS) {
            if (!(isDefault && filled(next.attractions))) {
                next.attractions = appendList(next.attractions, value);
            }
        }
        return next;
    }

    public static List<String> defaultChips(PlanningField field, TripProfile profile) {
        switch (field) {
            case DATES:
                return List.of("This weekend", "Next month", "Flexible dates");
            case PEOPLE:
                return List.of("Just me", "2 adults", "Family of 4");
            case BUDGET:
                return List.of("Budget", "Mid-range", "Luxury");
            case INTERESTS:
                return List.of("Food & culture", "Nature & beaches", "Nightlife", "Family-friendly");
            case DURATION:
                return List.of("3 days", "5 days", "1 week");
            case ACCOMMODATION:
                return List.of("Hotels", "Hostels", "Airbnb", "Boutique");
            case HOTEL:
                return List.of("Boutique hotel", "Luxury stay", "Budget-friendly", "No preference");
            case RESTAURANTS:
                return List.of("Local street food", "Fine dining", "Family-friendly", "Surprise me");
            case ATTRACTIONS:
                return List.of("Top landmarks", "Museums & art", "Nature & views", "Hidden gems");
            case DESTINATION:
                return filled(profile.destination) ? List.of(profile.destination) : List.of();
            case ITINERARY:
                return List.of("Create my itinerary", "Show more restaurants");
            case DONE:
                return List.of("Build my full itinerary");
            default:
                return List.of();
        }
    }

    public static PlanningHint mergePlanningHint(String content, TripProfile profile) {
        PlanningHint parsed = parsePlanning(content);
        if (parsed != null) {
            List<String> chips;
            if (parsed.chips().size() > 0) {
                chips = parsed.chips();
            } else if (parsed.field() == PlanningField.DONE) {
                chips = List.of("Build my full itinerary");
            } else {
                chips = defaultChips(parsed.field(), profile);
            }
            return new PlanningHint(parsed.field(), chips);
        }

        String text = stripMetaBlocks(content);
        if (Js.trim(text).isEmpty()) {
            return null;
        }
        if (!P_ENDS_WITH_QUESTION.matcher(Js.trim(text)).find()) {
            if (isProfileComplete(profile) && P_ITINERARY_WORDS.matcher(text).find()) {
                return filled(profile.itinerary)
                        ? new PlanningHint(PlanningField.DONE, List.of("Build my full itinerary"))
                        : new PlanningHint(PlanningField.ITINERARY, defaultChips(PlanningField.ITINERARY, profile));
            }
            return null;
        }
        PlanningField inferred = inferQuestionField(text);
        if (inferred == null || inferred == PlanningField.DESTINATION) {
            return null;
        }
        return new PlanningHint(inferred, defaultChips(inferred, profile));
    }

    private static final Pattern P_ENDS_WITH_QUESTION = Pattern.compile("\\?\\s*$");
    private static final Pattern P_ITINERARY_WORDS =
            Pattern.compile("\\bitinerary|day-by-day|full plan\\b", RE_FLAGS);

    // ------------------------------------------------------- hotel payload

    public static HotelsPayload enrichHotelsPayload(TripProfile profile) {
        if (!filled(profile.destination)) {
            return null;
        }
        Matcher adultsMatch = P_ADULTS_DIGITS.matcher(filled(profile.people) ? profile.people : "");
        Integer adults = null;
        if (adultsMatch.find()) {
            adults = Math.min(12, Math.max(1, Integer.parseInt(adultsMatch.group(1))));
        }
        return new HotelsPayload(profile.destination,
                isoFromRange(profile.dates, true),
                isoFromRange(profile.dates, false),
                adults);
    }

    private static final Pattern P_ADULTS_DIGITS = Pattern.compile("(\\d{1,2})");
    private static final Pattern P_YEAR = Pattern.compile("(20\\d{2})");
    private static final Pattern P_MONTH_HIT = Pattern.compile(
            "\\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\b",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern P_DAY_NUM = Pattern.compile("\\b(\\d{1,2})(?:st|nd|rd|th)?\\b");

    /** jan:0 … dec:11 — both the short and the full names map to the same index. */
    private static final java.util.Map<String, Integer> MONTH_LOOKUP = new java.util.HashMap<>();

    static {
        String[] names = {
            "jan", "january", "feb", "february", "mar", "march", "apr", "april",
            "may", "jun", "june", "jul", "july", "aug", "august", "sep", "sept",
            "september", "oct", "october", "nov", "november", "dec", "december"
        };
        int[] idx = {0, 0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6, 7, 7, 8, 8, 8, 9, 9, 10, 10, 11, 11};
        for (int i = 0; i < names.length; i++) {
            MONTH_LOOKUP.put(names[i], idx[i]);
        }
    }

    /** {@code true} → check-in ("in"), {@code false} → check-out ("out"). */
    private static String isoFromRange(String dates, boolean isIn) {
        if (!filled(dates)) {
            return null;
        }
        Matcher yearMatch = P_YEAR.matcher(dates);
        int year = yearMatch.find() ? Integer.parseInt(yearMatch.group(1)) : java.time.Year.now().getValue();

        String lower = Js.lower(dates);
        List<String> monthHits = new ArrayList<>();
        Matcher mh = P_MONTH_HIT.matcher(lower);
        while (mh.find()) {
            monthHits.add(mh.group(1));
        }
        if (monthHits.isEmpty()) {
            return null;
        }
        Integer mIdx = MONTH_LOOKUP.get(monthHits.get(0));
        if (mIdx == null) {
            return null;
        }

        List<Integer> dayNums = new ArrayList<>();
        Matcher dn = P_DAY_NUM.matcher(lower);
        while (dn.find()) {
            int d = Integer.parseInt(dn.group(1));
            if (d >= 1 && d <= 31) {
                dayNums.add(d);
            }
        }
        int day = 1;
        if (isIn) {
            day = dayNums.isEmpty() ? 1 : dayNums.get(0);
        } else {
            day = dayNums.size() >= 2 ? dayNums.get(1) : (dayNums.isEmpty() ? 1 : dayNums.get(0)) + 3;
            if (dayNums.size() == 1 && monthHits.size() >= 1 && dayNums.get(0) <= 24) {
                day = dayNums.get(0) + 3;
            }
        }
        int second = monthHits.size() >= 2 && MONTH_LOOKUP.containsKey(monthHits.get(1))
                ? MONTH_LOOKUP.get(monthHits.get(1))
                : -1;
        int y = monthHits.size() >= 2 && mIdx < second ? year + 1 : year;
        int d = Math.min(28, Math.max(1, day));
        return String.format("%d-%02d-%02d", y, mIdx + 1, d);
    }
}
