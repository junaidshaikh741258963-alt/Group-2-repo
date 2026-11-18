"use client";

import { useEffect, useRef, useState } from "react";
import type { TravelFormData } from "@/components/trip/TravelPlanningForm";
import SmartImage from "@/components/ui/SmartImage";
import PlaceDetailModal from "@/components/explore/PlaceDetailModal";
import { coerceType, type Recommendation } from "@/lib/recommendations";
import { flightBookingTarget, bookLinkProps } from "@/lib/bookingLinks";
import { formatAmount, tripCurrencyFor } from "@/lib/agent/currency";

type Status = "idle" | "loading" | "done" | "error";

export interface Stay {
  name: string;
  rating?: number;
  reviews?: number;
  price?: string;
  priceValue?: number;
  currency?: string;
  priceUsd?: number;
  image?: string;
  kind?: string;
  amenities?: string[];
  lat?: number;
  lng?: number;
  link?: string;
  withinBudget?: boolean;
}

export interface PlaceRec {
  name: string;
  rating?: number;
  reviews?: number;
  type?: string;
  address?: string;
  openState?: string;
  description?: string;
  price?: string;
  thumbnail?: string;
  lat?: number;
  lng?: number;
  link?: string;
}

export interface FlightOffer {
  kind: "best" | "other";
  price?: number;
  durationMin?: number;
  stops: number;
  airline: string;
  airlineLogo?: string;
  travelClass?: string;
  departAt?: string;
  arriveAt?: string;
  from?: string;
  to?: string;
}

interface PlanBuilderProps {
  form: TravelFormData;
  onBuild: (s: { stays: string[]; places: string[] }) => Promise<boolean>;
  onRestart: () => void;
}

/** Stay rows open as an in-app detail sheet instead of a Google Maps jump-out. */
export function stayToRec(s: Stay, index: number): Recommendation {
  return {
    id: `stay-${index}-${s.name}`,
    name: s.name,
    type: "hotel",
    lat: s.lat,
    lng: s.lng,
    rating: s.rating,
    price: s.price,
    image: s.image,
    description: s.amenities?.join(" · "),
    link: s.link,
  };
}

/** Same for "places to visit" rows. */
export function placeToRec(p: PlaceRec, index: number): Recommendation {
  return {
    id: `place-${index}-${p.name}`,
    name: p.name,
    type: coerceType(p.type),
    lat: p.lat,
    lng: p.lng,
    rating: p.rating,
    price: p.price,
    image: p.thumbnail,
    description: p.address ?? p.description,
    link: p.link,
  };
}

const STEPS = [
  { label: "Stays", emoji: "🏨", blurb: "Hostels & hotels within your trip amount" },
  { label: "Places", emoji: "🎯", blurb: "Top places to visit" },
  { label: "Flights", emoji: "✈️", blurb: "Country-to-country fares" },
  { label: "Itinerary", emoji: "🧳", blurb: "Your full day-by-day plan" },
];

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function PlaceImg({ src, alt, emoji }: { src?: string; alt: string; emoji: string }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <SmartImage
        src={src}
        alt={alt}
        onError={() => setFailed(true)}
        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
      />
    );
  }
  return (
    <div
      className="w-full h-full flex items-center justify-center text-3xl bg-surface-2"
      aria-hidden="true"
    >
      {emoji}
    </div>
  );
}

export function Stars({ rating, reviews }: { rating?: number; reviews?: number }) {
  if (rating == null) return <span className="text-xs text-ink-faint">No rating yet</span>;
  return (
    <span className="text-xs font-semibold text-amber-500">
      ★ {rating.toFixed(1)}
      {reviews != null && (
        <span className="font-normal text-ink-faint">
          {" "}
          ({reviews.toLocaleString()} review{reviews === 1 ? "" : "s"})
        </span>
      )}
    </span>
  );
}

function StepSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-28 rounded-2xl bg-surface-3 animate-pulse" />
      ))}
    </div>
  );
}

function StepError({
  message,
  onRetry,
  onSkip,
}: {
  message: string;
  onRetry: () => void;
  onSkip?: () => void;
}) {
  return (
    <div className="bg-red-500/12 border border-red-500/35 rounded-2xl p-6 text-center">
      <p className="text-danger text-sm mb-4">{message}</p>
      <div className="flex justify-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="px-6 py-2 bg-red-600 text-white text-sm font-medium rounded-xl hover:bg-red-500 transition-all"
        >
          Retry
        </button>
        {onSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="px-6 py-2 bg-surface-1 border border-hairline-strong text-zinc-200 text-sm font-medium rounded-xl hover:bg-surface-2 transition-all"
          >
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

export default function PlanBuilder({ form, onBuild, onRestart }: PlanBuilderProps) {
  const [step, setStep] = useState(0);
  const currency = form.budgetCurrency || tripCurrencyFor(form.origin, form.destination).code;

  const [staysStatus, setStaysStatus] = useState<Status>("loading");
  const [stays, setStays] = useState<Stay[]>([]);
  const [nightlyBudget, setNightlyBudget] = useState<number | undefined>(undefined);

  const [placesStatus, setPlacesStatus] = useState<Status>("idle");
  const [places, setPlaces] = useState<PlaceRec[]>([]);
  const [detail, setDetail] = useState<Recommendation | null>(null);

  const [flightsStatus, setFlightsStatus] = useState<Status>("idle");
  const [flights, setFlights] = useState<FlightOffer[]>([]);
  const [flightNote, setFlightNote] = useState("");

  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState("");

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadStays = () => {
    postJson<{ stays?: Stay[]; nightlyBudget?: number }>("/api/agent/stays", {
      destination: form.destination,
      startDate: form.startDate,
      endDate: form.endDate,
      accommodationType: form.accommodationType,
      accommodationBudget: form.accommodationBudget,
      totalBudget: form.totalBudget,
      numDays: form.numDays,
      numAdults: form.numAdults,
    }).then((res) => {
      if (!aliveRef.current) return;
      if (!res) {
        setStaysStatus("error");
        return;
      }
      setStays(Array.isArray(res.stays) ? res.stays : []);
      setNightlyBudget(res.nightlyBudget);
      setStaysStatus("done");
    });
  };

  const fetchStays = () => {
    setStaysStatus("loading");
    loadStays();
  };

  const fetchPlaces = () => {
    setPlacesStatus("loading");
    postJson<{ places?: PlaceRec[] }>("/api/agent/places", {
      destination: form.destination,
      interests: form.interests,
      count: 10,
    }).then((res) => {
      if (!aliveRef.current) return;
      if (!res) {
        setPlacesStatus("error");
        return;
      }
      setPlaces(Array.isArray(res.places) ? res.places : []);
      setPlacesStatus("done");
    });
  };

  const fetchFlights = () => {
    setFlightsStatus("loading");
    if (!form.origin.trim()) {
      setFlights([]);
      setFlightNote("Add your origin city in the form to see flights.");
      setFlightsStatus("done");
      return;
    }
    setFlightNote("");
    postJson<{ flights?: FlightOffer[]; error?: string }>("/api/flights", {
      departure: form.origin,
      arrival: form.destination,
      outboundDate: form.startDate,
      returnDate: form.endDate || undefined,
      adults: form.numAdults,
    }).then((res) => {
      if (!aliveRef.current) return;
      if (!res) {
        setFlightsStatus("error");
        return;
      }
      setFlights(Array.isArray(res.flights) ? res.flights : []);
      if (!res.flights || res.flights.length === 0) {
        setFlightNote(
          res.error ||
            `No fares found right now for ${form.origin} → ${form.destination}. You can continue and check later.`
        );
      }
      setFlightsStatus("done");
    });
  };

  // Initial stays fetch on mount: state updates happen only in the async callback.
  useEffect(() => {
    loadStays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goStep = (n: number) => {
    if (n < 0 || n >= STEPS.length || n > step + 1) return;
    setStep(n);
    if (n === 1 && placesStatus === "idle") fetchPlaces();
    if (n === 2 && flightsStatus === "idle") fetchFlights();
  };

  const nextReady =
    step === 0
      ? staysStatus === "done"
      : step === 1
        ? placesStatus === "done"
        : step === 2
          ? flightsStatus === "done"
          : true;

  const handleBuild = async () => {
    setBuilding(true);
    setBuildError("");
    const ok = await onBuild({
      stays: stays.slice(0, 6).map((s) => s.name),
      places: places.slice(0, 10).map((p) => p.name),
    });
    if (!aliveRef.current) return;
    setBuilding(false);
    if (!ok) setBuildError("Couldn't generate the itinerary. Please try again.");
  };

  return (
    <div className="max-w-4xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="bg-surface-1 rounded-2xl border border-hairline p-6 md:p-6 mb-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="eyebrow">
              Building your trip · step {step + 1} of {STEPS.length}
            </div>
            <h2 className="text-xl font-bold text-ink mt-1">
              {form.destination || "Your destination"}
              {form.startDate && form.endDate && (
                <span className="text-sm font-medium text-ink-faint ml-2">
                  {form.startDate} → {form.endDate}
                </span>
              )}
            </h2>
          </div>
          <button
            type="button"
            onClick={onRestart}
            className="shrink-0 px-3 py-2 text-xs font-medium text-ink-muted border border-white/[0.12] rounded-lg hover:bg-surface-2 hover:text-zinc-200 transition-colors"
          >
            Start over
          </button>
        </div>

        {/* Stepper */}
        <div className="flex gap-2 md:gap-2 overflow-x-auto dark-scroll pb-1">
          {STEPS.map((s, i) => {
            const active = i === step;
            const visited = i < step;
            const reachable = i <= step + 1;
            return (
              <button
                key={s.label}
                type="button"
                onClick={() => goStep(i)}
                disabled={!reachable}
                className={`flex items-center gap-2 shrink-0 px-3 py-2 rounded-xl text-sm font-semibold border transition-all ${
                  active
                    ? "bg-accent-strong border-accent-strong text-white"
                    : visited
                      ? "bg-accent/12 border-accent/35 text-blue-300 hover:bg-accent/20"
                      : reachable
                        ? "bg-surface-1 border-white/[0.12] text-zinc-300 hover:border-hairline-strong"
                        : "bg-surface-2 border-hairline text-ink-faint cursor-not-allowed"
                }`}
              >
                <span
                  className={`w-5 h-5 rounded-full text-3xs font-bold flex items-center justify-center ${
                    active
                      ? "bg-white/20 text-white"
                      : visited
                        ? "bg-accent-strong text-white"
                        : "bg-white/[0.14] text-ink-muted"
                  }`}
                >
                  {i + 1}
                </span>
                <span>
                  {s.emoji} {s.label}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-sm text-ink-muted mt-3">{STEPS[step].blurb}</p>
      </div>

      {/* Step content */}
      <div className="bg-surface-1 rounded-2xl border border-hairline p-6 md:p-6">
        {step === 0 && (
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <h3 className="text-md font-bold text-ink">Stays that fit your budget</h3>
              {nightlyBudget != null && nightlyBudget > 0 && (
                <span className="px-2 py-1 text-2xs font-semibold rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/35">
                  ≤ {formatAmount(nightlyBudget, currency)}/night
                </span>
              )}
              <span className="text-2xs text-ink-faint">prices in local currency + USD</span>
            </div>

            {staysStatus === "loading" && <StepSkeleton />}
            {staysStatus === "error" && (
              <StepError
                message="Couldn't load stays. Check your connection and try again."
                onRetry={fetchStays}
                onSkip={() => goStep(1)}
              />
            )}
            {staysStatus === "done" && stays.length === 0 && (
              <p className="text-sm text-ink-muted py-6 text-center">
                No stays found for this destination — continue to the next step.
              </p>
            )}
            {staysStatus === "done" && stays.length > 0 && (
              <ul className="space-y-3">
                {stays.map((s, i) => (
                  <li
                    key={`${s.name}-${i}`}
                    className="group flex gap-4 p-3 md:p-4 rounded-2xl border border-hairline hover:border-accent/50 transition-all"
                  >
                    <div className="shrink-0 w-24 h-24 md:w-28 md:h-28 rounded-xl overflow-hidden bg-surface-3">
                      <PlaceImg src={s.image} alt={s.name} emoji="🏨" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="text-base font-semibold text-ink truncate">
                          {s.name}
                        </h4>
                        {s.withinBudget === true && (
                          <span className="shrink-0 px-2 py-1 text-3xs font-bold rounded-full bg-emerald-500/15 text-emerald-300">
                            Within budget
                          </span>
                        )}
                        {s.withinBudget === false && (
                          <span className="shrink-0 px-2 py-1 text-3xs font-bold rounded-full bg-amber-500/15 text-amber-300">
                            Over budget
                          </span>
                        )}
                      </div>
                      <div className="mt-1">
                        <Stars rating={s.rating} reviews={s.reviews} />
                      </div>
                      {s.amenities && s.amenities.length > 0 && (
                        <div className="text-xs text-ink-muted mt-1 truncate">
                          {s.amenities.join(" · ")}
                        </div>
                      )}
                      <div className="flex items-baseline gap-2 mt-2">
                        <span className="text-md font-bold text-ink">{s.price}</span>
                        {s.priceUsd != null && (
                          <span className="text-xs font-medium text-ink-muted">
                            (~${s.priceUsd})
                          </span>
                        )}
                        <span className="text-2xs text-ink-faint">/night</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDetail(stayToRec(s, i))}
                        className="inline-block text-xs font-medium text-blue-400 hover:underline mt-1"
                      >
                        View details →
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === 1 && (
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <h3 className="text-md font-bold text-ink">Places to visit</h3>
              <span className="text-2xs text-ink-faint">in {form.destination}</span>
            </div>

            {placesStatus === "idle" || placesStatus === "loading" ? <StepSkeleton /> : null}
            {placesStatus === "error" && (
              <StepError
                message="Couldn't load places to visit. Try again."
                onRetry={fetchPlaces}
                onSkip={() => goStep(2)}
              />
            )}
            {placesStatus === "done" && places.length === 0 && (
              <p className="text-sm text-ink-muted py-6 text-center">
                No places found — continue to the next step.
              </p>
            )}
            {placesStatus === "done" && places.length > 0 && (
              <ul className="space-y-3">
                {places.map((p, i) => (
                  <li
                    key={`${p.name}-${i}`}
                    className="group flex gap-4 p-3 md:p-4 rounded-2xl border border-hairline hover:border-accent/50 transition-all"
                  >
                    <div className="shrink-0 w-24 h-24 md:w-28 md:h-28 rounded-xl overflow-hidden bg-surface-3">
                      <PlaceImg src={p.thumbnail} alt={p.name} emoji="🎯" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="text-base font-semibold text-ink truncate">
                          {p.name}
                        </h4>
                        {p.price && (
                          <span className="shrink-0 text-xs font-bold text-emerald-300">
                            {p.price}
                          </span>
                        )}
                      </div>
                      <div className="mt-1">
                        <Stars rating={p.rating} reviews={p.reviews} />
                      </div>
                      {p.type && (
                        <div className="text-xs text-ink-muted mt-1">
                          {p.type}
                          {p.address ? ` · ${p.address}` : ""}
                        </div>
                      )}
                      {p.openState && (
                        <div className="text-2xs text-ink-faint mt-1">{p.openState}</div>
                      )}
                      <button
                        type="button"
                        onClick={() => setDetail(placeToRec(p, i))}
                        className="inline-block text-xs font-medium text-blue-400 hover:underline mt-1"
                      >
                        View details →
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === 2 && (
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <h3 className="text-md font-bold text-ink">
                {form.origin || "Origin"} → {form.destination}
              </h3>
              {form.startDate && (
                <span className="text-2xs text-ink-faint">{form.startDate}</span>
              )}
              <span className="text-2xs text-ink-faint">fares in USD</span>
            </div>

            {flightsStatus === "idle" || flightsStatus === "loading" ? (
              <StepSkeleton rows={4} />
            ) : null}
            {flightsStatus === "error" && (
              <StepError
                message="Couldn't load flight fares. Try again."
                onRetry={fetchFlights}
                onSkip={() => goStep(3)}
              />
            )}
            {flightsStatus === "done" && flightNote && (
              <div className="bg-amber-500/10 border border-amber-500/35 rounded-xl p-4 text-sm text-amber-200 mb-3">
                {flightNote}
              </div>
            )}
            {flightsStatus === "done" && flights.length > 0 && (
              <ul className="space-y-2.5">
                {flights.map((f, i) => {
                  const booking = flightBookingTarget({
                    from: f.from,
                    to: f.to,
                    date: form.startDate,
                    returnDate: form.endDate || undefined,
                  });
                  const bookTitle =
                    booking.site === "the airline"
                      ? "Book this flight on the airline site"
                      : `Search ${[f.from, f.to].filter(Boolean).join(" → ")} on ${booking.site}`;
                  return (
                    <li
                      key={`${f.airline}-${f.departAt}-${i}`}
                      className="flex items-center gap-3 p-3 rounded-2xl border border-hairline hover:border-accent/50 transition-all"
                    >
                      {f.airlineLogo ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={f.airlineLogo}
                          alt=""
                          className="shrink-0 w-8 h-8 object-contain"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <div className="shrink-0 w-8 h-8 rounded-lg bg-accent/12 flex items-center justify-center text-sm">
                          ✈️
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-base font-semibold text-ink truncate">
                          {f.airline}
                          {f.travelClass ? ` · ${f.travelClass}` : ""}
                        </div>
                        <div className="text-xs text-ink-muted truncate">
                          {f.departAt} {f.from && `(${f.from})`} → {f.arriveAt}{" "}
                          {f.to && `(${f.to})`}
                          {f.durationMin
                            ? ` · ${Math.floor(f.durationMin / 60)}h ${f.durationMin % 60}m`
                            : ""}
                          {f.stops === 0
                            ? " · Nonstop"
                            : ` · ${f.stops} stop${f.stops > 1 ? "s" : ""}`}
                        </div>
                      </div>
                      {f.price != null && (
                        <div className="shrink-0 text-right">
                          <div className="text-md font-bold text-ink">${f.price}</div>
                          <div className="text-3xs text-ink-faint">per person</div>
                        </div>
                      )}
                      <a
                        {...bookLinkProps(booking, bookTitle)}
                        className="shrink-0 inline-flex items-center gap-1 whitespace-nowrap rounded-xl border border-accent/35 bg-accent/12 px-3 py-2 text-xs font-semibold text-blue-300 transition-colors hover:border-accent/60 hover:bg-accent/20"
                      >
                        {booking.site === "the airline" ? "Book" : `Book on ${booking.site}`}
                        <span aria-hidden>↗</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="text-center py-6">
            <div className="text-5xl mb-4">🧳</div>
            <h3 className="text-lg font-bold text-ink mb-2">
              Ready to build your full itinerary
            </h3>
            <p className="text-sm text-ink-muted max-w-md mx-auto leading-relaxed mb-1">
              A day-by-day plan using your budget, dates, interests — plus the {stays.length} stays
              and {places.length} places we picked
              {flights.length > 0 ? ` and ${flights.length} flight options` : ""}.
            </p>
            <p className="text-xs text-ink-faint mb-6">
              Prices are shown in{" "}
              {form.destination
                ? "the destination's local currency where available"
                : "local currency"}
              .
            </p>
            {buildError && (
              <div className="bg-red-500/12 border border-red-500/35 rounded-xl p-4 text-sm text-danger mb-4 max-w-md mx-auto">
                {buildError}
              </div>
            )}
            <button
              type="button"
              onClick={handleBuild}
              disabled={building}
              className="px-8 py-4 bg-accent-strong text-white font-semibold rounded-xl hover:bg-accent disabled:opacity-60 disabled:cursor-not-allowed transition-all"
            >
              {building ? "Building your itinerary…" : "Build my full itinerary →"}
            </button>
          </div>
        )}

        {/* Footer nav */}
        {step < 3 && (
          <div className="flex items-center justify-between mt-6 pt-6 border-t border-hairline">
            <button
              type="button"
              onClick={() => goStep(step - 1)}
              disabled={step === 0}
              className="px-4 py-3 text-sm font-medium text-zinc-300 border border-white/[0.12] rounded-xl hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              ← Back
            </button>
            <div className="flex items-center gap-3">
              {nextReady ? (
                <span className="text-xs text-ink-faint hidden md:block">
                  {step === 0
                    ? `${stays.length} stays`
                    : step === 1
                      ? `${places.length} places`
                      : `${flights.length} fares`}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => goStep(step + 1)}
                disabled={!nextReady}
                className="px-6 py-3 text-sm font-semibold bg-accent-strong text-white rounded-xl hover:bg-accent disabled:bg-white/[0.16] disabled:cursor-not-allowed transition-all"
              >
                {nextReady
                  ? `Next: ${STEPS[step + 1].label} →`
                  : step === 0
                    ? "Loading stays…"
                    : step === 1
                      ? "Loading places…"
                      : "Loading flights…"}
              </button>
            </div>
          </div>
        )}
      </div>

      <PlaceDetailModal place={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
