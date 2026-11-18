package com.tripcraft.backend.places;

import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Port of {@code src/lib/routeStops.ts} — the coarse categories the route
 * planner's filter chips and the {@code /api/route-places} response share.
 */
public final class RouteStops {

    /** Coarse category used for icons/chips; {@code other} shows under "All" only. */
    public static final List<String> STOP_KINDS =
            List.of("hotel", "restaurant", "cafe", "attraction", "shopping", "other");

    private static final Pattern HOTEL = Pattern.compile("hotel|hostel|guest|motel|resort|lodging|chalet|apart");
    private static final Pattern FOOD = Pattern.compile("restaurant|fast_food|food|pub|bar|biergarten|ice_cream");
    private static final Pattern CAFE = Pattern.compile("cafe|coffee|tea");
    private static final Pattern SHOPPING = Pattern.compile("mall|shop|store|supermarket|gift|market|boutique|department");
    private static final Pattern SIGHT = Pattern.compile(
            "attraction|museum|gallery|viewpoint|zoo|aquarium|theme|monument|castle|ruin|memorial|artwork"
                    + "|park|garden|cathedral|church|temple|archaeolog");

    private RouteStops() {
    }

    /** OSM tag value → one of the chip categories. */
    public static String normalizeStopKind(String category) {
        String c = (category == null ? "" : category).toLowerCase(Locale.ROOT);
        if (HOTEL.matcher(c).find()) {
            return "hotel";
        }
        if (FOOD.matcher(c).find()) {
            return "restaurant";
        }
        if (CAFE.matcher(c).find()) {
            return "cafe";
        }
        if (SHOPPING.matcher(c).find()) {
            return "shopping";
        }
        if (SIGHT.matcher(c).find()) {
            return "attraction";
        }
        return "other";
    }
}
