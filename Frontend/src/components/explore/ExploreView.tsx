"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { countryCodeForPlace, geocodePlace } from "@/lib/osrm";
import {
  categoryForType,
  claimDeadRetry,
  fetchPlaceImage,
  peekPlaceImage,
  placePhotoKey,
  preloadDetailImage,
  publishPlaceImage,
  usePlaceImageSync,
} from "@/lib/placeImages";
import { useInView } from "@/lib/useInView";
import { recImage, recMeta, type RecType, type Recommendation } from "@/lib/recommendations";
import PlaceDetailModal from "@/components/explore/PlaceDetailModal";
import HotelDetailSheet from "@/components/explore/HotelDetailSheet";
import CategoryIcon from "@/components/ui/CategoryIcon";
import SavePlaceButton from "@/components/ui/SavePlaceButton";
import SmartImage from "@/components/ui/SmartImage";
import { savedPlaceKey, useSavedPlaces } from "@/lib/savedPlaces";
import { rankByAffinity, savedAffinity } from "@/lib/savedProfile";
import { formatReviewCount } from "@/lib/reviews";
import BlackBackground from "@/components/layout/BlackBackground";
import { useExitTransition } from "@/lib/useExitTransition";
import type { MapMarkerData } from "@/components/map/MapView";

const MapView = dynamic(() => import("@/components/map/MapView"), { ssr: false });

/**
 * Hosts mirrored in next.config.ts `images.remotePatterns`. Photos from any
 * other host (fixtures, RapidAPI) keep flowing through the
 * /api/img proxy via SmartImage instead of the optimizer.
 */
const RECENT_KEY = "tripcraft_explore_recent";

/**
 * One in-flight country check per location key.
 *
 * Module scope, not a ref: React 19 runs mount effects twice in development,
 * so the first run's cleanup cancels its result and the second must be able to
 * await the same request instead of issuing it again. A plain Set would skip
 * that second run and lose the rescue entirely.
 */
const countryProbes = new Map<string, Promise<string | null>>();

type ExploreTab = "for-you" | "experiences" | "restaurants" | "stays" | "locations" | "guides";

export interface ExploreLoc {
  name: string;
  lat: number;
  lng: number;
  current?: boolean;
  /**
   * True when the user picked a country ("Russia") rather than a city. A
   * country's geocoded centre is not an urban centre, so the normal point
   * sweep is meaningless there — Explore shows its destination cities instead.
   */
  country?: boolean;
  /** ISO 3166-1 alpha-2 of the picked country. */
  countryCode?: string;
}

interface ExploreItem {
  id: string;
  name: string;
  kind: RecType;
  lat: number;
  lng: number;
  /** City hint for photo lookups (e.g. "Paris") — avoids per-card geocoding. */
  city?: string;
  image?: string;
  /** Name used for image lookup when it differs from `name` (guides). */
  imageQuery?: string;
  /** Stable place id from the places API ("osm:node/123") — 7-day image cache. */
  placeId?: string;
  /** OSM/Wikidata photo identity threaded into the image lookup. */
  wikidata?: string;
  osmWikipedia?: string;
  osmImage?: string;
  /** Hotel star classification (OSM `stars`) when tagged. */
  stars?: number;
  /** Straight-line distance to the searched centre, km (Stays sort: Nearest). */
  distanceKm?: number;
  rating?: number;
  /** Review count for the map card's rating line — rendered as 13k / 14.3k. */
  reviews?: number;
  price?: string;
  desc?: string;
  tag?: string;
  link?: string;
  openState?: string;
}

interface NearbyPlaceLite {
  id?: string;
  name: string;
  rating?: number;
  reviews?: number;
  type?: string;
  price?: string;
  openState?: string;
  address?: string;
  thumbnail?: string;
  lat?: number;
  lng?: number;
  link?: string;
  wikidata?: string;
  osmWikipedia?: string;
  osmImage?: string;
  stars?: number;
  distanceKm?: number;
  /** Server-known image (7-day memo) — shown immediately, no lookup. */
  imageUrl?: string;
}

interface ApiResult {
  items: ExploreItem[];
  /** Exact source total ("1,240 hotels in Pune") when the API reported one. */
  total?: number;
  hasMore?: boolean;
  /**
   * True while the server is still building the FULL city pool behind the
   * fast first screen it already sent. The client re-asks (a cache hit on
   * the server) to pick up the complete list on its own.
   */
  pending?: boolean;
}

interface ApiState extends ApiResult {
  key: string;
  status: "loading" | "ready" | "error";
}

const TABS: Array<{ id: ExploreTab; label: string }> = [
  { id: "for-you", label: "For You" },
  { id: "experiences", label: "Things to do" },
  { id: "restaurants", label: "Restaurants" },
  { id: "stays", label: "Stays" },
  { id: "locations", label: "Locations" },
  { id: "guides", label: "Guides" },
];

const CURATED_FILTERS = [
  "All",
  "Beach",
  "City",
  "Culture",
  "Adventure",
  "Historic",
  "Luxury",
  "Island",
  "Romantic",
];

const SCROLL_X = "overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** Result-grid chunk size for incremental rendering. */
const EXPLORE_PAGE = 24;

/**
 * How the grid asks for the full city pool the server is still building.
 * The first re-ask comes quickly (the wide sweep often lands within a few
 * seconds), then it backs off; the attempt cap stops the polling for good.
 */
const POOL_REFRESH_MAX = 8;
const POOL_REFRESH_BASE_MS = 1_500;
const POOL_REFRESH_MAX_MS = 8_000;
/**
 * Sibling tabs are warmed ONE at a time. Every warm-up is a full city sweep
 * on the public Overpass mirrors, and the active tab's own sweep has to share
 * those mirrors — waking five tabs at once used to starve the grid the user
 * was actually looking at, which is what made the first cards crawl in.
 */
const PREWARM_CONCURRENCY = 1;

const GUIDE_TITLES: Array<{ title: string; focus: string }> = [
  { title: "48 hours in {city}", focus: "city skyline" },
  { title: "A food lover's guide to {city}", focus: "street food market" },
  { title: "{city} on a budget", focus: "budget city trip" },
  { title: "First-timer's guide to {city}", focus: "famous landmark" },
  { title: "Where to stay in {city}", focus: "boutique courtyard hotel" },
  { title: "Hidden gems in {city}", focus: "hidden alley" },
  { title: "A romantic escape to {city}", focus: "romantic dinner terrace" },
  { title: "Five perfect days in {city}", focus: "scenic viewpoint" },
];

/** Every tab except Guides is backed by a live lookup for the chosen location. */
function isApiTab(t: ExploreTab): boolean {
  return t !== "guides";
}

/** "Paris, France" → "Paris" — shared city hint for photo lookups. */
function cityFromLoc(l: ExploreLoc): string {
  return (l.name.split(",")[0] || l.name).trim();
}

/** Editorial guide cards built for the currently selected location. */
function guideItemsFor(l: ExploreLoc): ExploreItem[] {
  const city = cityFromLoc(l) || l.name;
  return GUIDE_TITLES.map(({ title, focus }, i) => ({
    id: `guide-${i}`,
    name: title.replace("{city}", city),
    kind: "destination" as RecType,
    lat: l.lat,
    lng: l.lng,
    city,
    // Themed query per guide (the lookup appends the city hint) — each card
    // gets its own photo instead of all eight sharing the city showcase shot.
    imageQuery: focus,
    tag: "Guide",
    desc: `Ideas for ${l.name}`,
  }));
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function priceLevel(price?: string): string | null {
  if (!price) return null;
  const p = price.trim();
  if (/^[€$₹]+$/.test(p)) {
    const n = p.length;
    return n >= 3 ? "$$$" : n === 2 ? "$$" : "$";
  }
  const amt = parseFloat(p.replace(/[^0-9.]/g, ""));
  if (Number.isFinite(amt)) {
    if (amt < 100) return "$";
    if (amt <= 250) return "$$";
    return "$$$";
  }
  return null;
}

function matchesFilter(item: ExploreItem, f: string): boolean {
  if (f === "All") return true;
  if (f === "Top rated") return (item.rating ?? 0) >= 4.5;
  if (f === "Open now") return (item.openState ?? "").toLowerCase().startsWith("open");
  if (f === "★ 4+") return (item.stars ?? 0) >= 4;
  if (f === "$" || f === "$$" || f === "$$$") return priceLevel(item.price) === f;
  return item.tag === f;
}

/** One server-paginated page of city places ("Showing 40 of 1,240 hotels…"). */
async function fetchCityPlaces(
  l: ExploreLoc,
  category: string,
  offset: number,
  limit: number
): Promise<{ places: NearbyPlaceLite[]; total: number; hasMore: boolean; pending: boolean }> {
  const res = await fetch("/api/places/city", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lat: l.lat,
      lng: l.lng,
      category,
      page: Math.floor(offset / limit) + 1,
      limit,
      offset,
    }),
    // The route bounds its own sweep; this is the last line of defence so a
    // dead connection can never leave the grid on skeletons forever.
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error("Failed to load places");
  const data = (await res.json()) as {
    places?: NearbyPlaceLite[];
    total?: number;
    hasMore?: boolean;
    pending?: boolean;
  };
  return {
    places: Array.isArray(data.places) ? data.places : [],
    total: typeof data.total === "number" ? data.total : 0,
    hasMore: data.hasMore === true,
    pending: data.pending === true,
  };
}

/** Free-text search returns mixed types — pick the card kind from the OSM type. */
function searchKindFor(p: NearbyPlaceLite): RecType {
  const t = (p.type ?? "").toLowerCase();
  if (/(hotel|hostel|motel|lodg|resort|guest_house|guest house|apartment|bnb|b&b)/.test(t)) {
    return "hotel";
  }
  if (
    /(restaurant|cafe|caf\u00e9|coffee|bar\b|pub\b|fast_food|food|pizza|bakery|diner|bistro|noodle|kitchen)/.test(
      t
    )
  ) {
    return "restaurant";
  }
  return "attraction";
}

function toNearbyItems(
  places: NearbyPlaceLite[],
  kind: RecType | ((p: NearbyPlaceLite) => RecType),
  city: string
): ExploreItem[] {
  const out: ExploreItem[] = [];
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    if (!p || typeof p.lat !== "number" || typeof p.lng !== "number") continue;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !p.name) continue;
    const baseKind = typeof kind === "function" ? kind(p) : kind;
    const extra = [p.type, p.address].filter(Boolean).join(" · ");
    // Airports arrive through the generic nearby searches — spot them by their
    // category so the pin gets the plane glyph instead of the target one.
    const placeKind: RecType =
      baseKind !== "hotel" &&
      baseKind !== "restaurant" &&
      /airport|aerodrome|aeropuerto/i.test(p.type ?? "")
        ? "airport"
        : baseKind;
    out.push({
      id: p.id ?? `${placeKind}-${i}-${slugify(p.name)}`,
      name: p.name,
      kind: placeKind,
      lat: p.lat,
      lng: p.lng,
      city,
      image: p.thumbnail ?? p.imageUrl,
      placeId: p.id,
      wikidata: p.wikidata,
      osmWikipedia: p.osmWikipedia,
      osmImage: p.osmImage,
      stars: p.stars,
      distanceKm: p.distanceKm,
      rating: p.rating,
      reviews: p.reviews,
      price: p.price,
      openState: p.openState,
      desc: extra || undefined,
      link: p.link,
    });
  }
  return out;
}

/** Live hotels (ratings + prices) — tops the first Stays page. */
async function fetchLiveHotels(l: ExploreLoc): Promise<ExploreItem[]> {
  const named =
    !l.current && l.name.trim().length > 0 && l.name.toLowerCase() !== "current location";
  if (!named) return [];
  try {
    const res = await fetch("/api/hotels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The coordinates travel with the request: a name alone is ambiguous
      // ("Rome" geocodes to Rome, Georgia), and the user picked a place on
      // the map — that is the city we want the hotels of.
      body: JSON.stringify({ destination: l.name, lat: l.lat, lng: l.lng }),
      // Curated hotels are a bonus on top of the OSM stays — they must never
      // hold the Stays grid hostage.
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { hotels?: Recommendation[] };
    const out: ExploreItem[] = [];
    let i = 0;
    for (const h of data.hotels ?? []) {
      if (typeof h.lat !== "number" || typeof h.lng !== "number" || !h.name) continue;
      out.push({
        id: `stay-${i++}-${slugify(h.name)}`,
        name: h.name,
        kind: "hotel" as RecType,
        lat: h.lat,
        lng: h.lng,
        city: cityFromLoc(l),
        image: h.image,
        rating: h.rating,
        reviews: h.reviews,
        price: h.price,
        desc: h.description,
        link: h.link,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchStays(l: ExploreLoc, offset: number): Promise<ApiResult> {
  const limit = offset === 0 ? 40 : 20;
  // Both requests start together; only the places request can fail the tab
  // (the curated hotels are an optional enrichment). Awaiting in this order
  // still keeps them concurrent.
  const pagePromise = fetchCityPlaces(l, "hotels", offset, limit);
  const curatedPromise = offset === 0 ? fetchLiveHotels(l) : Promise.resolve([] as ExploreItem[]);
  const page = await pagePromise;
  const curated = await curatedPromise;
  let items = toNearbyItems(page.places, "hotel", cityFromLoc(l));
  if (curated.length > 0) {
    const names = new Set(curated.map((h) => h.name.toLowerCase()));
    items = [...curated, ...items.filter((i) => !names.has(i.name.toLowerCase()))];
  }
  return { items, total: page.total, hasMore: page.hasMore, pending: page.pending };
}

async function fetchTabItems(tab: ExploreTab, l: ExploreLoc, offset: number): Promise<ApiResult> {
  const limit = offset === 0 ? 40 : 20;
  if (tab === "stays") return fetchStays(l, offset);
  const category =
    tab === "for-you"
      ? "highlights"
      : tab === "locations"
        ? "landmarks"
        : tab === "experiences"
          ? "experiences"
          : "restaurants";
  // Highlights are mixed (a famous café can outrank a monument), so each card
  // takes its kind from the place's own OSM category instead of the tab.
  const kind: RecType | ((p: NearbyPlaceLite) => RecType) =
    tab === "restaurants" ? "restaurant" : tab === "for-you" ? searchKindFor : "attraction";
  const page = await fetchCityPlaces(l, category, offset, limit);
  return {
    items: toNearbyItems(page.places, kind, cityFromLoc(l)),
    total: page.total,
    hasMore: page.hasMore,
    pending: page.pending,
  };
}

interface Suggestion {
  name: string;
  full: string;
  lat: number;
  lng: number;
  /** Nominatim's address role — "country" switches Explore into country mode. */
  addresstype?: string;
  countryCode?: string;
}

function LocationMenu({
  value,
  recents,
  onSelect,
  onClearRecents,
}: {
  value: ExploreLoc;
  recents: ExploreLoc[];
  onSelect: (l: ExploreLoc) => void;
  onClearRecents: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [geoErr, setGeoErr] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const q = query.trim();
      if (q.length < 2) {
        setItems([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      try {
        const res = await geocodePlace(q);
        if (!alive) return;
        setItems(
          res
            .slice(0, 5)
            .map((s) => ({
              name: s.place_name.split(",")[0].trim(),
              full: s.place_name,
              lat: s.center[1],
              lng: s.center[0],
              addresstype: s.addresstype,
              countryCode: s.countryCode,
            }))
            .filter((s) => s.name)
        );
      } catch {
        if (alive) setItems([]);
      } finally {
        if (alive) setSearching(false);
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  const pick = (l: ExploreLoc) => {
    onSelect(l);
    setQuery("");
    setItems([]);
    setOpen(false);
  };

  const locate = () => {
    setGeoErr(false);
    if (!navigator.geolocation) {
      setGeoErr(true);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        pick({
          name: "Current location",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          current: true,
        }),
      () => setGeoErr(true),
      { enableHighAccuracy: false, timeout: 8000 }
    );
  };

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center gap-2 max-w-65 pl-3 pr-2 py-2 rounded-xl border border-white/[0.12] bg-surface-2 hover:border-white/25 hover:bg-surface-3 text-left transition-colors"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-strong/15 text-blue-400">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17.657 16.657L13.414 20.9a2 2 0 01-2.828 0l-4.243-4.243a8 8 0 1111.315 0z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-ink-faint leading-none">Location</span>
          <span className="block truncate text-sm font-medium text-ink leading-tight mt-1">
            {value.name}
          </span>
        </span>
        <svg
          className={`w-4 h-4 shrink-0 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose a location"
          className="absolute right-0 top-full mt-2 w-75 max-w-[calc(100vw-2.5rem)] rounded-2xl border border-white/[0.1] bg-zinc-900 shadow-2xl shadow-black/60 z-40 p-3 animate-fade-in"
        >
          <div className="relative">
            <svg
              className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
              />
            </svg>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a city or place"
              className="w-full rounded-xl bg-zinc-800 border border-zinc-700 pl-8 pr-3 py-3 text-sm text-ink placeholder-zinc-500 outline-none focus:border-accent/50 focus:ring-4 focus:ring-blue-500/15"
            />
          </div>

          {searching && <p className="px-1 pt-2 text-xs text-ink-faint">Searching…</p>}

          {items.length > 0 && (
            <ul className="mt-2 space-y-0.5 max-h-44 overflow-y-auto dark-scroll">
              {items.map((s, i) => (
                <li key={`${s.lat},${s.lng},${i}`}>
                  <button
                    type="button"
                    onClick={() =>
                      pick({
                        name: s.name,
                        lat: s.lat,
                        lng: s.lng,
                        country: s.addresstype === "country",
                        countryCode: s.countryCode,
                      })
                    }
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-zinc-800 text-sm text-zinc-200 truncate"
                    title={s.full}
                  >
                    {s.full}
                    {s.addresstype === "country" && (
                      <span className="ml-2 rounded-full border border-blue-400/30 bg-blue-500/10 px-1.5 py-0.5 text-2xs font-semibold text-blue-300">
                        Country
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={locate}
            className="mt-2 w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-zinc-800/70 hover:bg-zinc-800 text-sm font-medium text-ink transition-colors"
          >
            <svg
              className="w-4 h-4 text-blue-400 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17.657 16.657L13.414 20.9a2 2 0 01-2.828 0l-4.243-4.243a8 8 0 1111.315 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            Use current location
          </button>

          {geoErr && (
            <p className="px-1 pt-2 text-xs text-rose-400">Could not get your location.</p>
          )}

          {recents.length > 0 && (
            <div className="mt-3 border-t border-zinc-800 pt-3">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-sm font-medium text-ink-faint">Recent</span>
                <button
                  type="button"
                  onClick={onClearRecents}
                  className="text-2xs text-ink-faint hover:text-zinc-300"
                >
                  Clear
                </button>
              </div>
              <ul className="space-y-0.5 max-h-32 overflow-y-auto dark-scroll">
                {recents.map((r) => (
                  <li key={`${r.name}-${r.lat}`}>
                    <button
                      type="button"
                      onClick={() => pick(r)}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-zinc-800 text-sm text-zinc-300 truncate flex items-center gap-2"
                    >
                      <svg
                        className="w-3.5 h-3.5 text-ink-faint shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                      <span className="truncate">{r.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function useCardImage(
  item: ExploreItem,
  hostRef?: { current: HTMLDivElement | null }
): {
  src: string | null;
  onImgError: () => void;
  preload: () => void;
} {
  const immediate = recImage({
    type: item.kind,
    name: item.imageQuery ?? item.name,
    image: item.image,
    imageTag: item.osmImage,
  });
  // Warm two screens ahead: the lookup (and its warm-ahead bytes) should be
  // underway before the card scrolls into view, not when it arrives there.
  const nearViewport = useInView(hostRef, "1200px 0px");
  const name = item.imageQuery ?? item.name;
  const category = categoryForType(item.kind);
  const key = placePhotoKey(category, name, item.city ?? "");
  // Shared store: the resolved URL is the same object the details window,
  // map card and cluster row read — opening details never re-looks-up.
  const shared = usePlaceImageSync(key);
  // A dead record photo must be allowed to step aside: without this the
  // `immediate ?? shared` order would keep pinning the broken URL on screen
  // no matter what the re-resolution found.
  const [immediateDead, setImmediateDead] = useState(false);
  const activeImmediate = immediate && !immediateDead ? immediate : null;
  // `shared` still holds the dead record photo until the replacement lands
  // (it was published there) — never treat that as resolved.
  const resolved = activeImmediate ?? (shared && shared !== immediate ? shared : null);

  useEffect(() => {
    // Immediate images (record photo / city stock) never need the lookup;
    // they are published too so the details window can reuse them. Once one
    // is reported dead we fall through and actually resolve a replacement.
    if (activeImmediate) {
      if (shared !== activeImmediate) publishPlaceImage(key, activeImmediate);
      return;
    }
    if (!nearViewport) return;
    // Already resolved (cache, hover preload, another surface): skip.
    if (resolved) return;
    // A dead record photo's replacement is owned by onImgError's `busted`
    // lookup (which publishes here when it lands). Starting a plain lookup
    // alongside it would only re-read the dead URL from the client cache.
    if (immediate && immediateDead && shared === immediate) return;
    let alive = true;
    fetchPlaceImage(name, category, {
      lat: item.lat,
      lng: item.lng,
      city: item.city,
      id: item.placeId,
      wikidata: item.wikidata,
      wikipedia: item.osmWikipedia,
      imageTag: item.osmImage,
      surface: "explore",
    }).then((u) => {
      if (alive) publishPlaceImage(key, u);
    });
    return () => {
      alive = false;
    };
  }, [
    shared,
    resolved,
    activeImmediate,
    immediate,
    immediateDead,
    nearViewport,
    name,
    category,
    item.lat,
    item.lng,
    item.city,
    item.placeId,
    item.wikidata,
    item.osmWikipedia,
    item.osmImage,
    key,
  ]);

  // One bounded recovery per place: report the dead URL to the server, which
  // re-resolves past that exact photo. claimDeadRetry keeps this from looping.
  const onImgError = useCallback(() => {
    const dead = immediate && !immediateDead ? immediate : shared;
    if (immediate && !immediateDead) setImmediateDead(true);
    if (!dead || !claimDeadRetry(key)) return;
    fetchPlaceImage(
      name,
      category,
      {
        lat: item.lat,
        lng: item.lng,
        city: item.city,
        id: item.placeId,
        wikidata: item.wikidata,
        wikipedia: item.osmWikipedia,
        imageTag: item.osmImage,
        surface: "explore",
      },
      { busted: dead }
    ).then((u) => publishPlaceImage(key, u && u !== dead ? u : null));
  }, [
    immediate,
    immediateDead,
    shared,
    key,
    name,
    category,
    item.lat,
    item.lng,
    item.city,
    item.placeId,
    item.wikidata,
    item.osmWikipedia,
    item.osmImage,
  ]);

  // Hover/focus warms the renditions the details hero will ask for, so the
  // window opens on an already-cached frame.
  const preload = useCallback(
    () => preloadDetailImage(immediate && !immediateDead ? immediate : shared),
    [immediate, immediateDead, shared]
  );

  return { src: immediate && !immediateDead ? immediate : shared, onImgError, preload } as const;
}

/** Memoized: grid hover/focus changes re-render only the two affected cards. */
function CardPhotoFallback({ kind }: { kind: ExploreItem["kind"] }) {
  return (
    <span
      aria-hidden
      className="absolute inset-0 grid place-items-center bg-[radial-gradient(120%_90%_at_50%_0%,rgba(255,255,255,0.10),transparent_62%)]"
    >
      <span className="grid h-14 w-14 place-items-center rounded-2xl border border-white/[0.09] bg-white/[0.05] text-white/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
        <CategoryIcon kind={kind} className="h-6 w-6" />
      </span>
    </span>
  );
}

const ExploreCard = memo(function ExploreCard({
  item,
  index,
  active,
  hovered,
  sizes,
  onActivate,
  onOpenDetails,
  onHover,
  cardRef,
}: {
  item: ExploreItem;
  index: number;
  active: boolean;
  hovered: boolean;
  /** Responsive slot width so next/image picks the right srcset entry. */
  sizes: string;
  onActivate: (id: string) => void;
  onOpenDetails: (id: string) => void;
  onHover: (id: string | null) => void;
  cardRef: (id: string, el: HTMLDivElement | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { src, onImgError, preload } = useCardImage(item, hostRef);
  /** Hover-intent timer: sweeping the pointer across the grid must not fire
   *  a detail-image preload (two /api/img requests) for every card it crosses. */
  const hoverTimer = useRef<number | null>(null);
  // A URL whose load failed. Kept per-src so the card falls back only while
  // that exact photo is on screen: the moment a re-resolution publishes a new
  // URL, `failedSrc !== src` and the frame tries again. Without this the
  // shimmer sat over a broken image forever whenever the bounded retry
  // declined (claimDeadRetry already spent) — a loading state that never ends.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const meta = recMeta(item.kind);
  const level = priceLevel(item.price);
  const priceLabel = item.price || level;
  const reviewCount = formatReviewCount(item.reviews);
  const dead = failedSrc !== null && failedSrc === src;
  const isOpen = (item.openState ?? "").toLowerCase().startsWith("open");
  // One reserved line for every card so rows never differ in height.
  const descText = item.desc || item.tag || "";

  const activate = () => onActivate(item.id);
  // Focus is deliberate (keyboard/click) — warm immediately. Hover waits for
  // the pointer to settle on the card so a fast sweep across the grid does
  // not start unused network work.
  const hoverIn = () => {
    onHover(item.id);
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      preload();
    }, 140);
  };
  const hoverOut = () => {
    onHover(null);
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  useEffect(
    () => () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    },
    []
  );

  const cta =
    item.kind === "destination"
      ? { label: "Plan this trip", glyph: "→", tone: "text-blue-400 group-hover:text-blue-300" }
      : { label: "View details", glyph: "→", tone: "text-zinc-300 group-hover:text-blue-300" };

  return (
    <div
      ref={(el) => {
        hostRef.current = el;
        cardRef(item.id, el);
      }}
      role="button"
      tabIndex={0}
      aria-label={`${item.name}. ${meta.label}${
        typeof item.rating === "number" ? ` rated ${item.rating.toFixed(1)} of 5` : ""
      }${reviewCount ? ` from ${item.reviews} reviews` : ""}${
        priceLabel ? ` ${priceLabel}` : ""
      }. Open details.`}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
      onMouseEnter={hoverIn}
      onFocus={preload}
      onMouseLeave={hoverOut}
      className={`group relative flex flex-col overflow-hidden rounded-xl border bg-zinc-900/80 cursor-pointer animate-card-in cv-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 transition-[transform,border-color,box-shadow] duration-200 ${
        active
          ? "border-accent/70 ring-2 ring-blue-500/30 shadow-lg shadow-blue-950/40"
          : hovered
            ? "border-blue-400/50 ring-1 ring-blue-400/25 shadow-xl shadow-black/50 lg:-translate-y-0.5"
            : "border-hairline hover:border-white/[0.18] shadow-lg shadow-black/30 lg:hover:-translate-y-0.5"
      }`}
      style={{ animationDelay: `${Math.min(index, 4) * 45}ms` }}
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        {src && !dead ? (
          /*
            One image pipeline for every card: /api/img (SmartImage) proxies,
            resizes to WebP and caches the bytes on disk with immutable
            headers. The old split sent the common hosts through next/image
            as well — a SECOND optimizer with its own cache, its own multi-
            width srcset and its own fetch of the original file, while the
            /api/img copy warmed for the very same photo went unused.
            The first row loads eagerly (it is on screen); everything below
            stays lazy and only resolves once it nears the viewport.
          */
          <SmartImage
            src={src}
            alt={item.name}
            onError={() => {
              setFailedSrc(src);
              onImgError();
            }}
            sizes={sizes}
            priority={index < 4}
            fallback={<CardPhotoFallback kind={item.kind} />}
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        ) : (
          <div className="relative w-full h-full bg-gradient-to-br from-zinc-800 via-zinc-900 to-black">
            <CardPhotoFallback kind={item.kind} />
          </div>
        )}

        <span
          className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/5 to-black/30"
          aria-hidden
        />

        <span className="absolute top-2 left-2 inline-flex items-center gap-2 px-2 py-1 rounded-md bg-black/60 border border-white/10 text-2xs font-medium text-ink">
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: meta.color }}
            aria-hidden
          />
          {item.tag ?? meta.label}
        </span>
        {typeof item.rating === "number" && (
          <span className="absolute top-2 right-2 inline-flex items-center gap-1 whitespace-nowrap px-2 py-1 rounded-md bg-black/65 border border-white/10 text-2xs font-semibold text-amber-300">
            <span aria-hidden>★</span>
            {item.rating.toFixed(1)}
            {reviewCount && (
              <span className="font-normal text-amber-200/70">({reviewCount})</span>
            )}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3">
        <h3 className="line-clamp-2 min-h-10 text-sm font-semibold leading-snug text-ink">{item.name}</h3>

        <p className="mt-1 h-[15px] truncate text-xs leading-tight text-ink-muted">{descText}</p>

        <div className="mt-2 flex h-6 items-center gap-x-2 overflow-hidden whitespace-nowrap text-2xs text-ink-faint">
          <span className="inline-flex min-w-0 items-center gap-2">
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: meta.color }}
              aria-hidden
            />
            <span className="truncate">
              {item.city ?? meta.label}
            </span>
          </span>
          {priceLabel && (
            <>
              <span aria-hidden className="shrink-0 text-zinc-700">
                ·
              </span>
              <span className="shrink-0 font-semibold text-ok">{priceLabel}</span>
            </>
          )}
          {item.openState && (
            <span
              className={`shrink-0 max-w-27.5 truncate rounded-full border px-2 py-1 text-2xs font-semibold leading-none ${
                isOpen
                  ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
                  : "border-white/10 bg-surface-2 text-ink-muted"
              }`}
            >
              {item.openState}
            </span>
          )}
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-white/[0.06] pt-3 text-sm font-medium">
          {item.kind === "destination" ? (
            <Link
              href="/plan"
              onClick={(e) => e.stopPropagation()}
              className={`inline-flex items-center gap-1 ${cta.tone} transition-colors`}
            >
              {cta.label}
              <span aria-hidden>{cta.glyph}</span>
            </Link>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetails(item.id);
              }}
              className={`inline-flex items-center gap-1 ${cta.tone} transition-colors`}
            >
              {cta.label}
              <span aria-hidden>{cta.glyph}</span>
            </button>
          )}

          <span className="flex shrink-0 items-center gap-2">
            <SavePlaceButton
              placeKey={savedPlaceKey(item.kind, item.name)}
              name={item.name}
              place={{
                type: item.kind,
                name: item.name,
                lat: item.lat,
                lng: item.lng,
                city: item.city,
                rating: item.rating,
                reviews: item.reviews,
                price: item.price,
                image: src ?? item.image,
              }}
            />
            <span aria-hidden className="text-zinc-600 transition-colors group-hover:text-blue-400">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </span>
          </span>
        </div>
      </div>
    </div>
  );
});

function SkeletonCard() {
  return (
    <div
      className="rounded-xl border border-hairline overflow-hidden bg-zinc-900/70"
      role="status"
      aria-label="Loading place"
    >
      <div className="aspect-[16/10] bg-zinc-800/70 animate-pulse" />
      <div className="p-3 space-y-2.5">
        <div className="h-4.5 w-2/3 rounded-md bg-zinc-800/70 animate-pulse" />
        <div className="h-[15px] w-full rounded-md bg-zinc-800/50 animate-pulse" />
        <div className="h-6 w-1/3 rounded-md bg-zinc-800/50 animate-pulse" />
        <div className="h-[25px] w-1/2 rounded-md bg-zinc-800/50 animate-pulse" />
      </div>
    </div>
  );
}

function EmptyState({
  title,
  desc,
  actionLabel,
  onAction,
}: {
  title: string;
  desc: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center text-center py-16 px-6 rounded-2xl border border-dashed border-white/[0.12] bg-white/[0.02]">
      <span
        className="grid h-12 w-12 place-items-center rounded-xl bg-surface-2 text-ink-muted"
        aria-hidden
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.8}
            d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
          />
        </svg>
      </span>
      <h3 className="mt-4 text-md font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-faint max-w-xs">{desc}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-6 px-6 py-3 rounded-xl bg-accent-strong text-white text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 transition-colors"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

interface CountryDestination {
  id: string;
  name: string;
  lat: number;
  lng: number;
  population?: number;
}

/** "1.3M residents" / "980k residents" — a scannable size hint, no fake data. */
function residentsLabel(population?: number): string | null {
  if (!population || population <= 0) return null;
  if (population >= 1_000_000) return `${(population / 1_000_000).toFixed(1)}M residents`;
  if (population >= 1_000) return `${Math.round(population / 1_000)}k residents`;
  return `${population} residents`;
}

/**
 * A country's destination city. Clicking it selects that city, which restores
 * the normal Explore tabs and starts a real city sweep — the country view is a
 * hop, never a dead end.
 */
function DestinationCard({
  place,
  countryName,
  index,
  sizes,
  onPick,
}: {
  place: CountryDestination;
  countryName: string;
  index: number;
  sizes: string;
  onPick: (place: CountryDestination) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const item = useMemo<ExploreItem>(
    () => ({
      id: `destination-${place.id}`,
      name: place.name,
      kind: "destination",
      lat: place.lat,
      lng: place.lng,
      city: place.name,
      imageQuery: place.name,
      // The Q-id lets the image resolver pick the city's exact photo instead
      // of guessing from a keyword — the difference between a skyline and a
      // stock photo of some other city with the same name.
      wikidata: place.id,
      desc: residentsLabel(place.population) ?? `A city in ${countryName}`,
    }),
    [place, countryName]
  );
  const { src, onImgError } = useCardImage(item, hostRef);
  const [dead, setDead] = useState<string | null>(null);
  const meta = recMeta("destination");

  return (
    <div
      ref={hostRef}
      role="button"
      tabIndex={0}
      aria-label={`Explore ${place.name}`}
      onClick={() => onPick(place)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(place);
        }
      }}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-hairline bg-zinc-900/80 cursor-pointer animate-card-in cv-card shadow-lg shadow-black/30 transition-[transform,border-color,box-shadow] duration-200 hover:border-blue-400/50 hover:shadow-xl hover:shadow-black/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 lg:hover:-translate-y-0.5"
      style={{ animationDelay: `${Math.min(index, 5) * 45}ms` }}
    >
      <div className="relative aspect-[4/3] overflow-hidden">
        {src && src !== dead ? (
          <SmartImage
            src={src}
            alt={place.name}
            onError={() => {
              setDead(src);
              onImgError();
            }}
            sizes={sizes}
            priority={index < 3}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.04]"
            fallback={
              <span className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900 text-zinc-600">
                <CategoryIcon kind="destination" className="h-10 w-10" />
              </span>
            }
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900 text-zinc-600">
            <CategoryIcon kind="destination" className="h-10 w-10" />
          </div>
        )}
        <span
          className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-black/10"
          aria-hidden
        />
        <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-black/60 px-2 py-1 text-2xs font-medium text-ink">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: meta.color }}
            aria-hidden
          />
          Destination
        </span>
        <div className="absolute inset-x-0 bottom-0 p-3">
          <h3 className="truncate text-md font-semibold text-white drop-shadow">{place.name}</h3>
          <p className="mt-0.5 truncate text-xs text-zinc-300">
            {residentsLabel(place.population) ?? countryName}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium">
        <span className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap text-blue-400 transition-colors group-hover:text-blue-300">
          <span className="truncate">Explore {place.name}</span>
          <span
            aria-hidden
            className="shrink-0 transition-transform duration-200 group-hover:translate-x-0.5"
          >
            →
          </span>
        </span>
      </div>
    </div>
  );
}

export default function ExploreView({
  heightClass = "h-[calc(100dvh-4rem)]",
  showBackground = true,
  initialLoc,
  initialMapOpen = false,
}: {
  heightClass?: string;
  showBackground?: boolean;
  /** Coordinates handed over by a Saved card, so the grid opens around it. */
  initialLoc?: ExploreLoc;
  initialMapOpen?: boolean;
}) {
  const [tab, setTab] = useState<ExploreTab>("for-you");
  const [loc, setLoc] = useState<ExploreLoc>(
    initialLoc ?? { name: "Paris, France", lat: 48.8566, lng: 2.3522 }
  );
  const [filter, setFilter] = useState("All");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [mapVisible, setMapVisible] = useState(initialMapOpen);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapPanelMounted, mapPanelClosing] = useExitTransition(mapOpen, 170);
  const [detailItem, setDetailItem] = useState<Recommendation | null>(null);
  const [recentLocs, setRecentLocs] = useState<ExploreLoc[]>([]);
  const [apiState, setApiState] = useState<ApiState | null>(null);
  /**
   * The last list that actually loaded, for the SAME tab and location. While
   * a refresh is in flight the grid keeps it instead of flashing skeletons.
   * Scoped by tab too: another category's cards must never be painted under
   * this tab's heading while it loads.
   */
  const [staleItems, setStaleItems] = useState<{ key: string; items: ExploreItem[] } | null>(
    null
  );
  const [isDesktop, setIsDesktop] = useState(false);
  /** Stays ordering: Popular = server "famous first" score order. */
  const [sort, setSort] = useState<"Popular" | "Rating" | "Nearest">("Popular");
  const [loadingMore, setLoadingMore] = useState(false);
  /** Incremental rendering — long result grids mount in scroll-sized chunks. */
  const [visibleCount, setVisibleCount] = useState(EXPLORE_PAGE);
  /** Free-text place search — once answered its results replace the tab's grid. */
  const [searchInput, setSearchInput] = useState("");
  const [searchResults, setSearchResults] = useState<ExploreItem[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTerm = searchInput.trim();
  const searchAnswered = searchResults !== null;
  /**
   * Country mode: the picked place is a country, not a city. The point sweep
   * is meaningless around a country centroid, so the grid shows the country's
   * destination cities and a click drills into one of them.
   */
  const countryMode =
    loc.country === true && typeof loc.countryCode === "string" && loc.countryCode.length === 2;
  const [countryState, setCountryState] = useState<{
    key: string;
    status: "loading" | "ready" | "error";
    places: CountryDestination[];
  } | null>(null);
  /** Retry token — bumping it re-runs the destination request. */
  const [countryAttempt, setCountryAttempt] = useState(0);
  const countryCacheRef = useRef(new Map<string, CountryDestination[]>());
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  /** The user's saves are the only personalisation signal Explore uses. */
  const savedPlaces = useSavedPlaces();
  const affinity = useMemo(() => savedAffinity(savedPlaces), [savedPlaces]);

  const cacheRef = useRef(new Map<string, ApiResult>());
  /** Per-tab request counters — a background refresh can never cancel an active fetch. */
  const seqByKeyRef = useRef(new Map<string, number>());
  const loadMoreSeqRef = useRef(false);
  const cardRefs = useRef(new Map<string, HTMLDivElement | null>());
  /**
   * Timers + attempt counters for the "the full city pool is still being
   * built" follow-up. The server answers with a fast first screen and keeps
   * working on the complete list; these re-ask for it (a server cache hit)
   * until it arrives.
   */
  const poolRefreshRef = useRef<{
    timers: Map<string, number>;
    attempts: Map<string, number>;
  }>({ timers: new Map(), attempts: new Map() });
  /** The loader the refresh timer re-enters (kept in a ref to avoid a cycle). */
  const loadApiRef = useRef<
    ((t: ExploreTab, l: ExploreLoc, force: boolean) => Promise<void>) | null
  >(null);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const raw = localStorage.getItem(RECENT_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            const valid = (parsed as ExploreLoc[]).filter(
              (p) =>
                p && typeof p.name === "string" && Number.isFinite(p.lat) && Number.isFinite(p.lng)
            );
            setRecentLocs(valid.slice(0, 6));
          }
        }
      } catch {
        // ignore corrupt storage
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Desktop gets the list/details split below; mobile keeps the full-screen sheet.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setIsDesktop(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const activeKey = `${tab}|${loc.name}|${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`;
  const apiMatch = apiState && apiState.key === activeKey ? apiState : null;
  /**
   * The key the UI is actually showing, readable from async callbacks. A
   * background pool refresh can finish after the user has switched tabs; it
   * must refresh the cache without changing what the grid paints — otherwise
   * an old tab's refresh set the whole panel back to "loading" and the grid
   * fell back to the previous category's cards.
   */
  const activeKeyRef = useRef(activeKey);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  /**
   * Re-ask for a pool the server is still building. The server answers with a
   * fast first screen and keeps working on the complete city list in the
   * background; this polls for the upgrade (a server-side cache hit, so it
   * costs almost nothing) until the wide pool lands.
   */
  const schedulePoolRefresh = useCallback((t: ExploreTab, l: ExploreLoc, key: string) => {
    if (typeof window === "undefined") return;
    const { timers, attempts } = poolRefreshRef.current;
    if (timers.has(key)) return;
    const attempt = attempts.get(key) ?? 0;
    if (attempt >= POOL_REFRESH_MAX) return;
    attempts.set(key, attempt + 1);
    // Gentle backoff: the wide pool usually lands within a few seconds.
    const delay = Math.min(POOL_REFRESH_BASE_MS * (attempt + 1), POOL_REFRESH_MAX_MS);
    const timer = window.setTimeout(() => {
      timers.delete(key);
      void loadApiRef.current?.(t, l, true);
    }, delay);
    timers.set(key, timer);
  }, []);

  const loadApi = useCallback(
    async (t: ExploreTab, l: ExploreLoc, force: boolean) => {
      if (!isApiTab(t)) return;
      const key = `${t}|${l.name}|${l.lat.toFixed(4)},${l.lng.toFixed(4)}`;
      /** Only the visibly active tab may change what the grid paints. */
      const isActive = () => key === activeKeyRef.current;
      if (!force) {
        const hit = cacheRef.current.get(key);
        if (hit) {
          if (isActive()) {
            setApiState({
              key,
              items: hit.items,
              total: hit.total,
              hasMore: hit.hasMore,
              pending: hit.pending,
              status: "ready",
            });
          }
          if (hit.pending) schedulePoolRefresh(t, l, key);
          return;
        }
      }
      // One counter per key: a background refresh for another tab must not
      // invalidate this tab's in-flight request.
      const seq = (seqByKeyRef.current.get(key) ?? 0) + 1;
      seqByKeyRef.current.set(key, seq);
      // A forced refresh (the server's fast screen is being upgraded) must not
      // blank the grid: keep the ready list painted while the next page lands.
      if (isActive()) {
        if (!force) setApiState({ key, items: [], status: "loading" });
        else
          setApiState((prev) =>
            prev && prev.key === key && prev.status === "ready"
              ? prev
              : { key, items: [], status: "loading" }
          );
      }
      try {
        const result = await fetchTabItems(t, l, 0);
        cacheRef.current.set(key, result);
        if (isActive() && seqByKeyRef.current.get(key) === seq) {
          // Remember it as the fallback the grid paints while this same tab
          // re-loads. Scoped by tab+location: another category's cards must
          // never appear under this tab's heading while it fetches.
          setStaleItems({ key, items: result.items });
          setApiState({ key, ...result, status: "ready" });
        }
        // The server answered with its fast first screen and is still building
        // the full city pool behind it — ask again shortly to pick it up.
        if (result.pending) schedulePoolRefresh(t, l, key);
      } catch {
        cacheRef.current.delete(key);
        if (isActive() && seqByKeyRef.current.get(key) === seq) {
          setApiState({ key, items: [], status: "error" });
        }
      }
    },
    [schedulePoolRefresh]
  );

  // The refresh timer re-enters the loader; a ref keeps the two independent.
  useEffect(() => {
    loadApiRef.current = loadApi;
  }, [loadApi]);

  // "Load more": 20 more places from the server-side ranked pool per call —
  // the API never ships the whole city, just the next page.
  const loadMoreApi = useCallback(async () => {
    if (!isApiTab(tab) || loadMoreSeqRef.current) return;
    const current = apiState && apiState.key === activeKey ? apiState : null;
    if (!current || current.status !== "ready" || !current.hasMore) return;
    loadMoreSeqRef.current = true;
    setLoadingMore(true);
    const seq = seqByKeyRef.current.get(activeKey) ?? 0;
    try {
      const result = await fetchTabItems(tab, loc, current.items.length);
      if (seqByKeyRef.current.get(activeKey) === seq) {
        setApiState((prev) => {
          if (!prev || prev.key !== activeKey) return prev;
          const seen = new Set(prev.items.map((i) => i.id));
          const merged: ApiResult = {
            items: [...prev.items, ...result.items.filter((i) => !seen.has(i.id))],
            total: result.total ?? prev.total,
            hasMore: result.hasMore,
          };
          cacheRef.current.set(prev.key, merged);
          return { ...prev, ...merged };
        });
      }
    } catch {
      // Keep the current list; the sentinel retries on the next scroll.
    } finally {
      loadMoreSeqRef.current = false;
      setLoadingMore(false);
    }
  }, [tab, loc, apiState, activeKey]);

  const clearSearch = useCallback(() => {
    setSearchInput("");
    setSearchResults(null);
    setSearchLoading(false);
  }, []);

  const handleTab = (t: ExploreTab) => {
    setTab(t);
    setFilter("All");
    setFocusId(null);
    setSort("Popular");
    // A tab click should show that tab — so it also exits search mode.
    clearSearch();
  };

  const handleLoc = useCallback((l: ExploreLoc) => {
    setLoc(l);
    setFilter("All");
    setFocusId(null);
    setSort("Popular");
    // Search results belong to the old location — carrying them into a new
    // city showed places from the wrong place until the next search.
    clearSearch();
    setVisibleCount(EXPLORE_PAGE);
    if (!l.current) {
      setRecentLocs((prev) => {
        const next = [l, ...prev.filter((r) => r.name !== l.name)].slice(0, 6);
        try {
          localStorage.setItem(RECENT_KEY, JSON.stringify(next));
        } catch {
          // ignore quota errors
        }
        return next;
      });
    }
  }, [clearSearch]);

  /**
   * Rescue a location that lost its country identity.
   *
   * Only the location picker knows a suggestion is a country; a "Recent" entry
   * saved before that field existed (or an Explore link built from a name and
   * coordinates) arrives without it. A country's centre is not a city, so the
   * point sweep around it finds nothing and the grid answers "No results
   * found" — with a "Try again" that repeats the same hopeless sweep.
   * Geocode the name once and, when the coordinates really are a country's own
   * centre, re-attach the code so the destination list takes over.
   */
  useEffect(() => {
    if (loc.country || loc.countryCode) return;
    const key = `${loc.name}|${loc.lat.toFixed(3)},${loc.lng.toFixed(3)}`;
    let probe = countryProbes.get(key);
    if (!probe) {
      probe = geocodePlace(loc.name)
        .then((suggestions) => countryCodeForPlace(loc, suggestions))
        // Geocoder unreachable: the normal city path stays as it was.
        .catch(() => null);
      countryProbes.set(key, probe);
    }
    let alive = true;
    void probe.then((code) => {
      if (alive && code) handleLoc({ ...loc, country: true, countryCode: code });
    });
    return () => {
      alive = false;
    };
  }, [loc, handleLoc]);

  // Load whenever the tab or location changes (including the first mount).
  // Country mode has no tabs to load — its own effect fetches destinations.
  useEffect(() => {
    if (isApiTab(tab) && !countryMode) loadApi(tab, loc, false);
  }, [tab, loc, loadApi, countryMode]);

  // Country destinations: one request per country (browser + server cache it),
  // setState only from timers/promises so a stale response can never land.
  useEffect(() => {
    if (!countryMode || !loc.countryCode) return;
    const code = loc.countryCode;
    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const cached = countryCacheRef.current.get(code);
      if (cached) {
        setCountryState({ key: code, status: "ready", places: cached });
        return;
      }
      setCountryState({ key: code, status: "loading", places: [] });
      fetch("/api/places/country", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, limit: 24 }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]),
      })
        .then((res) => {
          if (!res.ok) throw new Error("destinations failed");
          return res.json() as Promise<{ places?: CountryDestination[] }>;
        })
        .then((data) => {
          if (!alive) return;
          const places = (Array.isArray(data.places) ? data.places : []).filter(
            (p) =>
              p &&
              typeof p.name === "string" &&
              p.name.length > 0 &&
              Number.isFinite(p.lat) &&
              Number.isFinite(p.lng)
          );
          countryCacheRef.current.set(code, places);
          setCountryState({ key: code, status: "ready", places });
        })
        .catch(() => {
          if (alive) setCountryState({ key: code, status: "error", places: [] });
        });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [countryMode, loc.countryCode, countryAttempt]);

  /**
   * Warm the SIBLING tabs in the background. Each category is its own city
   * sweep on the server, so the first click on "Restaurants" used to wait for
   * a fresh sweep of tens of seconds. Fetching them while the user reads the
   * first tab means every switch afterwards is served from the client cache —
   * no request, no skeletons, no waiting.
   *
   * One at a time, and only once the visible tab has actually painted: the
   * warm-ups share the same Overpass mirrors, so starting them beside the
   * active sweep is what turned the first screen into a queue. Waiting for
   * `ready` also means a click-through to a sibling is a cache hit by then.
   */
  const activeReady = isApiTab(tab) && apiMatch?.status === "ready";
  useEffect(() => {
    // Country mode has no sibling tabs to warm — its grid is a destination list.
    if (!activeReady || countryMode) return;
    let alive = true;
    const siblings = TABS.map((t) => t.id).filter(
      (id) => isApiTab(id) && id !== tab
    ) as ExploreTab[];
    if (siblings.length === 0) return;
    const run = async () => {
      const queue = siblings.slice();
      const workers = Array.from(
        { length: Math.min(PREWARM_CONCURRENCY, queue.length) },
        async () => {
          for (;;) {
            const id = queue.shift();
            if (!id || !alive) return;
            const key = `${id}|${loc.name}|${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`;
            if (cacheRef.current.has(key)) continue;
            try {
              const result = await fetchTabItems(id, loc, 0);
              if (!alive) return;
              cacheRef.current.set(key, result);
            } catch {
              // A failed warm-up is not fatal — the tab still loads on click.
            }
            // Breathing room between sweeps: the mirrors are a shared resource.
            await new Promise((r) => setTimeout(r, 900));
          }
        }
      );
      await Promise.all(workers);
    };
    void run();
    return () => {
      alive = false;
    };
  }, [tab, loc, activeReady, countryMode]);

  // Free-text place search: debounced, around the current location, capped at
  // the endpoint's 12 results. setState only runs inside the timeout callback
  // (react-hooks/set-state-in-effect) and a stale response never lands.
  // In country mode the same input filters the destination list locally.
  useEffect(() => {
    const term = searchTerm;
    let alive = true;
    const controller = new AbortController();
    const t = setTimeout(() => {
      if (countryMode) {
        setSearchLoading(false);
        return;
      }
      if (term.length < 2) {
        setSearchResults(null);
        setSearchLoading(false);
        return;
      }
      setSearchLoading(true);
      const city = cityFromLoc(loc);
      void fetch("/api/places/nearby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: loc.lat, lng: loc.lng, q: term, count: 12 }),
        // A dead mirror must not leave "Searching…" spinning forever; the
        // abort also cancels the previous keystroke's request.
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      })
        .then((res) => {
          if (!res.ok) throw new Error("search failed");
          return res.json() as Promise<{ places?: NearbyPlaceLite[] }>;
        })
        .then((data) => {
          if (!alive) return;
          const places = Array.isArray(data.places) ? data.places : [];
          setSearchResults(toNearbyItems(places, searchKindFor, city));
        })
        .catch(() => {
          if (alive) setSearchResults([]);
        })
        .finally(() => {
          if (alive) setSearchLoading(false);
        });
    }, 250);
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(t);
    };
  }, [searchTerm, loc, countryMode]);

  const clearRecents = () => {
    setRecentLocs([]);
    try {
      localStorage.removeItem(RECENT_KEY);
    } catch {
      // ignore
    }
  };

  const apiStatus = apiMatch ? apiMatch.status : "loading";
  const apiLoading = !countryMode && isApiTab(tab) && apiStatus === "loading";
  const apiError = !countryMode && isApiTab(tab) && apiStatus === "error";

  /** Destination list for the selected country (empty outside country mode). */
  const countryMatch = countryState && countryState.key === loc.countryCode ? countryState : null;
  const countryPlaces = useMemo<CountryDestination[]>(
    () => (countryMode && countryMatch?.status === "ready" ? countryMatch.places : []),
    [countryMode, countryMatch]
  );
  const countryLoading = countryMode && (!countryMatch || countryMatch.status === "loading");
  const countryError = countryMode && countryMatch?.status === "error";
  /** The country search box filters destinations by name, locally. */
  const countryFiltered = useMemo(() => {
    const q = searchTerm.toLowerCase();
    if (!q) return countryPlaces;
    return countryPlaces.filter((p) => p.name.toLowerCase().includes(q));
  }, [countryPlaces, searchTerm]);

  /**
   * The items the grid paints. While the current tab is still fetching, the
   * last list that loaded (same location) stays on screen — switching a tab
   * must not throw the whole grid away to skeletons. The banner above the
   * grid says what is on its way.
   */
  const baseItems = useMemo<ExploreItem[]>(() => {
    if (countryMode) return [];
    if (tab === "guides") return guideItemsFor(loc);
    if (isApiTab(tab) && apiMatch && apiMatch.status === "ready") return apiMatch.items;
    if (staleItems && staleItems.key === activeKey) return staleItems.items;
    return [];
  }, [tab, loc, apiMatch, staleItems, countryMode, activeKey]);
  /** The grid is painting the previous list while this tab loads. */
  const showingStale =
    !countryMode &&
    isApiTab(tab) &&
    apiLoading &&
    !(apiMatch && apiMatch.status === "ready") &&
    baseItems.length > 0;

  // Only offer filters the current results can actually satisfy.
  const filters = useMemo(() => {
    if (tab === "guides") return ["All"];
    if (!isApiTab(tab)) return CURATED_FILTERS;
    const pool = baseItems;
    const next = ["All"];
    if (pool.some((i) => (i.rating ?? 0) > 0)) next.push("Top rated");
    if (tab === "stays" && pool.some((i) => (i.stars ?? 0) >= 4)) next.push("★ 4+");
    if (pool.some((i) => (i.openState ?? "").toLowerCase().startsWith("open")))
      next.push("Open now");
    for (const lvl of ["$", "$$", "$$$"] as const) {
      if (pool.some((i) => priceLevel(i.price) === lvl)) next.push(lvl);
    }
    return next;
  }, [tab, baseItems]);

  // Stays ordering — "Popular" is the server's famous-first score order.
  // "For You" additionally lifts categories/cities the user saved — an
  // explicit signal, never a hidden inference.
  const sortedItems = useMemo(() => {
    if (tab === "stays") {
      if (sort === "Popular") return baseItems;
      const arr = [...baseItems];
      if (sort === "Rating") {
        arr.sort((a, b) => (b.rating ?? b.stars ?? 0) - (a.rating ?? a.stars ?? 0));
      } else {
        arr.sort(
          (a, b) =>
            (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY)
        );
      }
      return arr;
    }
    if (tab === "for-you") return rankByAffinity(baseItems, affinity);
    return baseItems;
  }, [baseItems, tab, sort, affinity]);

  const shown = useMemo(
    // An answered search replaces the tab pool — and its filters entirely.
    () => searchResults ?? sortedItems.filter((i) => matchesFilter(i, filter)),
    [searchResults, sortedItems, filter]
  );

  const loadedCount = apiMatch?.items.length ?? 0;
  const apiTotal = apiMatch?.total ?? 0;
  const apiHasMore = apiMatch?.hasMore ?? false;
  /** The server is still building the full city pool behind the first screen. */
  const apiPending = apiMatch?.pending === true;
  const countLabel = useMemo(() => {
    if (countryMode) {
      const n = countryFiltered.length;
      return `${n} ${n === 1 ? "destination" : "destinations"} in ${loc.name}`;
    }
    if (searchResults) {
      const n = searchResults.length;
      const short = searchTerm.length > 24 ? `${searchTerm.slice(0, 24)}…` : searchTerm;
      return `${n} ${n === 1 ? "result" : "results"} for "${short}"`;
    }
    if (isApiTab(tab) && filter === "All" && apiTotal > loadedCount) {
      const noun =
        tab === "stays"
          ? "stays"
          : tab === "restaurants"
            ? "places to eat"
            : tab === "experiences"
              ? "things to do"
              : "places";
      return `Showing ${loadedCount.toLocaleString()} of ${apiTotal.toLocaleString()} ${noun} in ${cityFromLoc(loc)}`;
    }
    if (isApiTab(tab) && apiPending) {
      // The full list is still being assembled — say so instead of implying
      // that what is on screen is all there is.
      return `${shown.length} ${shown.length === 1 ? "place" : "places"} in ${cityFromLoc(loc)} · loading the full list…`;
    }
    return `${shown.length} ${shown.length === 1 ? "place" : "places"}`;
  }, [
    searchResults,
    searchTerm,
    tab,
    filter,
    apiTotal,
    loadedCount,
    apiPending,
    shown.length,
    loc,
    countryMode,
    countryFiltered.length,
  ]);

  // The DOM only mounts the first `visibleCount` cards; a sentinel at the end
  // of the grid grows the window as you scroll (24 at a time) and asks the
  // server for the next page (20 more) once the loaded window is exhausted.
  // The map still carries every loaded pin.
  const visible = useMemo(() => shown.slice(0, visibleCount), [shown, visibleCount]);

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const canGrow = shown.length > visibleCount;
    // A search's ≤12 results are the whole answer — never page the tab behind them.
    if (!canGrow && (searchAnswered || !apiHasMore)) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (shown.length > visibleCount) {
          setVisibleCount((c) => Math.min(c + EXPLORE_PAGE, shown.length));
        } else if (!searchAnswered) {
          void loadMoreApi();
        }
      },
      { rootMargin: "800px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, visibleCount, apiHasMore, loadMoreApi, searchAnswered]);

  // Auto-fill keeps cards at ≥220px however the row is shared — with the map,
  // with the detail panel, or full width — so nothing ever gets squeezed.
  const gridCls = "grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3";
  // Slot width per breakpoint. The grid's `minmax(220px, 1fr)` auto-fill
  // settles around 225–280 px on desktop, so `24vw` used to overstate the
  // slot on wide screens and made the browser download a rendition twice the
  // needed size for every card.
  const cardSizes = "(max-width: 479px) 92vw, (max-width: 1023px) 46vw, 240px";

  const markers = useMemo<MapMarkerData[]>(
    () =>
      countryMode
        ? []
        : shown
            .filter((i) => !i.id.startsWith("guide-"))
            .map((i) => ({
              id: i.id,
              lat: i.lat,
              lng: i.lng,
              label: i.name,
              kind: i.kind,
              description: i.desc,
              image: i.image,
              rating: i.rating,
              reviews: i.reviews,
              price: i.price,
              link: i.link,
            })),
    [shown, countryMode]
  );

  const legend = useMemo(
    () =>
      Array.from(
        markers.reduce(
          (m, i) => m.set(i.kind, (m.get(i.kind) ?? 0) + 1),
          new Map<RecType, number>()
        )
      ).map(([kind, count]) => ({ ...recMeta(kind), kind, count })),
    [markers]
  );

  const openDetailById = useCallback(
    (id: string) => {
      const item = shown.find((i) => i.id === id);
      if (!item) return;
      setFocusId(id);
      setMapOpen(false);
      // Reuse the exact URL the card is already painting (shared store first,
      // record image second) — the details hero never re-looks-up.
      const resolvedKey = placePhotoKey(
        categoryForType(item.kind),
        item.imageQuery ?? item.name,
        item.city ?? ""
      );
      setDetailItem({
        id: item.id,
        name: item.name,
        type: item.kind,
        lat: item.lat,
        lng: item.lng,
        description: item.desc,
        rating: item.rating,
        price: item.price,
        image: peekPlaceImage(resolvedKey) ?? item.image,
        link: item.link,
        // The city is already known — the photo lookup must not spend a
        // second reverse-geocoding the coordinates to learn it.
        city: item.city,
      });
    },
    [shown]
  );

  const markerFocus = useCallback((id: string) => {
    setFocusId(id);
    const el = cardRefs.current.get(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  // Cards open their details right away: on desktop the list slides to the left
  // and the sheet takes the right-hand pane; below lg it stays a full-screen sheet.
  const handleCardActivate = useCallback(
    (id: string) => {
      openDetailById(id);
    },
    [openDetailById]
  );

  const splitDetail = detailItem !== null && isDesktop;

  const cardRef = useCallback((id: string, el: HTMLDivElement | null) => {
    cardRefs.current.set(id, el);
  }, []);

  return (
    <div
      className={`${heightClass} relative flex flex-col lg:flex-row overflow-hidden animate-view-in`}
    >
      {showBackground && <BlackBackground />}
      <div
        className={`flex-1 min-h-0 min-w-0 flex flex-col transition-[width,flex] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          splitDetail
            ? "lg:flex-1 lg:border-r lg:border-zinc-800/70"
            : mapVisible
              ? "lg:w-1/2 lg:flex-none lg:border-r lg:border-zinc-800/70"
              : "lg:w-full lg:flex-none"
        }`}
      >
        <div className="shrink-0 px-6 pt-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="eyebrow">Discover</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">Explore</h1>
              <p className="text-sm text-ink-muted mt-1">
                Places to see, eat and stay — tap a card to see it on the map
              </p>
            </div>
            <LocationMenu
              value={loc}
              recents={recentLocs}
              onSelect={handleLoc}
              onClearRecents={clearRecents}
            />
          </div>

          {/* Free-text place search — its answers replace the grid below. */}
          <div className="relative mt-4 max-w-3xl">
            <svg
              className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
              />
            </svg>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={
                countryMode ? `Search cities in ${loc.name}` : `Search places in ${cityFromLoc(loc)}`
              }
              aria-label="Search places"
              className="w-full rounded-xl bg-zinc-800 border border-zinc-700 pl-8 pr-8 py-3 text-sm text-ink placeholder-zinc-500 outline-none focus:border-accent/50 focus:ring-4 focus:ring-blue-500/15"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
              {searchLoading && searchTerm.length >= 2 ? (
                <span
                  className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"
                  aria-hidden
                />
              ) : searchInput ? (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label="Clear search"
                  className="grid h-6 w-6 place-items-center rounded-full text-ink-faint hover:bg-surface-3 hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M18 6 6 18M6 6l12 12"
                    />
                  </svg>
                </button>
              ) : null}
            </div>
          </div>

          {!countryMode && (
            <div
              role="tablist"
              aria-label="Explore categories"
              className={`mt-4 flex gap-5 border-b border-white/[0.07] ${SCROLL_X}`}
            >
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => handleTab(t.id)}
                  className="relative shrink-0 rounded-t-md px-2 pb-3 pt-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 aria-selected:text-ink"
                >
                  {t.label}
                  <span
                    aria-hidden
                    className={`absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent-strong transition-opacity ${
                      tab === t.id ? "opacity-100" : "opacity-0"
                    }`}
                  />
                </button>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center gap-3 pb-3">
            <div className={`flex gap-2 min-w-0 flex-1 ${SCROLL_X}`}>
              {!searchAnswered &&
                !countryMode &&
                filters.map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                    className={`shrink-0 min-h-touch px-4 py-2 rounded-full text-sm font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
                      filter === f
                        ? "bg-accent/15 border-blue-400/40 text-blue-200"
                        : "border-hairline text-ink-muted hover:border-white/20 hover:text-zinc-200 active:bg-surface-2"
                    }`}
                  >
                    {f}
                  </button>
                ))}
            </div>
            {filter !== "All" && !searchAnswered && !apiLoading && !apiError && (
              <button
                type="button"
                onClick={() => setFilter("All")}
                className="shrink-0 text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors"
              >
                Clear
              </button>
            )}
            {tab === "stays" && !searchAnswered && !apiLoading && !apiError && !countryMode && (
              <div
                role="group"
                aria-label="Sort stays"
                className="shrink-0 flex items-center gap-1 rounded-full border border-hairline p-1"
              >
                {(["Popular", "Rating", "Nearest"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={sort === s}
                    onClick={() => setSort(s)}
                    className={`px-3 py-2 rounded-full text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
                      sort === s ? "bg-accent text-white" : "text-ink-muted hover:text-ink"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {(countryMode || searchAnswered || shown.length > 0 || (!apiLoading && !apiError)) && (
              <span
                aria-live="polite"
                className="shrink-0 text-xs font-medium text-ink-faint tabular-nums"
              >
                {countLabel}
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto dark-scroll px-6 pt-4 pb-8 border-t border-white/[0.05]">
          {/* The card titles are h3s, so the results need an h2 between the
              page h1 and the grid to keep the outline valid. */}
          <h2 className="sr-only">
            {countryMode ? `Destinations in ${loc.name}` : `Places in ${cityFromLoc(loc)}`}
          </h2>
          {/*
            The grid keeps the previous list on screen while the next tab
            loads, with a banner that says so — a tab switch must not throw
            the whole grid away to skeletons.
          */}
          {showingStale && (
            <p role="status" className="mb-3 flex items-center gap-2 text-xs text-ink-faint">
              <span
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent"
                aria-hidden
              />
              Loading {TABS.find((t) => t.id === tab)?.label ?? "places"}…
            </p>
          )}
          {tab === "for-you" && !searchAnswered && affinity.total > 0 && (
            <p className="mb-3 flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
              <span>
                Tuned to the {affinity.total} {affinity.total === 1 ? "place" : "places"} you saved.
              </span>
              <Link
                href="/saved"
                className="font-semibold text-blue-400 transition-colors hover:text-blue-300"
              >
                View saved →
              </Link>
            </p>
          )}
          {/*
            Skeletons only while there is genuinely NOTHING to show. The
            server answers with a fast first screen long before the full city
            pool is ready, so the grid fills in while the rest is still
            building — instead of six skeletons standing in for 30 seconds.
          */}
          {countryMode ? (
            countryLoading ? (
              <div className={gridCls}>
                {Array.from({ length: 6 }, (_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            ) : countryError ? (
              <div className={gridCls}>
                <EmptyState
                  title="Could not load destinations"
                  desc={`The city list for ${loc.name} is unavailable right now. Your other Explore searches still work.`}
                  actionLabel="Try again"
                  onAction={() => {
                    if (loc.countryCode) countryCacheRef.current.delete(loc.countryCode);
                    setCountryAttempt((n) => n + 1);
                  }}
                />
              </div>
            ) : countryFiltered.length === 0 ? (
              <div className={gridCls}>
                <EmptyState
                  title={searchTerm ? "No matching cities" : "No destinations found"}
                  desc={
                    searchTerm
                      ? `No city in ${loc.name} matches "${searchTerm}".`
                      : `We could not find city destinations for ${loc.name} right now.`
                  }
                  actionLabel={searchTerm ? "Clear search" : "Try again"}
                  onAction={() => {
                    if (searchTerm) {
                      clearSearch();
                    } else {
                      if (loc.countryCode) countryCacheRef.current.delete(loc.countryCode);
                      setCountryAttempt((n) => n + 1);
                    }
                  }}
                />
              </div>
            ) : (
              <div className={gridCls}>
                <div className="col-span-full mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-white/[0.08] bg-surface-1/60 px-4 py-3">
                  <span className="text-sm font-medium text-ink">
                    {loc.name} · {countryFiltered.length}{" "}
                    {countryFiltered.length === 1 ? "destination" : "destinations"}
                  </span>
                  <span className="text-xs text-ink-faint">
                    Pick a city to see its places, food and stays.
                  </span>
                </div>
                {countryFiltered.map((place, i) => (
                  <DestinationCard
                    key={place.id}
                    place={place}
                    countryName={loc.name}
                    index={i}
                    sizes={cardSizes}
                    onPick={(p) =>
                      handleLoc({ name: `${p.name}, ${loc.name}`, lat: p.lat, lng: p.lng })
                    }
                  />
                ))}
              </div>
            )
          ) : apiLoading && !searchAnswered && shown.length === 0 ? (
            <div className={gridCls}>
              {Array.from({ length: 6 }, (_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          ) : apiError && !searchAnswered ? (
            <div className={gridCls}>
              <EmptyState
                title="Could not load places"
                desc="Something went wrong while fetching results for this area."
                actionLabel="Try again"
                onAction={() => loadApi(tab, loc, true)}
              />
            </div>
          ) : shown.length === 0 ? (
            <div className={gridCls}>
              {searchAnswered ? (
                <EmptyState
                  title="No results"
                  desc={`Nothing matches "${searchTerm}" around ${loc.name}.`}
                  actionLabel="Clear search"
                  onAction={clearSearch}
                />
              ) : filter !== "All" ? (
                <EmptyState
                  title="No matches"
                  desc="No places match the current filters."
                  actionLabel="Clear filters"
                  onAction={() => setFilter("All")}
                />
              ) : (
                <EmptyState
                  title="No results found"
                  desc={`Nothing found around ${loc.name} right now.`}
                  actionLabel={isApiTab(tab) ? "Try again" : undefined}
                  onAction={isApiTab(tab) ? () => loadApi(tab, loc, true) : undefined}
                />
              )}
            </div>
          ) : (
            <div className={gridCls}>
              {visible.map((item, i) => (
                <ExploreCard
                  key={`${activeKey}:${item.id}`}
                  item={item}
                  index={i}
                  active={focusId === item.id}
                  hovered={hoverId === item.id}
                  sizes={cardSizes}
                  onActivate={handleCardActivate}
                  onOpenDetails={openDetailById}
                  onHover={setHoverId}
                  cardRef={cardRef}
                />
              ))}
              {(shown.length > visibleCount || (!searchAnswered && apiHasMore)) && (
                <div
                  ref={loadMoreRef}
                  role="status"
                  aria-busy={loadingMore}
                  aria-label="Loading more places"
                  className="col-span-full grid place-items-center py-6"
                >
                  <span
                    className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent"
                    aria-hidden
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {mapVisible && !splitDetail && !countryMode && (
        <div className="hidden lg:flex relative z-0 isolate overflow-hidden flex-1 min-w-0 animate-fade-in">
          <MapView
            markers={markers}
            focusId={focusId}
            onFocus={markerFocus}
            hoverId={hoverId}
            onHoverChange={setHoverId}
            onOpenDetails={openDetailById}
            showWeather
            city={loc.name}
          />
          <div className="absolute top-4 left-4 z-[1200] max-w-[calc(100%-8rem)] rounded-2xl border border-white/[0.1] bg-zinc-950/90 shadow-xl shadow-black/40 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-strong/15 text-blue-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17.657 16.657L13.414 20.9a2 2 0 01-2.828 0l-4.243-4.243a8 8 0 1111.315 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink truncate leading-tight">{loc.name}</p>
                <p className="text-xs text-ink-muted mt-1" aria-live="polite">
                  {markers.length} {markers.length === 1 ? "place" : "places"} on the map
                </p>
              </div>
            </div>
            {legend.length > 0 && (
              <div className="mt-3 pt-3 border-t border-hairline flex flex-wrap gap-x-3 gap-y-2">
                {legend.map((l) => (
                  <span
                    key={l.kind}
                    className="inline-flex items-center gap-2 text-2xs text-ink-muted"
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: l.color }}
                      aria-hidden
                    />
                    {l.label}
                    <span className="text-zinc-600 tabular-nums">{l.count}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setMapVisible(false)}
            className="absolute top-4 right-4 z-[1200] flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-950/90 border border-white/[0.1] shadow-lg shadow-black/40 text-sm font-medium text-zinc-300 hover:text-white hover:bg-zinc-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
            Hide map
          </button>
        </div>
      )}

      {!mapVisible && !splitDetail && !countryMode && (
        <button
          type="button"
          onClick={() => setMapVisible(true)}
          className="hidden lg:flex fixed bottom-6 right-6 z-40 items-center gap-3 pl-4 pr-3 py-3 rounded-full bg-accent-strong text-white text-sm font-semibold shadow-xl shadow-black/50 hover:bg-accent active:scale-95 transition-all"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
            />
          </svg>
          Show map
          <span className="inline-flex min-w-5 justify-center rounded-full bg-white/15 px-2 py-1 text-2xs font-bold tabular-nums">
            {markers.length}
          </span>
        </button>
      )}

      <button
        type="button"
        onClick={() => setMapOpen(true)}
        className={`lg:hidden fixed bottom-6 right-4 z-40 flex items-center gap-3 pl-4 pr-3 py-3 rounded-full bg-accent-strong text-white text-sm font-semibold shadow-xl shadow-black/50 hover:bg-accent active:scale-95 transition-all ${
          countryMode ? "hidden" : ""
        }`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
          />
        </svg>
        Open map
        <span className="inline-flex min-w-5 justify-center rounded-full bg-white/15 px-2 py-1 text-2xs font-bold tabular-nums">
          {markers.length}
        </span>
      </button>

      {mapPanelMounted && !countryMode && (
        <div
          className={`lg:hidden fixed inset-0 z-[60] bg-zinc-950 ${
            mapPanelClosing ? "animate-exit pointer-events-none" : "animate-fade-in"
          }`}
        >
          <MapView
            markers={markers}
            focusId={focusId}
            onFocus={markerFocus}
            hoverId={hoverId}
            onHoverChange={setHoverId}
            onOpenDetails={openDetailById}
            showWeather
            city={loc.name}
          />
          <button
            type="button"
            onClick={() => setMapOpen(false)}
            className="absolute top-4 left-4 z-[1200] flex items-center gap-2 px-4 py-3 rounded-xl bg-zinc-950/95 border border-white/[0.1] shadow-lg shadow-black/40 text-ink text-sm font-medium hover:bg-zinc-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            Show list
          </button>
          <div className="absolute top-4 right-4 z-[1200] flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-950/95 border border-white/[0.1] shadow-lg shadow-black/40 text-xs text-zinc-200 max-w-[55%]">
            <svg
              className="w-3.5 h-3.5 text-blue-400 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17.657 16.657L13.414 20.9a2 2 0 01-2.828 0l-4.243-4.243a8 8 0 1111.315 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            <span className="truncate">{loc.name}</span>
            <span className="text-ink-faint shrink-0">· {markers.length}</span>
          </div>
        </div>
      )}

      {splitDetail && detailItem && (
        <div className="hidden lg:flex relative shrink-0 lg:w-1/2">
          <HotelDetailSheet
            key={detailItem.id}
            place={detailItem}
            onClose={() => setDetailItem(null)}
            mode="panel"
          />
        </div>
      )}

      {detailItem && !splitDetail && (
        <PlaceDetailModal place={detailItem} onClose={() => setDetailItem(null)} />
      )}
    </div>
  );
}
