package com.tripcraft.backend.places;

/**
 * Port of the {@code OsmPoint} interface from {@code src/lib/osm.ts} — a named
 * place read from OpenStreetMap.
 *
 * <p>Optional TS fields ({@code category?}, {@code address?},
 * {@code openingHours?}, {@code website?}, {@code phone?}) are {@code null}
 * when absent; JSON writers must skip them, because TS {@code JSON.stringify}
 * drops {@code undefined} keys and the frontend treats a missing key as
 * "unknown" rather than "empty".
 */
public record OsmPoint(
        String name,
        double lat,
        double lng,
        String category,
        String address,
        String openingHours,
        String website,
        String phone) {
}
