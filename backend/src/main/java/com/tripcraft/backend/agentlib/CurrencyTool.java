package com.tripcraft.backend.agentlib;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;
import com.tripcraft.backend.infra.Http;
import com.tripcraft.backend.infra.Json;

/**
 * Port of {@code src/lib/agent/currency.ts} — local-currency detection, the
 * Frankfurter/er-api rate lookup (with a same-day cache) and the static
 * fallback table.
 */
@Service
public class CurrencyTool {

    /** Budget currency derived from the trip's source and destination. */
    public record TripCurrency(String code, List<String> options) {
    }

    public record Converted(double amount, double rate, double result) {
    }

    private static final Map<String, String> SYMBOLS = symbols();
    private static final Map<String, Map<String, Double>> BASELINES = baselines();

    /** Same-day cache; guarded because the singleton is shared across requests. */
    private Map<String, Double> cachedRates;
    private String cacheBase = "";
    private String cacheDate = "";

    private static Map<String, String> symbols() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("USD", "$");
        m.put("EUR", "€");
        m.put("GBP", "£");
        m.put("JPY", "¥");
        m.put("CNY", "¥");
        m.put("INR", "₹");
        m.put("KRW", "₩");
        m.put("THB", "฿");
        m.put("VND", "₫");
        m.put("MXN", "Mex$");
        m.put("BRL", "R$");
        m.put("CAD", "C$");
        m.put("AUD", "A$");
        m.put("CHF", "CHF");
        m.put("SEK", "kr");
        m.put("NOK", "kr");
        m.put("DKK", "kr");
        m.put("PLN", "zł");
        m.put("CZK", "Kč");
        m.put("HUF", "Ft");
        m.put("TRY", "₺");
        m.put("RUB", "₽");
        m.put("SAR", "SAR");
        m.put("AED", "AED");
        m.put("SGD", "S$");
        m.put("MYR", "RM");
        m.put("PHP", "₱");
        m.put("IDR", "Rp");
        m.put("NZD", "NZ$");
        m.put("ZAR", "R");
        m.put("EGP", "E£");
        return m;
    }

    private static Map<String, Map<String, Double>> baselines() {
        Map<String, Map<String, Double>> all = new LinkedHashMap<>();
        Map<String, Double> usd = new LinkedHashMap<>();
        usd.put("EUR", 0.92);
        usd.put("GBP", 0.79);
        usd.put("JPY", 149.5);
        usd.put("INR", 83.1);
        usd.put("THB", 35.8);
        usd.put("MXN", 17.2);
        usd.put("BRL", 4.97);
        usd.put("CAD", 1.36);
        usd.put("AUD", 1.53);
        usd.put("KRW", 1325.0);
        usd.put("CNY", 7.24);
        usd.put("SGD", 1.34);
        usd.put("MYR", 4.72);
        usd.put("PHP", 56.2);
        usd.put("IDR", 15450.0);
        usd.put("VND", 24350.0);
        usd.put("AED", 3.67);
        usd.put("SAR", 3.75);
        usd.put("TRY", 34.0);
        usd.put("CHF", 0.88);
        usd.put("SEK", 10.5);
        usd.put("NOK", 10.7);
        usd.put("DKK", 6.9);
        usd.put("PLN", 4.0);
        usd.put("CZK", 23.0);
        usd.put("HUF", 360.0);
        usd.put("RUB", 92.0);
        usd.put("NZD", 1.65);
        usd.put("ZAR", 18.0);
        usd.put("EGP", 48.0);
        all.put("USD", usd);

        Map<String, Double> eur = new LinkedHashMap<>();
        eur.put("USD", 1.09);
        eur.put("GBP", 0.86);
        eur.put("JPY", 162.5);
        eur.put("INR", 90.3);
        eur.put("THB", 38.9);
        all.put("EUR", eur);
        return all;
    }

    // -------------------------------------------------------------- detect

    /** Best-guess local currency code for a destination (country-to-country pricing). */
    public String detectLocalCurrency(String destination) {
        String d = (destination == null ? "" : destination).toLowerCase(Locale.ROOT);
        if (d.contains("japan") || d.contains("tokyo")) {
            return "JPY";
        }
        if (d.contains("europe") || d.contains("paris") || d.contains("rome") || d.contains("berlin")
                || d.contains("barcelona") || d.contains("amsterdam")) {
            return "EUR";
        }
        if (d.contains("uk") || d.contains("london")) {
            return "GBP";
        }
        if (d.contains("india") || d.contains("delhi") || d.contains("mumbai")) {
            return "INR";
        }
        if (d.contains("thailand") || d.contains("bangkok")) {
            return "THB";
        }
        if (d.contains("china") || d.contains("beijing")) {
            return "CNY";
        }
        if (d.contains("korea") || d.contains("seoul")) {
            return "KRW";
        }
        if (d.contains("brazil") || d.contains("rio")) {
            return "BRL";
        }
        if (d.contains("mexico") || d.contains("cancun")) {
            return "MXN";
        }
        if (d.contains("australia") || d.contains("sydney")) {
            return "AUD";
        }
        if (d.contains("canada") || d.contains("toronto")) {
            return "CAD";
        }
        if (d.contains("singapore")) {
            return "SGD";
        }
        if (d.contains("malaysia") || d.contains("kuala")) {
            return "MYR";
        }
        if (d.contains("uae") || d.contains("dubai")) {
            return "AED";
        }
        if (d.contains("turkey") || d.contains("istanbul")) {
            return "TRY";
        }
        if (d.contains("switzerland") || d.contains("zurich")) {
            return "CHF";
        }
        if (d.contains("sweden") || d.contains("stockholm")) {
            return "SEK";
        }
        if (d.contains("norway") || d.contains("oslo")) {
            return "NOK";
        }
        if (d.contains("denmark") || d.contains("copenhagen")) {
            return "DKK";
        }
        if (d.contains("poland") || d.contains("warsaw")) {
            return "PLN";
        }
        if (d.contains("egypt") || d.contains("cairo")) {
            return "EGP";
        }
        if (d.contains("south africa") || d.contains("cape town")) {
            return "ZAR";
        }
        if (d.contains("indonesia") || d.contains("bali")) {
            return "IDR";
        }
        if (d.contains("vietnam") || d.contains("hanoi")) {
            return "VND";
        }
        if (d.contains("philippines") || d.contains("manila")) {
            return "PHP";
        }
        return "USD";
    }

    /** Sync symbol lookup (ISO code → display symbol). */
    public String currencySymbol(String currencyCode) {
        String code = (currencyCode == null ? "" : currencyCode).toUpperCase(Locale.ROOT);
        String symbol = SYMBOLS.get(code);
        return symbol != null ? symbol : code;
    }

    // --------------------------------------------------------------- rates

    /** Exchange rate for {@code code} against USD: live rates when cached, else fallbacks. */
    public double rateFor(String code) {
        Double live;
        synchronized (this) {
            live = "USD".equals(cacheBase) && cachedRates != null ? cachedRates.get(code) : null;
        }
        if (live != null && live > 0) {
            return live;
        }
        Double fallback = getFallbackRates("USD").get(code);
        return fallback != null && fallback > 0 ? fallback : 1;
    }

    /** Convert a USD amount into {@code code} using the best rate available right now. */
    public double usdTo(double amountUsd, String code) {
        return jsRound(amountUsd * rateFor(code));
    }

    /** Human-readable money for a USD amount rendered in the trip currency. */
    public String formatAmount(double amountUsd, String code) {
        double value = usdTo(amountUsd, code);
        String symbol = currencySymbol(code);
        String text = toLocaleMax0(value);
        return symbol.equals(code) ? code + " " + text : symbol + text;
    }

    /**
     * Budget currency derived from the trip's source and destination: origin
     * (home) first, then the destination's local currency, then USD.
     */
    public TripCurrency tripCurrencyFor(String origin, String destination) {
        List<String> options = new ArrayList<>();
        if (origin != null && !origin.trim().isEmpty()) {
            addOption(options, detectLocalCurrency(origin));
        }
        if (destination != null && !destination.trim().isEmpty()) {
            addOption(options, detectLocalCurrency(destination));
        }
        addOption(options, "USD");
        return new TripCurrency(options.get(0), new ArrayList<>(options.subList(0, Math.min(3, options.size()))));
    }

    private static void addOption(List<String> options, String code) {
        if (code != null && !code.isEmpty() && !options.contains(code)) {
            options.add(code);
        }
    }

    /** Live rates (Frankfurter first, er-api second) with a same-day cache; always resolves. */
    public Map<String, Double> getExchangeRates(String baseCurrency) {
        String today = LocalDate.now(ZoneOffset.UTC).toString();
        synchronized (this) {
            if (cachedRates != null && cacheDate.equals(today) && cacheBase.equals(baseCurrency)) {
                return cachedRates;
            }
        }

        Map<String, Double> rates;
        try {
            // frankfurter.app - completely free, no API key needed
            Http.Raw res = Http.get("https://api.frankfurter.app/latest?from=" + baseCurrency, Map.of(), 10000);
            if (!res.ok()) {
                throw new IllegalStateException("Failed to fetch rates");
            }
            JsonNode data = res.json();
            rates = new LinkedHashMap<>();
            rates.put(baseCurrency, 1.0);
            putRates(rates, data == null ? null : data.get("rates"));
        } catch (Exception e) {
            try {
                // Fallback: try exchangerate-api (free tier)
                Http.Raw res = Http.get("https://open.er-api.com/v6/latest/" + baseCurrency, Map.of(), 10000);
                if (!res.ok()) {
                    throw new IllegalStateException("rates unavailable");
                }
                JsonNode data = res.json();
                JsonNode remote = data == null ? null : data.get("rates");
                if (remote != null && remote.isObject()) {
                    rates = new LinkedHashMap<>();
                    putRates(rates, remote);
                } else {
                    rates = getFallbackRates(baseCurrency);
                }
            } catch (Exception e2) {
                rates = getFallbackRates(baseCurrency);
            }
        }

        synchronized (this) {
            cachedRates = rates;
            cacheBase = baseCurrency;
            cacheDate = today;
        }
        return rates;
    }

    private static void putRates(Map<String, Double> out, JsonNode node) {
        if (node == null || !node.isObject()) {
            return;
        }
        node.fields().forEachRemaining(e -> {
            if (e.getValue().isNumber()) {
                out.put(e.getKey(), e.getValue().asDouble());
            }
        });
    }

    public Converted convertCurrency(double amount, String from, String to) {
        Map<String, Double> rates = getExchangeRates(from);
        Double rate = rates.get(to);
        double r = rate != null ? rate : 1;
        return new Converted(amount, r, Math.round(amount * r * 100) / 100.0);
    }

    public String getCurrencySymbol(String currencyCode) {
        return currencySymbol(currencyCode);
    }

    protected Map<String, Double> getFallbackRates(String base) {
        Map<String, Double> baseline = BASELINES.get(base);
        if (baseline == null) {
            baseline = BASELINES.get("USD");
        }
        return new LinkedHashMap<>(baseline);
    }

    // -------------------------------------------------------------- format

    private static double jsRound(double v) {
        return Double.isNaN(v) ? Double.NaN : Math.floor(v + 0.5);
    }

    private static String toLocaleMax0(double value) {
        java.text.NumberFormat nf = java.text.NumberFormat.getNumberInstance(Locale.US);
        nf.setGroupingUsed(true);
        nf.setMinimumFractionDigits(0);
        nf.setMaximumFractionDigits(0);
        return nf.format(value);
    }
}
