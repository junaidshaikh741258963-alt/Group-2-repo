package com.tripcraft.backend.hotels;

import java.util.List;

/**
 * Port of the {@code Hotel} interface from {@code src/lib/hotels.ts} — one
 * OpenStreetMap lodging result before it becomes a recommendation card.
 *
 * <p>Optional TS fields ({@code phone?}, {@code website?},
 * {@code distanceFromCenter?}) are {@code null} when absent.
 */
public record Hotel(
        double id,
        String name,
        double lat,
        double lng,
        String address,
        String phone,
        String website,
        int stars,
        int pricePerNight,
        String currency,
        List<String> amenities,
        Double distanceFromCenter) {
}
