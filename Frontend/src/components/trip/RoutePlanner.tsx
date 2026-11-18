"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import LocationInput from "@/components/ui/LocationInput";
import CountryPicker from "@/components/ui/CountryPicker";
import CategoryIcon from "@/components/ui/CategoryIcon";
import SmartImage from "@/components/ui/SmartImage";
import HotelList from "@/components/explore/HotelList";
import {
  getRoute,
  formatDistance,
  formatDuration,
  type Coordinates,
  type RouteResponse,
} from "@/lib/osrm";
import {
  fetchRouteStopsDetailed,
  mergeRouteStops,
  readRouteStopsCache,
  routeStopsCacheKey,
  writeRouteStopsCache,
  STOP_CHIPS,
  type RouteStop,
  type StopFilter,
  type StopKind,
} from "@/lib/routeStops";
import { categoryForType, peekPlaceImage, placePhotoKey, usePlaceImage } from "@/lib/placeImages";
import type { Country } from "@/lib/countries";
import { saveTrip, type SaveState } from "@/lib/savedTrips";
import { hotelToRec, recImage, type Recommendation, type RecType } from "@/lib/recommendations";
import PlaceDetailModal from "@/components/explore/PlaceDetailModal";
import BlackBackground from "@/components/layout/BlackBackground";
import type { RouteStopMarker } from "@/components/map/TravelMap";

const TravelMap = dynamic(() => import("@/components/map/TravelMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full min-h-100 bg-zinc-900 rounded-xl animate-pulse flex items-center justify-center text-ink-faint text-sm border border-hairline">
      Loading map...
    </div>
  ),
});

interface RoutePlannerProps {
  onClose?: () => void;
}

/** Pin + chip colour per stop category (mirrors recMeta's palette). */
const KIND_COLOR: Record<StopKind, string> = {
  hotel: "#a855f7",
  restaurant: "#f97316",
  cafe: "#f59e0b",
  attraction: "#10b981",
  shopping: "#ec4899",
  other: "#60a5fa",
};

/** Search corridor options, in km from the road — capped at what the API
 *  queries around each anchor, so every option returns real rows. */
const CORRIDORS = [2, 5, 10];

/** Room for slow Overpass mirrors — past this, fail with a real message. */
const STOPS_TIMEOUT_MS = 32_000;
/** Start the cheap fallback once Overpass has been quiet this long, so the
 *  panel paints while slow/dead mirrors are still being tried. */
const STOPS_FALLBACK_DELAY_MS = 4_000;

/**
 * Corridor segments fetched in parallel; each response paints its own stops.
 *
 * One segment per route anchor: the Overpass query for a segment costs
 * (anchors × tag filters), so splitting the corridor into four one-anchor
 * queries instead of two two-anchor ones makes every individual query
 * roughly half the size — and a smaller query finishes far sooner on a
 * busy mirror. The segments run in parallel and each paints the moment it
 * lands, so the first stops now show up in seconds rather than after the
 * slowest segment of one huge sweep. Four matches the Overpass concurrency
 * budget, so no segment ever queues behind another.
 */
const STOPS_PARTS = 4;
/** Keeps the merged list near the old 80-stop ceiling. */
const STOPS_PER_PART = Math.ceil(80 / STOPS_PARTS);
/** Card thumbnails only need small renditions — details reserve the big ones. */
const THUMB_WIDTHS = [160, 320, 480];

function stopRecType(kind: StopKind): RecType {
  if (kind === "hotel") return "hotel";
  if (kind === "restaurant" || kind === "cafe") return "restaurant";
  return "attraction";
}

/** Route stop → the shared place shape used by map cards and the detail sheet. */
function stopToRec(stop: RouteStop, image?: string | null): Recommendation {
  const rec: Recommendation = {
    id: stop.id,
    name: stop.name,
    type: stopRecType(stop.kind),
    lat: stop.lat,
    lng: stop.lng,
    city: stop.city,
    description: stop.address ?? stop.category,
    openingHours: stop.openingHours,
    link: stop.website,
  };
  // Handing the already-resolved card photo to the detail sheet means its hero
  // paints from the shared store instead of starting a second lookup. When the
  // lookup hasn't landed yet, an OSM image tag still gives the sheet a real
  // Commons URL on its very first frame.
  const known = image ?? recImage({ type: rec.type, name: stop.name, imageTag: stop.imageTag });
  if (known) rec.image = known;
  return rec;
}

/**
 * One stop along the road. Independent from its neighbours: it subscribes to
 * the shared place-image store (so a photo resolved by Explore, the map or a
 * detail sheet is reused instantly), requests its own picture only once it is
 * near the viewport, and keeps its own failure state.
 */
const RouteStopCard = memo(function RouteStopCard({
  stop,
  index,
  onOpen,
  onFocus,
}: {
  stop: RouteStop;
  index: number;
  onOpen: (stop: RouteStop) => void;
  onFocus: (id: string) => void;
}) {
  const hostRef = useRef<HTMLLIElement>(null);
  const { url, onImgError } = usePlaceImage(
    {
      name: stop.name,
      type: stopRecType(stop.kind),
      lat: stop.lat,
      lng: stop.lng,
      city: stop.city,
      id: stop.id,
      wikidata: stop.wikidata,
      wikipedia: stop.wikipedia,
      imageTag: stop.imageTag,
      surface: "trip",
    },
    hostRef
  );
  const color = KIND_COLOR[stop.kind];

  return (
    <li
      ref={hostRef}
      className="group flex gap-3 rounded-xl border border-white/[0.06] bg-surface-1 p-3 transition-colors hover:border-white/[0.14] hover:bg-surface-2"
    >
      <div className="relative aspect-[4/3] w-20 shrink-0 overflow-hidden rounded-lg bg-surface-2 sm:w-24 md:w-28">
        {/* Light placeholder until a photo exists — no empty black hole. */}
        <span
          aria-hidden
          className="absolute inset-0 grid place-items-center"
          style={{ background: `${color}14`, color }}
        >
          <CategoryIcon kind={stop.kind} className="h-5 w-5 opacity-60" />
        </span>
        {url && (
          <SmartImage
            src={url}
            alt={stop.city ? `${stop.name}, ${stop.city}` : stop.name}
            onError={onImgError}
            loading={index < 3 ? "eager" : "lazy"}
            fetchPriority={index < 3 ? "high" : "auto"}
            sizes="112px"
            widths={THUMB_WIDTHS}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        )}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-black/10"
        />
        <span
          className="absolute left-1 top-1 grid h-5 min-w-5 place-items-center rounded-full border border-white/25 bg-zinc-950/80 px-1 text-3xs font-bold tabular-nums"
          style={{ color }}
        >
          {index + 1}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onOpen(stop)}
          className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 rounded"
        >
          <span className="block truncate text-base font-semibold text-ink transition-colors hover:text-blue-300">
            {stop.name}
          </span>
        </button>
        <p className="truncate text-xs text-ink-faint">
          {[stop.category, stop.address].filter(Boolean).join(" · ") || "Stop along the route"}
        </p>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
          <span className="tabular-nums">🛣 {formatDistance(stop.alongKm * 1000)} along</span>
          <span className="tabular-nums" style={{ color }}>
            ↕ {stop.offRouteKm} km off route
          </span>
          {stop.openingHours && <span>🕐 {stop.openingHours}</span>}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2">
        <button
          type="button"
          onClick={() => onFocus(stop.id)}
          title="Show on map"
          aria-label={`Show ${stop.name} on the map`}
          className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-surface-1 text-ink-muted transition-colors hover:bg-surface-3 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => onOpen(stop)}
          title="View details"
          aria-label={`View details for ${stop.name}`}
          className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-surface-1 text-ink-muted transition-colors hover:bg-surface-3 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.7" />
            <path
              d="M12 10.6v6"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
            <circle cx="12" cy="7.6" r="1.15" fill="currentColor" />
          </svg>
        </button>
      </div>
    </li>
  );
});

/** Matches the card layout above so the first paint doesn't jump. */
function RouteStopSkeleton() {
  return (
    <li className="flex gap-3 rounded-xl border border-white/[0.06] bg-surface-1 p-3">
      <div className="img-skeleton aspect-[4/3] w-20 shrink-0 rounded-lg sm:w-24 md:w-28" />
      <div className="flex-1 space-y-2 py-1">
        <div className="h-4 w-2/3 rounded bg-surface-2" />
        <div className="h-3 w-1/2 rounded bg-surface-2" />
        <div className="h-3 w-4/5 rounded bg-surface-2" />
      </div>
    </li>
  );
}

function StepCard({
  step,
  title,
  hint,
  children,
}: {
  step: number;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-surface-1 p-4 md:p-6 space-y-4">
      <div className="flex items-start gap-3">
        <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-strong text-2xs font-bold text-white">
          {step}
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold leading-tight text-ink">{title}</h3>
          {hint && <p className="mt-1 text-xs leading-snug text-ink-faint">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export default function RoutePlanner({ onClose }: RoutePlannerProps) {
  // 1 · country scoping
  const [country, setCountry] = useState<Country | null>(null);
  // 2 · endpoints
  const [originName, setOriginName] = useState("");
  const [destinationName, setDestinationName] = useState("");
  const [originCoords, setOriginCoords] = useState<Coordinates | null>(null);
  const [destinationCoords, setDestinationCoords] = useState<Coordinates | null>(null);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  // 3 · what's between them
  const [stops, setStops] = useState<RouteStop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [stopsError, setStopsError] = useState("");
  const [chip, setChip] = useState<StopFilter>("all");
  const [corridor, setCorridor] = useState(5);
  const [panel, setPanel] = useState<"route" | "destination">("route");
  const [focusStopId, setFocusStopId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Recommendation | null>(null);

  const stopsAbortRef = useRef<AbortController | null>(null);

  // With the ✕ gone, keep a keyboard way out. The place sheet owns Esc while
  // it's open, so the planner only acts once it's closed.
  useEffect(() => {
    if (!onClose) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !detail) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, detail]);

  const resetJourney = useCallback(() => {
    // Detach before aborting so the in-flight request recognises it as
    // superseded and stays silent instead of reporting a false error.
    stopsAbortRef.current?.abort();
    stopsAbortRef.current = null;
    setRoute(null);
    setStops([]);
    setStopsError("");
    setStopsLoading(false);
    setSaveState("idle");
    setSaveError("");
    setFocusStopId(null);
  }, []);

  const handleCountryChange = (next: Country | null) => {
    setCountry(next);
    setOriginName("");
    setOriginCoords(null);
    setDestinationName("");
    setDestinationCoords(null);
    setRouteError("");
    resetJourney();
  };

  const handleOriginChange = useCallback((value: string, coords?: Coordinates) => {
    setOriginName(value);
    setOriginCoords(coords ?? null);
  }, []);

  const handleDestinationChange = useCallback((value: string, coords?: Coordinates) => {
    setDestinationName(value);
    setDestinationCoords(coords ?? null);
  }, []);

  /** Fetches the corridor stops — called from the click handler, never an
   *  effect, so loading state flips without an extra render pass.
   *
   *  The corridor is split into `STOPS_PARTS` anchor groups requested in
   *  parallel. Each group appends its rows the moment it lands, so the first
   *  stretch of road paints while the remaining Overpass queries are still
   *  running — nothing waits for the slowest segment. */
  const loadStops = useCallback(async (result: RouteResponse, cacheKey: string) => {
    const cached = readRouteStopsCache(cacheKey);
    if (cached) {
      // Same endpoints already resolved in this tab — paint instantly, no
      // Overpass round trip at all.
      setStops(cached);
      setStopsLoading(false);
      setStopsError("");
      return;
    }

    stopsAbortRef.current?.abort();
    const controller = new AbortController();
    stopsAbortRef.current = controller;
    setStopsLoading(true);
    setStopsError("");
    setStops([]);

    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, STOPS_TIMEOUT_MS);
    // False once a newer request (or a reset) has taken over — in that case
    // this one must not touch state the successor now owns.
    const stillCurrent = () => stopsAbortRef.current === controller;

    const geometry = result.routes[0]?.geometry?.coordinates ?? [];
    let merged: RouteStop[] = [];
    let failed = false;
    let sawFailure = false;

    // Public Overpass mirrors can take the full 15 s deadline (or fail after
    // every mirror has been tried). Start the cheap single-request Nominatim
    // fallback while they are still working; its rows paint the panel early
    // and Overpass rows merge in later if they arrive.
    let fallbackStarted = false;
    let fallbackPromise: Promise<void> | null = null;
    const runFallback = () => {
      if (fallbackStarted || timedOut || !stillCurrent()) return;
      fallbackStarted = true;
      fallbackPromise = fetchRouteStopsDetailed(geometry, {
        corridorKm: CORRIDORS[CORRIDORS.length - 1],
        limit: 80,
        fallbackOnly: true,
        signal: controller.signal,
      })
        .then(({ places: found, failed: partFailed }) => {
          if (partFailed) sawFailure = true;
          if (!stillCurrent() || found.length === 0) return;
          merged = mergeRouteStops(merged, found);
          setStops(merged);
        })
        .catch(() => {
          failed = true;
        });
    };
    const fallbackTimer = setTimeout(runFallback, STOPS_FALLBACK_DELAY_MS);

    const requests = Array.from({ length: STOPS_PARTS }, (_, part) =>
      fetchRouteStopsDetailed(geometry, {
        corridorKm: CORRIDORS[CORRIDORS.length - 1], // widest chip below
        limit: STOPS_PER_PART,
        part,
        parts: STOPS_PARTS,
        signal: controller.signal,
      })
        .then(({ places: found, failed: partFailed }) => {
          if (partFailed) sawFailure = true;
          if (!stillCurrent() || found.length === 0) return;
          // Overpass has real rows — the fallback is no longer needed.
          clearTimeout(fallbackTimer);
          merged = mergeRouteStops(merged, found);
          setStops(merged);
        })
        .catch(() => {
          failed = true;
        })
    );

    await Promise.allSettled(requests);
    clearTimeout(fallbackTimer);

    // If the timer was cancelled by a part that found rows, it never ran.
    // Otherwise ask once for the whole corridor from the cheap Nominatim
    // fallback instead of telling the user no places exist. Its three internal
    // queries are spaced for Nominatim's ~1 req/s budget.
    if (!fallbackStarted && merged.length === 0 && !timedOut && stillCurrent()) {
      runFallback();
    }
    if (fallbackPromise) await fallbackPromise;

    clearTimeout(watchdog);
    if (!stillCurrent()) return;

    setStopsLoading(false);
    if (merged.length > 0) {
      // Partial failures still leave a usable list — don't replace it with an
      // error banner just because one segment timed out.
      if (!failed) writeRouteStopsCache(cacheKey, merged);
      return;
    }
    setStopsError(
      timedOut
        ? "The route search took too long. Please try again in a moment."
        : failed || sawFailure
          ? "Couldn't reach the stop search service. Please try again in a moment."
          : "Nothing found inside this corridor — try widening it below."
    );
  }, []);

  const handlePlanRoute = async () => {
    if (!country) {
      setRouteError("Pick a country first.");
      return;
    }
    if (!originCoords || !destinationCoords) {
      setRouteError("Choose both start and finish from the suggestions.");
      return;
    }
    setRouteError("");
    setRouteLoading(true);
    resetJourney();
    try {
      const result = await getRoute(originCoords, destinationCoords);
      setRoute(result);
      const cacheKey = routeStopsCacheKey(originCoords, destinationCoords);
      void loadStops(result, cacheKey);
    } catch {
      setRouteError("Failed to calculate the route. Please try again.");
    } finally {
      setRouteLoading(false);
    }
  };

  const handleSwap = () => {
    setOriginName(destinationName);
    setDestinationName(originName);
    setOriginCoords(destinationCoords);
    setDestinationCoords(originCoords);
    resetJourney();
    setRouteError("");
  };

  const handleSaveRoute = async () => {
    if (!topRoute || !originCoords || !destinationCoords) return;
    setSaveState("saving");
    setSaveError("");
    try {
      await saveTrip({
        origin_name: originName.trim() || "Origin",
        destination_name: destinationName.trim() || "Destination",
        origin_lat: originCoords.lat,
        origin_lng: originCoords.lng,
        dest_lat: destinationCoords.lat,
        dest_lng: destinationCoords.lng,
        distance: topRoute.distance,
        duration: topRoute.duration,
      });
      setSaveState("saved");
    } catch {
      setSaveState("error");
      setSaveError("Couldn't save this route. Please try again.");
    }
  };

  const topRoute = route?.routes?.[0];

  /* ————— Stops between origin and destination ————— */

  const inCorridor = useMemo(
    () => stops.filter((s) => s.offRouteKm <= corridor),
    [stops, corridor]
  );

  const counts = useMemo(() => {
    const tally: Record<StopFilter, number> = {
      all: inCorridor.length,
      hotel: 0,
      restaurant: 0,
      cafe: 0,
      attraction: 0,
      shopping: 0,
      other: 0,
    };
    for (const s of inCorridor) tally[s.kind] += 1;
    return tally;
  }, [inCorridor]);

  const filtered = useMemo(
    () => (chip === "all" ? inCorridor : inCorridor.filter((s) => s.kind === chip)),
    [inCorridor, chip]
  );

  const stopMarkers = useMemo<RouteStopMarker[]>(
    () =>
      filtered.map((s, i) => ({
        id: s.id,
        lat: s.lat,
        lng: s.lng,
        label: s.name,
        index: i + 1,
        color: KIND_COLOR[s.kind],
      })),
    [filtered]
  );

  const changeCorridor = (km: number) => {
    setCorridor(km);
    // The active chip may fall out of range — drop back to "All" rather than
    // showing an empty list under a selected chip.
    if (chip !== "all" && !stops.some((s) => s.kind === chip && s.offRouteKm <= km)) {
      setChip("all");
    }
  };

  const openStop = useCallback((stop: RouteStop) => {
    const category = categoryForType(stopRecType(stop.kind));
    const key = placePhotoKey(category, stop.name, stop.city ?? "");
    setDetail(stopToRec(stop, peekPlaceImage(key)));
  }, []);

  // Stable identities keep memoized rows from re-rendering on every parent
  // update (new stop segments, chip/corridor changes, image arrivals).
  const toggleFocusStop = useCallback((id: string) => {
    setFocusStopId((prev) => (prev === id ? null : id));
  }, []);

  const handleStopMarkerClick = useCallback(
    (id: string) => {
      const stop = stops.find((s) => s.id === id);
      if (stop) openStop(stop);
    },
    [stops, openStop]
  );

  const ready = Boolean(country && originCoords && destinationCoords);

  return (
    <div className="relative isolate flex flex-col h-full min-h-0 bg-black">
      <BlackBackground variant="absolute" />
      {/* No header bar and no ✕ — the toolbar's Route button toggles this
          panel, and Esc closes it (key handler above). */}
      <div className="flex-1 min-h-0 overflow-y-auto dark-scroll px-3 md:px-4 py-4">
        <div className="grid lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] gap-4 lg:gap-6 items-start">
          {/* ——— Left: the three steps ——— */}
          <div className="space-y-4">
            <StepCard
              step={1}
              title="Choose a country"
              hint="Every suggestion after this stays inside it."
            >
              <CountryPicker value={country} onChange={handleCountryChange} />
            </StepCard>

            <StepCard
              step={2}
              title="Start and finish"
              hint={
                country
                  ? `Type at least 3 letters — places inside ${country.name} are suggested as you go.`
                  : "Pick a country first to enable the search."
              }
            >
              <div className="space-y-3">
                <LocationInput
                  dark
                  label="From"
                  value={originName}
                  onChange={handleOriginChange}
                  placeholder={country ? `e.g. Paris, ${country.name}` : "Select a country first"}
                  countryCodes={country?.code}
                  disabled={!country}
                />

                <div className="flex justify-center">
                  <button
                    onClick={handleSwap}
                    aria-label="Swap start and finish"
                    title="Swap locations"
                    className="relative grid h-11 w-11 place-items-center rounded-lg border border-white/10 bg-surface-1 text-ink-muted transition-colors hover:bg-surface-3 hover:border-white/20 active:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                  >
                    <svg
                      className="w-4 h-4 text-ink-muted"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
                      />
                    </svg>
                  </button>
                </div>

                <LocationInput
                  dark
                  label="To"
                  value={destinationName}
                  onChange={handleDestinationChange}
                  placeholder={country ? `e.g. Lyon, ${country.name}` : "Select a country first"}
                  countryCodes={country?.code}
                  disabled={!country}
                />

                <button
                  onClick={handlePlanRoute}
                  disabled={routeLoading || !ready}
                  className="w-full min-h-touch py-3 bg-accent-strong text-white font-medium rounded-lg hover:bg-accent active:bg-blue-700 disabled:bg-surface-2 disabled:text-ink-faint disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70"
                >
                  {routeLoading ? "Calculating..." : "Find route & stops"}
                </button>

                {routeError && (
                  <p
                    role="alert"
                    className="text-sm text-danger bg-red-500/10 border border-red-500/20 p-3 rounded-lg"
                  >
                    {routeError}
                  </p>
                )}
              </div>
            </StepCard>

            {topRoute && (
              <StepCard step={3} title="Route summary">
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-accent/10 border border-accent/20 rounded-xl p-3 md:p-4 text-center">
                      <div className="text-xl md:text-2xl font-bold text-blue-300 break-words">
                        {formatDistance(topRoute.distance)}
                      </div>
                      <div className="text-sm text-blue-400/90 mt-1">Distance</div>
                    </div>
                    <div className="bg-violet-500/10 border border-violet-500/20 rounded-xl p-3 md:p-4 text-center">
                      <div className="text-xl md:text-2xl font-bold text-violet-300 break-words">
                        {formatDuration(topRoute.duration)}
                      </div>
                      <div className="text-sm text-violet-400/90 mt-1">Duration</div>
                    </div>
                  </div>

                  {topRoute.legs && (
                    <div className="space-y-2">
                      {topRoute.legs.map((leg, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between text-sm text-ink-muted bg-surface-1 border border-white/[0.06] rounded-lg p-3"
                        >
                          <span className="truncate flex-1 text-zinc-300">
                            {leg.summary || `Leg ${i + 1}`}
                          </span>
                          <span className="ml-2 whitespace-nowrap">
                            {formatDistance(leg.distance)} · {formatDuration(leg.duration)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleSaveRoute}
                    disabled={saveState === "saving" || saveState === "saved"}
                    className={`w-full py-3 text-sm font-medium rounded-lg border transition-colors flex items-center justify-center gap-2 ${
                      saveState === "saved"
                        ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300 cursor-default"
                        : "bg-accent-strong border-accent-strong text-white hover:bg-accent disabled:bg-surface-2 disabled:border-hairline disabled:text-ink-faint disabled:cursor-not-allowed"
                    }`}
                  >
                    {saveState === "saved" ? (
                      <>
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                        Saved to your trips
                      </>
                    ) : saveState === "saving" ? (
                      "Saving..."
                    ) : (
                      <>
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 4H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2M8 4a2 2 0 002 2h4a2 2 0 002-2M8 4a2 2 0 012-2h4a2 2 0 012 2"
                          />
                        </svg>
                        Save route
                      </>
                    )}
                  </button>

                  {saveError && (
                    <p className="text-sm text-danger bg-red-500/10 border border-red-500/20 p-3 rounded-lg">
                      {saveError}
                    </p>
                  )}
                  {saveState === "saved" && (
                    <a
                      href="/trips"
                      className="block text-center text-sm text-blue-400 hover:text-blue-300 hover:underline"
                    >
                      View it in Saved trips →
                    </a>
                  )}
                </div>
              </StepCard>
            )}
          </div>

          {/* ——— Right: map + what's along the way ——— */}
          <div className="space-y-4">
            <div className="rounded-xl border border-hairline bg-zinc-900 overflow-hidden h-80 md:h-100 lg:h-115 [&>div]:border-0 [&>div]:rounded-2xl">
              <TravelMap
                origin={originCoords}
                destination={destinationCoords}
                route={route}
                stops={stopMarkers}
                focusStopId={focusStopId}
                onStopClick={handleStopMarkerClick}
              />
            </div>

            <div className="rounded-xl border border-hairline bg-surface-1 p-4 md:p-6 space-y-4">
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { key: "route", label: "Along the route", icon: "🛣️" },
                    { key: "destination", label: "At destination", icon: "📍" },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setPanel(t.key)}
                    className={`min-h-9.5 rounded-lg border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
                      panel === t.key
                        ? "border-accent/60 bg-accent/15 text-blue-200"
                        : "border-white/10 bg-surface-1 text-zinc-300 hover:bg-surface-3"
                    }`}
                  >
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>

              {panel === "route" ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-ink">Stops between your endpoints</h3>
                      <p className="text-sm text-ink-faint">
                        {topRoute
                          ? `${counts.all} place${counts.all === 1 ? "" : "s"} within ${corridor} km of the road · ${formatDistance(topRoute.distance)} total`
                          : "Calculate a route to see hotels, food and sights on the way."}
                      </p>
                    </div>
                    {topRoute && (
                      <select
                        value={corridor}
                        onChange={(e) => changeCorridor(Number(e.target.value))}
                        aria-label="Distance from the road"
                        className="min-h-9.5 text-sm border border-white/10 rounded-lg px-3 py-2 bg-zinc-900 text-zinc-300 outline-none transition-colors hover:border-white/20 focus:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 [&>option]:bg-zinc-900"
                      >
                        {CORRIDORS.map((km) => (
                          <option key={km} value={km}>
                            Within {km} km of road
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {topRoute && (
                    <div className="flex flex-wrap gap-2">
                      {STOP_CHIPS.map((c) => {
                        const n = counts[c.kind] ?? 0;
                        const active = chip === c.kind;
                        const disabled = !active && n === 0;
                        return (
                          <button
                            key={c.kind}
                            type="button"
                            disabled={disabled}
                            onClick={() => setChip(c.kind)}
                            className={`min-h-8.5 rounded-full border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
                              active
                                ? "border-accent/60 bg-accent/15 text-blue-200"
                                : "border-white/10 bg-surface-1 text-zinc-300 hover:bg-surface-3"
                            } ${disabled ? "opacity-40 cursor-not-allowed hover:bg-surface-1" : ""}`}
                          >
                            <span aria-hidden="true">{c.emoji}</span> {c.label}
                            <span className="ml-2 tabular-nums text-ink-faint">{n}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {!topRoute && (
                    <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center">
                      <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg bg-surface-2 text-zinc-600">
                        <CategoryIcon kind="attraction" className="w-5 h-5" />
                      </span>
                      <p className="text-sm text-ink-muted">
                        Pick a country, then a start and finish — we&apos;ll map what&apos;s worth
                        stopping for on the way.
                      </p>
                    </div>
                  )}

                  {topRoute && stopsLoading && filtered.length === 0 && (
                    <ul className="space-y-2.5" role="status" aria-label="Loading stops">
                      {[1, 2, 3].map((i) => (
                        <RouteStopSkeleton key={i} />
                      ))}
                    </ul>
                  )}

                  {topRoute && !stopsLoading && stopsError && filtered.length === 0 && (
                    <p className="text-sm text-amber-300/90 bg-amber-500/10 border border-amber-500/20 p-3 rounded-lg">
                      {stopsError}
                    </p>
                  )}

                  {topRoute && !stopsLoading && !stopsError && filtered.length === 0 && (
                    <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center">
                      <p className="text-sm text-ink-muted">
                        Nothing of this kind within {corridor} km — widen the corridor or switch
                        category.
                      </p>
                    </div>
                  )}

                  {stopsError && filtered.length > 0 && (
                    <p className="text-xs text-amber-300/80">{stopsError}</p>
                  )}

                  {filtered.length > 0 && (
                    <ul className="space-y-2.5">
                      {filtered.map((s, i) => (
                        <RouteStopCard
                          key={s.id}
                          stop={s}
                          index={i}
                          onOpen={openStop}
                          onFocus={toggleFocusStop}
                        />
                      ))}
                    </ul>
                  )}

                  {topRoute && stopsLoading && filtered.length > 0 && (
                    <p className="flex items-center gap-2 text-xs text-ink-faint" role="status">
                      <span className="h-3 w-3 animate-spin rounded-full border border-white/25 border-t-blue-400" />
                      Finding more stops along the road…
                    </p>
                  )}
                </>
              ) : destinationCoords ? (
                <HotelList
                  lat={destinationCoords.lat}
                  lng={destinationCoords.lng}
                  onSelectHotel={(h) => setDetail(hotelToRec(h))}
                />
              ) : (
                <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center">
                  <p className="text-sm text-ink-muted">
                    Choose a finish point to list stays around it.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <PlaceDetailModal place={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
