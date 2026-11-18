package com.tripcraft.backend.trains;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.tripcraft.backend.trains.Trains.numText;
import static com.tripcraft.backend.trains.Trains.orEmpty;
import static com.tripcraft.backend.trains.Trains.slice;

/**
 * Port of {@code src/lib/bookingFormat.ts} — shared formatting helpers for the
 * flight / train booking sections. The train search itself needs
 * {@link #arrivalStamp}, {@link #clockDiff} and {@link #localIsoWithOffset};
 * the rest are ported verbatim so the helpers stay a drop-in match.
 */
public final class BookingFormat {

    private static final Pattern CLOCK = Pattern.compile("(\\d{2}:\\d{2})(?::\\d{2})?");
    private static final Pattern ISO_DAY = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}$");

    private static final DateTimeFormatter DAY_LABEL =
            DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US);
    private static final DateTimeFormatter ARRIVAL =
            DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm").withZone(ZoneOffset.UTC);

    private BookingFormat() {
    }

    /** "13:43" from an ISO timestamp or "2026-10-10 13:43" — station-local wall clock. */
    public static String clockTime(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        Matcher m = CLOCK.matcher(value);
        if (m.find()) {
            return m.group(1);
        }
        Long ms = parseJsDateMs(value);
        if (ms == null) {
            return "";
        }
        LocalDateTime parsed = LocalDateTime.ofInstant(Instant.ofEpochMilli(ms), ZoneId.systemDefault());
        return String.format(Locale.ROOT, "%02d:%02d", parsed.getHour(), parsed.getMinute());
    }

    /** "Fri, Oct 10" from a "YYYY-MM-DD" prefix; empty when there is no date. */
    public static String dayLabel(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String datePart = slice(value, 0, 10);
        if (!ISO_DAY.matcher(datePart).matches()) {
            return "";
        }
        try {
            return LocalDate.parse(datePart).format(DAY_LABEL);
        } catch (DateTimeParseException e) {
            return "";
        }
    }

    public static String formatMinutes(Double min) {
        if (min == null || Double.isNaN(min) || min <= 0) {
            return "";
        }
        double h = Math.floor(min / 60);
        double m = min % 60;
        if (h == 0) {
            return numText(m) + "m";
        }
        return m != 0 ? numText(h) + "h " + numText(m) + "m" : numText(h) + "h";
    }

    /** "$1,240" / "1,240 INR" — never shows a bare number without a currency. */
    public static String priceLabel(Double price, String currency) {
        if (price == null || !Double.isFinite(price)) {
            return null;
        }
        String cur = (currency == null || currency.isEmpty() ? "USD" : currency).toUpperCase(Locale.ROOT);
        String symbol = switch (cur) {
            case "USD" -> "$";
            case "EUR" -> "\u20ac";
            case "GBP" -> "\u00a3";
            default -> "";
        };
        String amount = String.format(Locale.US, "%,d", Math.round(price));
        return symbol.isEmpty() ? amount + " " + cur : symbol + amount;
    }

    public static Long minutesBetween(String start, String end) {
        if (start == null || start.isEmpty() || end == null || end.isEmpty()) {
            return null;
        }
        Long a = parseJsDateMs(start);
        Long b = parseJsDateMs(end);
        if (a == null || b == null) {
            return null;
        }
        return Math.max(0L, Math.round((b - a) / 60000.0));
    }

    /** UTC "YYYY-MM-DD" for {@code days} from now — {@code Date.now() + days * 864e5}. */
    public static String isoDateInDays(long days) {
        return LocalDate.now(ZoneOffset.UTC).plusDays(days).toString();
    }

    /** Minutes from clock {@code a} to clock {@code b} on the same/next day ("23:10" → "01:05" = 115). */
    public static double clockDiff(String a, String b) {
        double diff = toMinutes(b) - toMinutes(a);
        return diff >= 0 ? diff : diff + 1440;
    }

    /**
     * "YYYY-MM-DD HH:MM" for an arrival {@code durationMin} after a local
     * departure clock, rolling into the next day when the journey is overnight.
     */
    public static String arrivalStamp(String date, String departClock, double durationMin) {
        Long base = parseJsDateMs(date + "T" + departClock + ":00Z");
        if (base == null) {
            return date + " " + departClock;
        }
        double add = Math.max(durationMin, 0);
        Instant iso = Instant.ofEpochMilli(base).plusMillis(Math.round(add * 60000));
        return ARRIVAL.format(iso);
    }

    /**
     * "2026-10-10T09:30:00+02:00" for a local wall-clock date+time in
     * {@code timeZone} (HAFAS expects an explicit offset, and the offset
     * changes with DST — it is read at the instant being requested).
     */
    public static String localIsoWithOffset(String date, String time, String timeZone) {
        Long asUtc = parseJsDateMs(date + "T" + time + ":00Z");
        if (asUtc == null) {
            return date + "T" + time + ":00";
        }
        ZoneOffset offset = ZoneId.of(timeZone).getRules().getOffset(Instant.ofEpochMilli(asUtc));
        long offsetMin = Math.round(offset.getTotalSeconds() / 60.0);
        String sign = offsetMin >= 0 ? "+" : "-";
        long abs = Math.abs(offsetMin);
        return String.format(Locale.ROOT, "%sT%s:00%s%02d:%02d",
                date, time, sign, abs / 60, abs % 60);
    }

    // ------------------------------------------------------------ internals

    /**
     * {@code Date.parse()} for the shapes the backend sees: an explicit offset
     * or {@code Z} is absolute, a bare date-time is server-local (V8 reads
     * {@code "2026-10-10 13:43"} as local), a bare date is UTC (per spec).
     * Returns {@code null} where JS would get {@code NaN}.
     */
    private static Long parseJsDateMs(String value) {
        if (value == null) {
            return null;
        }
        String s = value.trim();
        if (s.isEmpty()) {
            return null;
        }
        if (s.length() > 10 && s.charAt(10) == ' ') {
            s = s.substring(0, 10) + "T" + s.substring(11);
        }
        try {
            return OffsetDateTime.parse(s).toInstant().toEpochMilli();
        } catch (DateTimeParseException ignored) {
            // not an offset form — try the local wall-clock form
        }
        try {
            return LocalDateTime.parse(s).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
        } catch (DateTimeParseException ignored) {
            // not a date-time — try a bare (UTC) date
        }
        try {
            return LocalDate.parse(s).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
        } catch (DateTimeParseException ignored) {
            return null;
        }
    }

    /** JS {@code [h, m] = value.split(":").map(Number)} then {@code (h || 0) * 60 + (m || 0)}. */
    private static double toMinutes(String value) {
        String[] parts = orEmpty(value).split(":", -1);
        double h = orZero(Trains.jsNumberText(parts.length > 0 ? parts[0] : ""));
        double m = orZero(Trains.jsNumberText(parts.length > 1 ? parts[1] : ""));
        return h * 60 + m;
    }

    /** JS {@code x || 0} for numbers: {@code 0}, {@code -0} and {@code NaN} become {@code 0}. */
    private static double orZero(double value) {
        return value == 0 || Double.isNaN(value) ? 0 : value;
    }
}
