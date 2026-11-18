/**
 * Hand-off to a real booking site once a flight or train has been found.
 *
 * Deep links are only built where the URL scheme is documented and stable:
 * Kayak's `/flights/CODE-CODE/DATE[/RETURN]` path when both ends look like
 * IATA codes, and the operator site for the region the rail search actually
 * ran against (IRCTC for India, Trainline for the UK and the rest of Europe).
 * Anything else falls back to a plain search page instead of a guessed URL.
 */

export interface BookingTarget {
  url: string;
  /** Human name of the site the user lands on (used in labels/tooltips). */
  site: string;
}

const KAYAK = "https://www.kayak.com";
const GOOGLE_FLIGHTS = "https://www.google.com/travel/flights";
const IRCTC = "https://www.irctc.co.in/nget/train-search";
const TRAINLINE = "https://www.thetrainline.com";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function code(value?: string): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface FlightBookingQuery {
  from?: string;
  to?: string;
  /** Departure as YYYY-MM-DD (the value the search used). */
  date?: string;
  /** Optional return as YYYY-MM-DD. */
  returnDate?: string;
  /** Supplied by a provider when it knows a direct booking page. */
  bookingUrl?: string;
}

export function flightBookingTarget(query: FlightBookingQuery): BookingTarget {
  if (query.bookingUrl) return { url: query.bookingUrl, site: "the airline" };

  const from = code(query.from);
  const to = code(query.to);
  if (from.length >= 3 && to.length >= 3 && ISO_DATE.test(query.date ?? "")) {
    const back = ISO_DATE.test(query.returnDate ?? "") ? `/${query.returnDate}` : "";
    return { url: `${KAYAK}/flights/${from}-${to}/${query.date}${back}`, site: "Kayak" };
  }
  return { url: GOOGLE_FLIGHTS, site: "Google Flights" };
}

/** `route` is what `/api/trains` answered with: "india" | "uk" | "hafas". */
export function trainBookingTarget(route?: string): BookingTarget {
  const r = (route ?? "").toLowerCase();
  if (r === "india") return { url: IRCTC, site: "IRCTC" };
  return { url: TRAINLINE, site: "Trainline" };
}

const BOOKING = "https://www.booking.com";
const GETYOURGUIDE = "https://www.getyourguide.com";

export interface HotelBookingQuery {
  name?: string;
  city?: string;
  /** Trip dates, pre-filled into the search when they are ISO dates. */
  checkIn?: string;
  checkOut?: string;
  adults?: number;
}

/**
 * Hand-off to Booking.com's search with the trip's dates and party size
 * pre-filled. Prices and availability are confirmed THERE — this app never
 * pretends a room is booked.
 */
export function hotelBookingTarget(query: HotelBookingQuery): BookingTarget {
  const params = new URLSearchParams();
  const q = [query.name, query.city].filter(Boolean).join(" ").trim();
  params.set("ss", q || query.city || "hotels");
  if (ISO_DATE.test(query.checkIn ?? "")) params.set("checkin", query.checkIn!);
  if (ISO_DATE.test(query.checkOut ?? "")) params.set("checkout", query.checkOut!);
  const adults = Math.min(12, Math.max(1, Math.round(query.adults ?? 2) || 2));
  params.set("group_adults", String(adults));
  params.set("no_rooms", "1");
  params.set("group_children", "0");
  return { url: `${BOOKING}/searchresults.html?${params.toString()}`, site: "Booking.com" };
}

export interface ActivityBookingQuery {
  name?: string;
  city?: string;
}

/**
 * Ticket/experience search on GetYourGuide with the activity + city prefilled.
 * Like hotels: a search hand-off, never a fake ticket.
 */
export function activityBookingTarget(query: ActivityBookingQuery): BookingTarget {
  const q = [query.name, query.city].filter(Boolean).join(" ").trim() || "things to do";
  return { url: `${GETYOURGUIDE}/s/?q=${encodeURIComponent(q)}`, site: "GetYourGuide" };
}

/** Shared anchor props for every "Book" hand-off link. */
export function bookLinkProps(target: BookingTarget, title: string) {
  return {
    href: target.url,
    target: "_blank" as const,
    rel: "noreferrer noopener",
    title,
  };
}
