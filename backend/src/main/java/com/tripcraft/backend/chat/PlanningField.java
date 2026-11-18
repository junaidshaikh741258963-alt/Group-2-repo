package com.tripcraft.backend.chat;

/**
 * The planning stage machine's fields — the TS {@code ProfileField} union plus
 * the two extra {@code PlanningField} states ("itinerary", "done").
 *
 * <p>TS keeps these as string unions ({@code ProfileField} ⊂
 * {@code PlanningField}); one enum covers both, with the wire value kept so
 * {@code <planning>{"field": …}</planning>} blocks round-trip unchanged.
 */
public enum PlanningField {

    DESTINATION("destination", "Destination"),
    DATES("dates", "Trip dates"),
    PEOPLE("people", "Travelers"),
    BUDGET("budget", "Budget"),
    INTERESTS("interests", "Interests"),
    DURATION("duration", "Trip duration"),
    ACCOMMODATION("accommodation", "Stay type"),
    HOTEL("hotel", "Hotel"),
    RESTAURANTS("restaurants", "Restaurants"),
    ATTRACTIONS("attractions", "Activities"),
    /** Profile complete but the user has not explicitly asked for the full plan yet. */
    ITINERARY("itinerary", null),
    /** Itinerary explicitly requested. */
    DONE("done", null);

    private final String wire;
    private final String label;

    PlanningField(String wire, String label) {
        this.wire = wire;
        this.label = label;
    }

    /** The lowercase name the TS uses on the wire ({@code "people"}, {@code "done"}…). */
    public String wire() {
        return wire;
    }

    /** Human label for summaries ({@code null} for itinerary/done — never labelled). */
    public String label() {
        return label;
    }

    /** Wire value → field, or {@code null} when the value is not a known field. */
    public static PlanningField fromWire(String value) {
        if (value == null) {
            return null;
        }
        for (PlanningField f : values()) {
            if (f.wire.equals(value)) {
                return f;
            }
        }
        return null;
    }
}
