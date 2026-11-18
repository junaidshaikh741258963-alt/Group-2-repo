"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { TravelFormData } from "@/components/trip/TravelPlanningForm";
import { formatAmount, tripCurrencyFor } from "@/lib/agent/currency";
import {
  PlaceImg,
  Stars,
  stayToRec,
  placeToRec,
  type Stay,
  type PlaceRec,
  type FlightOffer,
} from "@/components/trip/PlanBuilder";
import PlaceDetailModal from "@/components/explore/PlaceDetailModal";
import type { Recommendation } from "@/lib/recommendations";
import { geocodePlace } from "@/lib/osrm";
import type { MapMarkerData } from "@/components/map/MapView";
import { useExitTransition } from "@/lib/useExitTransition";
import { flightBookingTarget, bookLinkProps } from "@/lib/bookingLinks";

const MapView = dynamic(() => import("@/components/map/MapView"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 bg-zinc-950 flex items-center justify-center text-sm text-ink-faint">
      Loading map…
    </div>
  ),
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

type Stage = "stays" | "dining" | "places" | "transport" | "confirm" | "building";

const STEP_LABELS = ["Stays", "Dining", "Places", "Transport", "Itinerary"];
const STAGE_INDEX: Record<Stage, number> = {
  stays: 0,
  dining: 1,
  places: 2,
  transport: 3,
  confirm: 4,
  building: 4,
};

type Block =
  | { type: "stays"; items: Stay[] }
  | { type: "dining"; items: PlaceRec[] }
  | { type: "places"; items: PlaceRec[] }
  | { type: "transport"; flights: FlightOffer[]; note: string }
  | { type: "confirm" };

interface HistMsg {
  id: string;
  role: "ai" | "user";
  content: string;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onSkip?: () => void;
  block?: Block;
  answered?: string;
}

const TRANSPORT_MODES = [
  "Any / No preference",
  "Flight",
  "Train",
  "Bus",
  "Car rental",
  "Public transit",
  "Walking / Cycling",
];

const FOOD_QUERY: Record<string, string> = {
  "Any / No preference": "restaurants",
  "Street food & local markets": "street food markets",
  "Fine dining": "fine dining restaurants",
  "Budget-friendly": "cheap eats restaurants",
  "Vegetarian / Vegan": "vegan restaurants",
  Halal: "halal restaurants",
  Kosher: "kosher restaurants",
  "Local cuisine focused": "local cuisine restaurants",
  "International chains": "international restaurants",
};

const TRANSPORT_TIPS: Record<string, string> = {
  "Any / No preference": "Mix and match — fast trains between cities, public transit inside them.",
  Flight: "Book early for the best fares and check baggage rules on budget carriers.",
  Train: "Rail passes often beat point-to-point tickets on multi-city trips.",
  Bus: "Overnight buses can save you a night of accommodation.",
  "Car rental": "Compare airport vs. city-center pickup — rates vary a lot.",
  "Public transit": "A daily transit cap is usually cheaper than single tickets.",
  "Walking / Cycling": "Book bike rentals in advance during peak season.",
};

interface ProgressivePlannerProps {
  form: TravelFormData;
  onBuild: (s: { stays: string[]; places: string[]; transportation?: string }) => Promise<boolean>;
  onRestart: () => void;
}

function markerId(prefix: string, i: number, name: string) {
  return `${prefix}-${i}-${name}`;
}

function fmtDate(d?: string) {
  if (!d) return "";
  const x = new Date(d + "T00:00:00");
  if (Number.isNaN(x.getTime())) return d;
  return x.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function shortName(name: string, max = 34) {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

function Typing() {
  return (
    <div className="flex items-center gap-2 py-1 px-1">
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 typing-dot" />
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 typing-dot" />
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 typing-dot" />
    </div>
  );
}

function CardShell({
  selected,
  interactive,
  onClick,
  children,
  title,
}: {
  selected?: boolean;
  interactive: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  title: string;
}) {
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? Boolean(selected) : undefined}
      aria-label={title}
      onClick={interactive && onClick ? onClick : undefined}
      onKeyDown={
        interactive && onClick
          ? (e) => {
              // Inner buttons/links handle their own keys — ignore bubbled
              // Enter/Space so we don't double-activate the card.
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={`relative flex gap-3 p-3 rounded-2xl border transition-all text-left ${
        interactive ? "cursor-pointer hover:border-accent/60" : ""
      } ${selected ? "border-accent bg-accent/10 ring-1 ring-blue-500" : "border-hairline bg-surface-1"}`}
    >
      {children}
      {interactive && (
        <span
          className={`absolute top-2 right-2 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
            selected ? "bg-accent-strong border-accent-strong" : "bg-surface-1 border-hairline-strong"
          }`}
        >
          {selected && (
            <svg
              className="w-3 h-3 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3.5}
                d="M5 13l4 4L19 7"
              />
            </svg>
          )}
        </span>
      )}
    </div>
  );
}

export default function ProgressivePlanner({ form, onBuild, onRestart }: ProgressivePlannerProps) {
  const [history, setHistory] = useState<HistMsg[]>([]);
  const [stage, setStage] = useState<Stage>("stays");

  const [stays, setStays] = useState<Stay[]>([]);

  const [staySel, setStaySel] = useState<Stay | null>(null);
  const [diningSel, setDiningSel] = useState<PlaceRec[]>([]);
  const [placeSel, setPlaceSel] = useState<PlaceRec[]>([]);
  const [flightSel, setFlightSel] = useState<FlightOffer | null>(null);
  const [modeSel, setModeSel] = useState<string>(() =>
    TRANSPORT_MODES.includes(form.transportation) ? form.transportation : "Any / No preference"
  );

  const [markers, setMarkers] = useState<MapMarkerData[]>(() =>
    form.destinationCoords
      ? [
          {
            id: "dest",
            lat: form.destinationCoords.lat,
            lng: form.destinationCoords.lng,
            label: form.destination,
            kind: "destination" as const,
          },
        ]
      : []
  );
  const [focusId, setFocusId] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapPanelMounted, mapPanelClosing] = useExitTransition(mapOpen, 170);
  const [detail, setDetail] = useState<Recommendation | null>(null);

  const aliveRef = useRef(true);
  const startedRef = useRef(false);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const busy = history.some((m) => m.loading);

  const nid = () => `m${++idRef.current}`;

  const push = (m: Omit<HistMsg, "id"> & { id?: string }) =>
    setHistory((h) => [...h, { ...m, id: m.id ?? `m${++idRef.current}` } as HistMsg]);

  const replace = (id: string, patch: Partial<HistMsg>) =>
    setHistory((h) => h.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const answer = (label: string) =>
    setHistory((h) => [
      ...h.map((m) => (m.block && !m.answered ? { ...m, answered: label } : m)),
      { id: `m${++idRef.current}`, role: "user" as const, content: label },
    ]);

  const addMarkers = (
    items: Array<{ name: string; lat?: number; lng?: number }>,
    kind: MapMarkerData["kind"],
    prefix: string
  ) => {
    setMarkers((prev) => {
      const next = [...prev];
      const seen = new Set(prev.map((m) => m.id));
      items.forEach((it, i) => {
        if (typeof it.lat !== "number" || typeof it.lng !== "number") return;
        const id = markerId(prefix, i, it.name);
        if (seen.has(id)) return;
        seen.add(id);
        next.push({ id, lat: it.lat, lng: it.lng, label: it.name, kind });
      });
      return next;
    });
  };

  const dateRange =
    form.startDate && form.endDate ? `${fmtDate(form.startDate)} – ${fmtDate(form.endDate)}` : "";

  const currency = form.budgetCurrency || tripCurrencyFor(form.origin, form.destination).code;

  const stayKindLabel = (() => {
    const t = (form.accommodationType || "").toLowerCase();
    if (t.includes("camping")) return "camping stays";
    if (t.includes("rental") || t.includes("airbnb")) return "vacation rentals";
    if (t.includes("guesthouse") || t.includes("b&b")) return "guesthouses";
    if (t.includes("hostel")) return "hostels";
    if (t.includes("resort")) return "resorts";
    if (t.includes("5-star") || t.includes("luxury")) return "luxury hotels";
    if (t.includes("4-star")) return "4-star hotels";
    if (t.includes("3-star")) return "3-star hotels";
    return "hotels & hostels";
  })();

  const foodLabel =
    form.foodPreference === "Any / No preference"
      ? "good restaurants"
      : form.foodPreference.toLowerCase();

  // ── auto-scroll conversation ──────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [history]);

  // ── flow ──────────────────────────────────────────────────────────────
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolveDiningCoords = async (): Promise<{ lat: number; lng: number } | null> => {
    if (staySel && typeof staySel.lat === "number" && typeof staySel.lng === "number") {
      return { lat: staySel.lat, lng: staySel.lng };
    }
    if (form.destinationCoords) return form.destinationCoords;
    try {
      const s = await geocodePlace(form.destination);
      if (s[0]?.center) return { lat: s[0].center[1], lng: s[0].center[0] };
    } catch {
      /* fall through */
    }
    return null;
  };

  async function begin() {
    push({
      role: "ai",
      content: `Let's plan your ${form.numDays}-day trip to ${form.destination}${
        dateRange ? ` (${dateRange})` : ""
      } — one step at a time. First up: where you'll sleep.`,
    });
    await sleep(700);
    if (!aliveRef.current) return;
    await runStays();
  }

  async function runStays() {
    const tid = nid();
    push({
      id: tid,
      role: "ai",
      loading: true,
      content: `Searching ${stayKindLabel} in ${form.destination} for ${
        form.numAdults
      } traveler${form.numAdults > 1 ? "s" : ""}…`,
    });
    const res = await postJson<{ stays?: Stay[]; nightlyBudget?: number }>("/api/agent/stays", {
      destination: form.destination,
      startDate: form.startDate,
      endDate: form.endDate,
      accommodationType: form.accommodationType,
      accommodationBudget: form.accommodationBudget,
      totalBudget: form.totalBudget,
      numDays: form.numDays,
      numAdults: form.numAdults,
    });
    if (!aliveRef.current) return;
    if (!res) {
      replace(tid, {
        loading: false,
        error: "I couldn't load stays — check your connection and try again.",
        onRetry: () => void runStays(),
        onSkip: () => void skipStays(),
      });
      return;
    }
    const items = Array.isArray(res.stays) ? res.stays : [];
    setStays(items);
    addMarkers(items, "hotel", "stay");
    replace(tid, {
      loading: false,
      content: items.length
        ? `Found ${items.length} ${stayKindLabel} in ${form.destination}${
            res.nightlyBudget
              ? ` within your ~${formatAmount(res.nightlyBudget, currency)}/night budget`
              : ""
          }. Tap one to base your trip around — or keep it flexible.`
        : `I couldn't find ${stayKindLabel} for those dates — no problem, we can keep going and sort out lodging later.`,
      block: { type: "stays", items },
    });
    setStage("stays");
  }

  async function runDining() {
    const tid = nid();
    const anchor = staySel?.name ?? form.destination;
    push({
      id: tid,
      role: "ai",
      loading: true,
      content: `Finding ${foodLabel} near ${anchor}…`,
    });
    const coords = await resolveDiningCoords();
    if (!aliveRef.current) return;
    if (!coords) {
      replace(tid, {
        loading: false,
        content: `I couldn't pinpoint that area on the map, so let's skip nearby dining ideas for now.`,
        block: { type: "dining", items: [] },
      });
      setStage("dining");
      return;
    }
    const res = await postJson<{ places?: PlaceRec[] }>("/api/places/nearby", {
      lat: coords.lat,
      lng: coords.lng,
      q: `${FOOD_QUERY[form.foodPreference] ?? "restaurants"} in ${form.destination}`,
      count: 8,
    });
    if (!aliveRef.current) return;
    if (!res) {
      replace(tid, {
        loading: false,
        error: "I couldn't fetch dining spots. Try again?",
        onRetry: () => void runDining(),
        onSkip: () => void skipDining(),
      });
      return;
    }
    const items = Array.isArray(res.places) ? res.places : [];
    addMarkers(items, "restaurant", "food");
    replace(tid, {
      loading: false,
      content: items.length
        ? `Here are ${items.length} ${foodLabel} spots around ${anchor} — matching your food preference. Tap the ones that sound good; I'll pin them on the map.`
        : `Nothing specific came back around ${anchor} — we'll keep your food options open and I'll weave in good spots.`,
      block: { type: "dining", items },
    });
    setStage("dining");
  }

  async function runPlaces() {
    const tid = nid();
    const interestHint =
      form.interests.length > 0 ? ` matching ${form.interests.slice(0, 2).join(" & ")}` : "";
    push({
      id: tid,
      role: "ai",
      loading: true,
      content: `Pulling top attractions and activities in ${form.destination}${interestHint}…`,
    });
    const res = await postJson<{ places?: PlaceRec[] }>("/api/agent/places", {
      destination: form.destination,
      interests: form.interests,
      count: 8,
    });
    if (!aliveRef.current) return;
    if (!res) {
      replace(tid, {
        loading: false,
        error: "I couldn't load places to visit. Try again?",
        onRetry: () => void runPlaces(),
        onSkip: () => void skipPlaces(),
      });
      return;
    }
    const items = Array.isArray(res.places) ? res.places : [];
    addMarkers(items, "attraction", "place");
    replace(tid, {
      loading: false,
      content: items.length
        ? `Here are ${items.length} picks for ${form.destination}${
            interestHint ? "" : " based on what travelers love"
          }. Choose everything you want woven into the itinerary.`
        : `Nothing specific came back — add must-sees in your trip details and I'll work them in.`,
      block: { type: "places", items },
    });
    setStage("places");
  }

  async function runTransport() {
    const tid = nid();
    push({
      id: tid,
      role: "ai",
      loading: true,
      content: `Checking ways to get there and around ${form.destination}…`,
    });
    let flightItems: FlightOffer[] = [];
    let note = "";
    if (!form.origin.trim()) {
      note = "Add a starting city to your trip details to see flight fares.";
    } else {
      const res = await postJson<{ flights?: FlightOffer[]; error?: string }>("/api/flights", {
        departure: form.origin,
        arrival: form.destination,
        outboundDate: form.startDate,
        returnDate: form.endDate || undefined,
        adults: form.numAdults,
      });
      if (!aliveRef.current) return;
      if (!res) {
        note = "Flight search is unavailable right now — pick how you'd like to travel below.";
      } else {
        flightItems = Array.isArray(res.flights) ? res.flights : [];
        if (flightItems.length === 0) {
          note =
            res.error ||
            `No fares found right now for ${form.origin} → ${form.destination}. You can continue and check later.`;
        }
      }
    }
    if (!aliveRef.current) return;
    replace(tid, {
      loading: false,
      content: `${form.origin || "Your origin"} → ${form.destination}${
        form.startDate ? ` on ${fmtDate(form.startDate)}` : ""
      }. ${note ? `${note} ` : ""}Pick how you'd like to get around:`,
      block: { type: "transport", flights: flightItems, note },
    });
    setStage("transport");
  }

  async function runBuild() {
    const tid = nid();
    push({
      id: tid,
      role: "ai",
      loading: true,
      content: `On it ✨ Building your ${form.numDays}-day ${form.destination} itinerary with your picks — this can take a moment.`,
    });
    const ok = await onBuild({
      stays: staySel ? [staySel.name] : stays.slice(0, 6).map((s) => s.name),
      places: [...placeSel.map((p) => p.name), ...diningSel.map((d) => d.name)].slice(0, 12),
      transportation: modeSel,
    });
    if (!aliveRef.current) return;
    if (!ok) {
      replace(tid, {
        loading: false,
        error: "That didn't go through — your picks are still here. Want to try generating again?",
        onRetry: () => void runBuild(),
      });
      setStage("confirm");
    }
  }

  // ── step transitions ─────────────────────────────────────────────────
  async function skipStays() {
    answer("Skipped the stay pick");
    setStage("dining");
    await sleep(450);
    if (!aliveRef.current) return;
    await runDining();
  }

  async function skipDining() {
    answer("Skipped dining suggestions");
    setStage("places");
    await sleep(450);
    if (!aliveRef.current) return;
    await runPlaces();
  }

  async function skipPlaces() {
    answer("I'll trust your top highlights");
    setStage("transport");
    await sleep(450);
    if (!aliveRef.current) return;
    await runTransport();
  }

  const handleStayContinue = async () => {
    if (busy) return;
    const label = staySel ? `Stay: ${staySel.name}` : "Keeping the stay flexible";
    answer(label);
    push({
      role: "ai",
      content: staySel
        ? `Perfect — ${shortName(staySel.name, 60)} is your base. Now let's find somewhere great to eat around there.`
        : `Got it — we'll stay flexible on lodging. Let's look at food around ${form.destination} instead.`,
    });
    setStage("dining");
    await sleep(650);
    if (!aliveRef.current) return;
    await runDining();
  };

  const handleDiningContinue = async () => {
    if (busy) return;
    const label = diningSel.length
      ? `Food: ${diningSel
          .slice(0, 2)
          .map((d) => d.name)
          .join(", ")}${diningSel.length > 2 ? ` +${diningSel.length - 2} more` : ""}`
      : "No specific restaurant picks";
    answer(label);
    push({
      role: "ai",
      content: diningSel.length
        ? `Yum — ${diningSel.length} spot${diningSel.length > 1 ? "s" : ""} logged. Next: what do you want to see and do?`
        : `No worries — I'll include well-rated local favorites. Next: what do you want to see and do?`,
    });
    setStage("places");
    await sleep(650);
    if (!aliveRef.current) return;
    await runPlaces();
  };

  const handlePlacesContinue = async () => {
    if (busy) return;
    const label = placeSel.length
      ? `Must-sees: ${placeSel
          .slice(0, 2)
          .map((p) => p.name)
          .join(", ")}${placeSel.length > 2 ? ` +${placeSel.length - 2} more` : ""}`
      : "I'll pick the highlights";
    answer(label);
    push({
      role: "ai",
      content: `Locked in${placeSel.length ? ` — ${placeSel.length} highlight${placeSel.length > 1 ? "s" : ""}` : ""}. Let's sort out how you'll get around.`,
    });
    setStage("transport");
    await sleep(650);
    if (!aliveRef.current) return;
    await runTransport();
  };

  const handleTransportContinue = async () => {
    if (busy) return;
    const label = `${modeSel}${flightSel?.price != null ? ` · flight ~$${flightSel.price}` : flightSel ? ` · ${flightSel.airline}` : ""}`;
    answer(label);
    push({
      role: "ai",
      content:
        "Almost done — here's everything you've picked so far. Want me to build the full day-by-day itinerary?",
      block: { type: "confirm" },
    });
    setStage("confirm");
  };

  const handleConfirmBuild = async () => {
    if (busy) return;
    setHistory((h) => [
      ...h.map((m) => (m.block && !m.answered ? { ...m, answered: "Ready to build" } : m)),
      {
        id: `m${++idRef.current}`,
        role: "user" as const,
        content: "Yes — build my itinerary!",
      },
    ]);
    setStage("building");
    await runBuild();
  };

  // ── card interactions ────────────────────────────────────────────────
  const pickStay = (s: Stay, i: number) => {
    if (busy) return;
    setStaySel((prev) => (prev?.name === s.name ? null : s));
    if (typeof s.lat === "number" && typeof s.lng === "number") {
      setFocusId(markerId("stay", i, s.name));
    }
  };

  const toggleDining = (p: PlaceRec, i: number) => {
    if (busy) return;
    setDiningSel((prev) =>
      prev.some((x) => x.name === p.name) ? prev.filter((x) => x.name !== p.name) : [...prev, p]
    );
    if (typeof p.lat === "number" && typeof p.lng === "number") {
      setFocusId(markerId("food", i, p.name));
    }
  };

  const togglePlace = (p: PlaceRec, i: number) => {
    if (busy) return;
    setPlaceSel((prev) =>
      prev.some((x) => x.name === p.name) ? prev.filter((x) => x.name !== p.name) : [...prev, p]
    );
    if (typeof p.lat === "number" && typeof p.lng === "number") {
      setFocusId(markerId("place", i, p.name));
    }
  };

  // ── block renderers ──────────────────────────────────────────────────
  const renderFooter = (m: HistMsg, interactive: boolean, action: React.ReactNode) => (
    <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-hairline">
      <span className="text-xs text-ink-faint">
        {interactive ? "Selections update your live map" : "Choice saved"}
      </span>
      {interactive ? (
        action
      ) : (
        <span className="text-xs font-semibold text-ok">✓ {m.answered}</span>
      )}
    </div>
  );

  const renderBlock = (m: HistMsg) => {
    const block = m.block;
    if (!block) return null;
    const interactive = !m.answered && !busy;

    if (block.type === "stays") {
      return (
        <div className="rounded-2xl border border-hairline bg-surface-1 p-3 mt-2">
          {block.items.length > 0 && (
            <ul className="space-y-2.5">
              {block.items.map((s, i) => (
                <li key={`${s.name}-${i}`}>
                  <CardShell
                    title={s.name}
                    interactive={interactive}
                    selected={staySel?.name === s.name}
                    onClick={() => pickStay(s, i)}
                  >
                    <div className="shrink-0 w-20 h-20 md:w-24 md:h-24 rounded-xl overflow-hidden bg-surface-3">
                      <PlaceImg src={s.image} alt={s.name} emoji="🏨" />
                    </div>
                    <div className="min-w-0 flex-1 pr-6">
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
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetail(stayToRec(s, i));
                        }}
                        className="inline-block text-xs font-medium text-blue-400 hover:underline mt-1"
                      >
                        View details →
                      </button>
                    </div>
                  </CardShell>
                </li>
              ))}
            </ul>
          )}
          {renderFooter(
            m,
            interactive,
            <button
              type="button"
              onClick={handleStayContinue}
              disabled={busy}
              className="px-4 py-2 text-sm font-semibold bg-accent-strong text-white rounded-xl hover:bg-accent disabled:opacity-60 transition-all"
            >
              {staySel ? `Continue with ${shortName(staySel.name, 24)}` : "Continue without a stay"}
            </button>
          )}
        </div>
      );
    }

    if (block.type === "dining" || block.type === "places") {
      const isDining = block.type === "dining";
      const items = block.items;
      const selected = isDining ? diningSel : placeSel;
      const onPick = isDining ? toggleDining : togglePlace;
      const emoji = isDining ? "🍽️" : "🎯";
      // Hoisted out of the map: `selected.some` per card made this
      // O(cards × picks) on every render of the block.
      const selectedNames = new Set(selected.map((x) => x.name));
      return (
        <div className="rounded-2xl border border-hairline bg-surface-1 p-3 mt-2">
          {items.length > 0 && (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {items.map((p, i) => (
                <li key={`${p.name}-${i}`}>
                  <CardShell
                    title={p.name}
                    interactive={interactive}
                    selected={selectedNames.has(p.name)}
                    onClick={() => onPick(p, i)}
                  >
                    <div className="shrink-0 w-16 h-16 rounded-xl overflow-hidden bg-surface-3">
                      <PlaceImg src={p.thumbnail} alt={p.name} emoji={emoji} />
                    </div>
                    <div className="min-w-0 flex-1 pr-4">
                      <h4 className="text-base font-semibold text-ink leading-snug line-clamp-2">
                        {p.name}
                      </h4>
                      <div className="mt-1">
                        <Stars rating={p.rating} reviews={p.reviews} />
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-ink-muted">
                        {p.price && <span className="font-bold text-emerald-300">{p.price}</span>}
                        {p.type && <span className="truncate">{p.type}</span>}
                      </div>
                      {p.openState && (
                        <div className="text-2xs text-ink-faint mt-1">{p.openState}</div>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetail(placeToRec(p, i));
                        }}
                        className="inline-block text-2xs font-medium text-blue-400 hover:underline mt-1"
                      >
                        View details →
                      </button>
                    </div>
                  </CardShell>
                </li>
              ))}
            </ul>
          )}
          {renderFooter(
            m,
            interactive,
            <button
              type="button"
              onClick={isDining ? handleDiningContinue : handlePlacesContinue}
              disabled={busy}
              className="px-4 py-2 text-sm font-semibold bg-accent-strong text-white rounded-xl hover:bg-accent disabled:opacity-60 transition-all"
            >
              {selected.length
                ? `Continue with ${selected.length} pick${selected.length > 1 ? "s" : ""}`
                : isDining
                  ? "Skip dining"
                  : "Continue"}
            </button>
          )}
        </div>
      );
    }

    if (block.type === "transport") {
      return (
        <div className="rounded-2xl border border-hairline bg-surface-1 p-3 mt-2">
          {block.flights.length > 0 && (
            <ul className="space-y-2.5 mb-3">
              {block.flights.map((f, i) => {
                const booking = flightBookingTarget({
                  from: f.from,
                  to: f.to,
                  date: (f.departAt || "").slice(0, 10),
                });
                const bookTitle =
                  booking.site === "the airline"
                    ? "Book this flight on the airline site"
                    : `Search ${[f.from, f.to].filter(Boolean).join(" → ")} on ${booking.site}`;
                return (
                  <li key={`${f.airline}-${f.departAt}-${i}`}>
                    <CardShell
                      title={`${f.airline} flight`}
                      interactive={interactive}
                      selected={flightSel === f}
                      onClick={() => {
                        if (!interactive) return;
                        setFlightSel((prev) => (prev === f ? null : f));
                      }}
                    >
                      {f.airlineLogo ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={f.airlineLogo}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="shrink-0 w-8 h-8 object-contain mt-1"
                        />
                      ) : (
                        <div className="shrink-0 w-8 h-8 rounded-lg bg-accent/12 flex items-center justify-center text-sm mt-1">
                          ✈️
                        </div>
                      )}
                      <div className="min-w-0 flex-1 pr-6">
                        <div className="text-base font-semibold text-ink truncate">
                          {f.airline}
                          {f.travelClass ? ` · ${f.travelClass}` : ""}
                          {f.kind === "best" && (
                            <span className="ml-2 px-2 py-1 text-2xs font-medium rounded bg-accent/15 text-blue-300">
                              Best
                            </span>
                          )}
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
                        <div className="shrink-0 text-right pr-4">
                          <div className="text-md font-bold text-ink">${f.price}</div>
                          <div className="text-3xs text-ink-faint">per person</div>
                        </div>
                      )}
                      <a
                        {...bookLinkProps(booking, bookTitle)}
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0 self-center inline-flex items-center gap-1 whitespace-nowrap rounded-xl border border-accent/35 bg-accent/12 px-3 py-2 text-xs font-semibold text-blue-300 transition-colors hover:border-accent/60 hover:bg-accent/20"
                      >
                        Book <span aria-hidden>↗</span>
                      </a>
                    </CardShell>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="eyebrow mb-2">Getting around {form.destination}</div>
          <div className="flex flex-wrap gap-2">
            {TRANSPORT_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={!interactive}
                onClick={() => setModeSel(mode)}
                className={`px-3 py-2 rounded-full text-sm font-medium border transition-all ${
                  modeSel === mode
                    ? "bg-accent-strong border-accent-strong text-white"
                    : "bg-surface-1 border-white/[0.12] text-zinc-300 hover:border-accent/60 hover:text-blue-300"
                } ${!interactive ? "opacity-70" : ""}`}
              >
                {mode}
              </button>
            ))}
          </div>

          <div className="mt-3 bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-3 text-sm text-amber-200">
            <span className="font-semibold">💡 Good to know:</span> {TRANSPORT_TIPS[modeSel]}
          </div>

          {renderFooter(
            m,
            interactive,
            <button
              type="button"
              onClick={handleTransportContinue}
              disabled={busy}
              className="px-4 py-2 text-sm font-semibold bg-accent-strong text-white rounded-xl hover:bg-accent disabled:opacity-60 transition-all"
            >
              Continue →
            </button>
          )}
        </div>
      );
    }

    // confirm
    const rows: Array<{ label: string; value: string }> = [
      { label: "Dates", value: dateRange || `${form.numDays} days` },
      { label: "Travelers", value: `${form.numTravelers} (${form.numAdults} adults)` },
      { label: "Budget", value: formatAmount(form.totalBudget, currency) },
      { label: "Stay", value: staySel ? shortName(staySel.name, 40) : "Flexible — suggest for me" },
      {
        label: "Food",
        value: diningSel.length
          ? `${diningSel.length} spot${diningSel.length > 1 ? "s" : ""} picked`
          : "Open to recommendations",
      },
      {
        label: "Highlights",
        value: placeSel.length
          ? `${placeSel.length} pick${placeSel.length > 1 ? "s" : ""}`
          : "Top attractions",
      },
      { label: "Transport", value: modeSel },
    ];
    return (
      <div className="rounded-2xl border border-hairline bg-surface-1 p-4 mt-2">
        <div className="text-sm font-bold text-ink mb-2">Your trip, summarized</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex justify-between gap-2 bg-surface-2 rounded-lg px-3 py-2 text-sm"
            >
              <span className="text-ink-muted">{r.label}</span>
              <span className="font-semibold text-ink text-right truncate">{r.value}</span>
            </div>
          ))}
        </div>
        {renderFooter(
          m,
          interactive,
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onRestart}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium text-zinc-300 border border-white/[0.12] rounded-xl hover:bg-surface-2 disabled:opacity-60 transition-all"
            >
              ✏️ Adjust preferences
            </button>
            <button
              type="button"
              onClick={handleConfirmBuild}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium bg-accent-strong text-white rounded-xl hover:bg-accent disabled:opacity-60 transition-all"
            >
              {busy ? "Building…" : "🧳 Build my full itinerary"}
            </button>
          </div>
        )}
      </div>
    );
  };

  const stageIdx = STAGE_INDEX[stage];

  return (
    <div className="max-w-7xl mx-auto animate-fade-in">
      <div className="grid lg:grid-cols-5 gap-6">
        {/* Conversation */}
        <div className="lg:col-span-3 flex flex-col bg-surface-1 rounded-2xl border border-hairline overflow-hidden">
          {/* Header */}
          <div className="px-4 md:px-6 py-4 border-b border-hairline">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="eyebrow">
                  Planning with AI · step {stageIdx + 1} of {STEP_LABELS.length}
                </div>
                <h2 className="text-lg font-bold text-ink mt-1 truncate">
                  {form.destination || "Your destination"}
                  {dateRange && (
                    <span className="text-sm font-medium text-ink-faint ml-2">{dateRange}</span>
                  )}
                </h2>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setMapOpen(true)}
                  className="lg:hidden px-3 py-2 text-xs font-semibold text-zinc-300 border border-white/[0.12] rounded-lg hover:bg-surface-2 transition-colors"
                >
                  🗺️ Map ({markers.length})
                </button>
                <button
                  type="button"
                  onClick={onRestart}
                  className="px-3 py-2 text-xs font-medium text-ink-muted border border-white/[0.12] rounded-lg hover:bg-surface-2 hover:text-zinc-200 transition-colors"
                >
                  Start over
                </button>
              </div>
            </div>

            {/* Stepper */}
            <div className="flex gap-2 mt-3 overflow-x-auto dark-scroll pb-1">
              {STEP_LABELS.map((label, i) => {
                const active = i === stageIdx;
                const done = i < stageIdx;
                return (
                  <span
                    key={label}
                    className={`flex items-center gap-2 shrink-0 px-3 py-2 rounded-lg text-xs font-semibold border transition-all ${
                      active
                        ? "bg-accent-strong border-accent-strong text-white"
                        : done
                          ? "bg-accent/12 border-accent/35 text-blue-300"
                          : "bg-surface-2 border-hairline text-ink-faint"
                    }`}
                  >
                    <span
                      className={`w-4 h-4 rounded-full text-3xs font-bold flex items-center justify-center ${
                        active
                          ? "bg-white/25 text-white"
                          : done
                            ? "bg-accent-strong text-white"
                            : "bg-white/[0.14] text-ink-muted"
                      }`}
                    >
                      {done ? "✓" : i + 1}
                    </span>
                    {label}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto dark-scroll px-4 md:px-6 py-4 gap-y-4 max-h-[68vh]"
          >
            {history.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end animate-msg-in">
                  <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-br-md bg-accent-strong text-white text-base leading-relaxed">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex gap-3 animate-msg-in">
                  <div className="shrink-0 w-7 h-7 rounded-lg border border-white/[0.1] bg-surface-2 flex items-center justify-center text-blue-300 text-xs font-medium mt-1">
                    T
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="inline-block max-w-full bg-surface-2 border border-hairline rounded-2xl px-4 py-3 text-base text-zinc-200 leading-relaxed">
                      {m.loading ? (
                        <Typing />
                      ) : (
                        <span className="whitespace-pre-line">{m.content}</span>
                      )}
                    </div>

                    {m.error && !m.loading && (
                      <div className="mt-2 bg-red-500/12 border border-red-500/35 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm text-danger">{m.error}</p>
                        <div className="flex gap-2 shrink-0">
                          {m.onRetry && (
                            <button
                              type="button"
                              onClick={() => {
                                setHistory((h) => h.filter((x) => x.id !== m.id));
                                m.onRetry?.();
                              }}
                              className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-500 transition-all"
                            >
                              Retry
                            </button>
                          )}
                          {m.onSkip && (
                            <button
                              type="button"
                              onClick={() => {
                                setHistory((h) => h.filter((x) => x.id !== m.id));
                                m.onSkip?.();
                              }}
                              className="px-4 py-2 bg-surface-1 border border-hairline-strong text-zinc-200 text-sm font-medium rounded-lg hover:bg-surface-2 transition-all"
                            >
                              Skip
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {!m.loading && renderBlock(m)}
                  </div>
                </div>
              )
            )}
          </div>

          {/* Footer hint */}
          <div className="px-4 md:px-6 py-3 border-t border-hairline bg-surface-1 text-xs text-ink-faint flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            One step at a time — the map updates live as suggestions come in.
          </div>
        </div>

        {/* Map aside (desktop) */}
        <aside className="hidden lg:block lg:col-span-2">
          <div className="sticky top-20 h-[calc(100vh-8rem)] min-h-110 flex flex-col rounded-2xl border border-white/[0.12] overflow-hidden bg-surface-1">
            <div className="h-10 shrink-0 flex items-center justify-between px-4 border-b border-hairline text-xs font-semibold text-zinc-300">
              <span className="flex items-center gap-2">
                <svg
                  className="w-3.5 h-3.5 text-accent"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                Live trip map
              </span>
              <span className="px-2 py-1 rounded-full bg-accent/12 text-blue-400 text-2xs font-bold">
                {markers.length} {markers.length === 1 ? "place" : "places"}
              </span>
            </div>
            <div className="relative flex-1 min-h-0">
              <MapView markers={markers} focusId={focusId} onFocus={setFocusId} />
            </div>
          </div>
        </aside>
      </div>

      {/* Map overlay (mobile) */}
      {mapPanelMounted && (
        <div
          className={`lg:hidden fixed inset-0 z-40 bg-zinc-950 flex flex-col ${
            mapPanelClosing ? "animate-exit pointer-events-none" : "animate-fade-in"
          }`}
        >
          <div className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-hairline">
            <span className="text-sm font-semibold text-ink">
              Live trip map · {markers.length} {markers.length === 1 ? "place" : "places"}
            </span>
            <button
              type="button"
              onClick={() => setMapOpen(false)}
              className="p-2 text-ink-muted hover:text-ink hover:bg-surface-3 rounded-lg"
              aria-label="Close map"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <div className="relative flex-1 min-h-0">
            <MapView markers={markers} focusId={focusId} onFocus={setFocusId} />
          </div>
        </div>
      )}

      <PlaceDetailModal place={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
