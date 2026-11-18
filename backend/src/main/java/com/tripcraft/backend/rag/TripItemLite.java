package com.tripcraft.backend.rag;

/**
 * Trimmed trip-board item sent by the chat client (see the /api/chat body).
 * Mirrors {@code TripItemLite} in {@code src/lib/rag/types.ts}.
 *
 * <p>Nullable fields mean "key absent" — TypeScript's {@code undefined}.
 */
public final class TripItemLite {

    private final String name;
    private final String category;
    private final String price;
    private final String detail;
    private final String description;
    private final Double rating;

    public TripItemLite(String name, String category, String price, String detail,
                        String description, Double rating) {
        this.name = name == null ? "" : name;
        this.category = category;
        this.price = price;
        this.detail = detail;
        this.description = description;
        this.rating = rating;
    }

    public String name() {
        return name;
    }

    public String category() {
        return category;
    }

    public String price() {
        return price;
    }

    public String detail() {
        return detail;
    }

    public String description() {
        return description;
    }

    public Double rating() {
        return rating;
    }
}
