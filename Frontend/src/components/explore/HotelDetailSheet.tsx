"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { coerceType, recMeta, type Recommendation } from "@/lib/recommendations";
import { externalWebsiteHref } from "@/lib/links";
import { savedPlaceKey } from "@/lib/savedPlaces";
import { photoSourceName } from "@/lib/photoCredit";
import { fetchPlaceGallery } from "@/lib/placeGallery";
import {
  categoryForType,
  fetchPlaceImage,
  peekPlaceImage,
  placePhotoKey,
  usePlaceImageSync,
} from "@/lib/placeImages";
import { useInView } from "@/lib/useInView";
import type { NearbyPlace } from "@/lib/nearbyPlaces";
import CategoryIcon from "@/components/ui/CategoryIcon";
import SmartImage from "@/components/ui/SmartImage";
import StarRating from "@/components/ui/StarRating";
import VisitDurationEditor from "@/components/trip/VisitDurationEditor";
import AddToTripButton from "@/components/ui/AddToTripButton";
import SavePlaceButton from "@/components/ui/SavePlaceButton";
import { useExitTransition } from "@/lib/useExitTransition";

const PlaceMiniMap = dynamic(() => import("@/components/map/PlaceMiniMap"), {
  ssr: false,
  loading: () => <div className="h-48 w-full animate-pulse rounded-2xl bg-surface-2" />,
});
import {
  ChevronIcon,
  ExternalIcon,
  GridIcon,
  Lightbox,
  PhotoGallery,
  PhotoLayers,
  XIcon,
  usePhotoLayers,
  type PlacePhoto,
} from "@/components/explore/PlaceGallery";

type HotelPhoto = PlacePhoto;

interface HotelDetailSheetProps {
  place: Recommendation;
  onClose: () => void;
  /** "overlay" = standalone modal (default). "panel" = the fixed-width rail in
   *  Explore's split view — slides in from the right instead of rising. */
  mode?: "overlay" | "panel";
}

const NEARBY_CATEGORIES = [
  { id: "restaurants", label: "Restaurants", q: "restaurants", kind: "restaurant" },
  { id: "cafes", label: "Cafes", q: "cafes", kind: "restaurant" },
  { id: "attractions", label: "Attractions", q: "tourist attractions", kind: "attraction" },
  { id: "things", label: "Things to do", q: "things to do", kind: "attraction" },
  { id: "shopping", label: "Shopping", q: "shopping", kind: "shopping" },
] as const;

/* ————— Nearby session cache —————
   The details window is remounted every time a card is opened, and tab
   switches used to fire a fresh Overpass/Nominatim request each time. Keeping
   the answers for the session means reopening the same place (or going back
   to a tab) paints instantly. In-flight requests are shared too, so a hover
   prefetch followed by a click is ONE lookup, not two. */
const NEARBY_TTL_MS = 10 * 60_000;
/** A genuinely empty category is retried sooner than a successful one. */
const NEARBY_EMPTY_TTL_MS = 60_000;
const NEARBY_SESSION_MAX = 64;
interface NearbyCacheEntry {
  at: number;
  places: NearbyPlace[];
}
const nearbySession = new Map<string, NearbyCacheEntry>();
const nearbyInflight = new Map<string, Promise<NearbyPlace[] | null>>();

function nearbyKey(lat: number, lng: number, catId: string, exclude: string): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}|${catId}|${exclude.trim().toLowerCase()}`;
}

function readNearby(key: string): NearbyCacheEntry | undefined {
  const hit = nearbySession.get(key);
  if (!hit) return undefined;
  const ttl = hit.places.length > 0 ? NEARBY_TTL_MS : NEARBY_EMPTY_TTL_MS;
  if (Date.now() - hit.at >= ttl) {
    nearbySession.delete(key);
    return undefined;
  }
  return hit;
}

function writeNearby(key: string, places: NearbyPlace[]): void {
  if (!nearbySession.has(key) && nearbySession.size >= NEARBY_SESSION_MAX) {
    const oldest = nearbySession.keys().next().value;
    if (oldest !== undefined) nearbySession.delete(oldest);
  }
  nearbySession.delete(key);
  nearbySession.set(key, { at: Date.now(), places });
}

/** Cache entries that already belong to this place, for a zero-skeleton open. */
function seedNearby(place: Recommendation): Record<string, NearbyPlace[]> {
  const out: Record<string, NearbyPlace[]> = {};
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return out;
  for (const cat of NEARBY_CATEGORIES) {
    const hit = readNearby(nearbyKey(place.lat!, place.lng!, cat.id, place.name));
    if (hit) out[cat.id] = hit.places;
  }
  return out;
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Shared nearby lookup: a hover prefetch and a click on the same tab join the
 *  one request instead of firing two. Failures are NOT cached, so "Try again"
 *  really retries. */
function requestNearby(
  key: string,
  lat: number,
  lng: number,
  catId: string,
  exclude: string
): Promise<NearbyPlace[] | null> {
  const existing = nearbyInflight.get(key);
  if (existing) return existing;
  const cat = NEARBY_CATEGORIES.find((c) => c.id === catId);
  if (!cat) return Promise.resolve(null);
  const task = postJson<{ places?: NearbyPlace[] }>("/api/places/nearby", {
    lat,
    lng,
    q: cat.q,
    count: 8,
    // The place whose window is open must not appear in its own nearby list.
    exclude,
  })
    .then((res) => {
      if (!res || !Array.isArray(res.places)) return null;
      writeNearby(key, res.places);
      return res.places;
    })
    .catch(() => null)
    .finally(() => {
      nearbyInflight.delete(key);
    });
  nearbyInflight.set(key, task);
  return task;
}

/** The place's own image (preserved from its API response), if it has a valid URL. */
function seedPhotos(place: Recommendation): HotelPhoto[] {
  const u = typeof place.image === "string" ? place.image.trim() : "";
  if (!u || !/^https?:\/\//i.test(u)) return [];
  return [{ url: u, thumb: u, section: "Photo", source: photoSourceName(undefined, u) }];
}

/* ————— Gallery session cache —————
   Reopening a place's window (or switching tabs and back) used to re-hit
   /api/place-photos — and for hotels /api/hotels/photos — every time, even
   though the window closed with the photos already in React state. The final
   list is kept here for the session, so a reopen paints instantly and fires
   zero photo requests; only reviews (hotels) still refetch, since they're a
   separate call with their own state. */
const gallerySession = new Map<string, HotelPhoto[]>();
const GALLERY_SESSION_MAX = 32;

function gallerySessionKey(place: Recommendation): string {
  return `${place.type}|${place.propertyToken ?? ""}|${place.name.trim().toLowerCase()}`;
}

function readGallerySession(place: Recommendation): HotelPhoto[] | undefined {
  return gallerySession.get(gallerySessionKey(place));
}

function writeGallerySession(place: Recommendation, photos: HotelPhoto[]): void {
  if (photos.length === 0) return; // never cache the "nothing resolved" answer
  const key = gallerySessionKey(place);
  gallerySession.set(key, photos);
  if (gallerySession.size > GALLERY_SESSION_MAX) {
    const oldest = gallerySession.keys().next().value;
    if (oldest !== undefined) gallerySession.delete(oldest);
  }
}

/** Union by URL, card/hero photo first — the cached list may predate a newer
 *  hero, and the hero may be the cached list's first entry already. */
function mergeSeedPhotos(seed: HotelPhoto[], rest: HotelPhoto[]): HotelPhoto[] {
  const seen = new Set<string>();
  const out: HotelPhoto[] = [];
  for (const p of [...seed, ...rest]) {
    if (p?.url && !seen.has(p.url)) {
      seen.add(p.url);
      out.push(p);
    }
  }
  return out;
}

function PinIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 21s7-5.1 7-11a7 7 0 1 0-14 0c0 5.9 7 11 7 11Z"
      />
      <circle cx="12" cy="10" r="2.4" />
    </svg>
  );
}

function openStateClass(state: string): string {
  if (/closed/i.test(state)) return "shrink-0 font-medium text-rose-400";
  if (/open|hours/i.test(state)) return "shrink-0 font-medium text-ok";
  return "shrink-0 text-ink-faint";
}

function SectionHead({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3 border-b border-white/[0.07] pb-2">
      <h4 className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-sm font-semibold tracking-tight text-zinc-200">{title}</span>
        {hint && <span className="truncate text-2xs font-normal text-zinc-500">{hint}</span>}
      </h4>
      {right}
    </div>
  );
}

/** Nearby pick as an image card. The nearby API now supplies an instant
 *  Commons thumbnail when OSM has an image tag; otherwise this falls back to a
 *  hinted lookup (OSM id / Wikidata / Wikipedia) and then a keyword photo.
 *  Memoized so image arrivals and hover changes don't re-render siblings. */
const NearbyCard = memo(function NearbyCard({
  place,
  kind,
  index,
  onOpenPlace,
}: {
  place: NearbyPlace;
  kind: string;
  index: number;
  onOpenPlace: (place: NearbyPlace, index: number) => void;
}) {
  const hostRef = useRef<HTMLLIElement>(null);
  const nearViewport = useInView(hostRef);
  const cardKey = `${place.id ?? place.name}|${place.thumbnail ?? ""}`;
  const [imgState, setImgState] = useState<{
    key: string;
    src: string | null;
    failed: boolean;
    /** Photo that failed to load — the replacement must skip it. */
    busted?: string;
    /** 0 = initial, 1 = one replacement lookup, 2 = give up. */
    attempts: number;
  }>({ key: cardKey, src: place.thumbnail ?? null, failed: false, attempts: 0 });
  // Prop change (a different place landed in this slot): reset image state
  // during render — React's recommended "adjust state when props change"
  // pattern, so there is never a stale-photo frame.
  if (imgState.key !== cardKey) {
    setImgState({ key: cardKey, src: place.thumbnail ?? null, failed: false, attempts: 0 });
  }
  const img = imgState.src;
  const imgFailed = imgState.failed;
  const attempts = imgState.attempts;
  const busted = imgState.busted;

  // Off-screen cards cost nothing: image lookup waits until scrolled near.
  // The hints (OSM id / Wikidata / Commons tag / city) are what make it exact
  // AND fast — without them this was a fuzzy keyword lookup per card.
  useEffect(() => {
    if (img || !place.name || !nearViewport || attempts > 1) return;
    let alive = true;
    const t = window.setTimeout(
      () => {
        fetchPlaceImage(
          place.name,
          kind === "restaurant" ? "restaurant" : "landmark",
          {
            lat: place.lat,
            lng: place.lng,
            city: place.city,
            id: place.id,
            wikidata: place.wikidata,
            wikipedia: place.osmWikipedia,
            imageTag: place.osmImage,
            // This strip lives in the details window — spends its Pixabay key.
            surface: "detail",
          },
          busted ? { busted } : undefined
        ).then((u) => {
          if (alive && u) {
            setImgState((prev) =>
              prev.key === cardKey ? { ...prev, src: u, failed: false } : prev
            );
          }
        });
      },
      attempts === 0 ? 200 : 0
    );
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [
    img,
    place.name,
    place.lat,
    place.lng,
    place.city,
    place.id,
    place.wikidata,
    place.osmWikipedia,
    place.osmImage,
    nearViewport,
    kind,
    cardKey,
    attempts,
    busted,
  ]);

  const showImg = Boolean(img) && !imgFailed;
  const handleOpen = useCallback(() => onOpenPlace(place, index), [onOpenPlace, place, index]);
  // A dead photo gets ONE replacement lookup past that exact URL, then the
  // card settles on its category icon. Without the bound this could loop
  // through every broken photo the providers own.
  const handleImgError = useCallback(() => {
    setImgState((prev) =>
      prev.attempts > 1
        ? { ...prev, src: null, failed: true }
        : {
            ...prev,
            src: null,
            failed: true,
            busted: prev.src ?? prev.busted,
            attempts: prev.attempts + 1,
          }
    );
  }, []);

  return (
    <li
      ref={hostRef}
      className="animate-card-in min-w-0 cv-card"
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
    >
      <button
        type="button"
        onClick={handleOpen}
        className="group flex w-full flex-col overflow-hidden rounded-2xl border border-hairline bg-surface-1 text-left transition hover:border-accent/40 hover:bg-accent/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
      >
        <span className="relative h-24 w-full shrink-0 overflow-hidden bg-zinc-900">
          {showImg ? (
            <SmartImage
              src={img!}
              alt=""
              onError={handleImgError}
              sizes="(max-width: 640px) 90vw, 320px"
              widths={[320, 640]}
              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
            />
          ) : (
            <span className="grid h-full w-full place-items-center text-zinc-600">
              <CategoryIcon kind={kind} className="h-7 w-7" />
            </span>
          )}
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
          {place.rating != null && (
            <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/65 px-2 py-1 text-2xs font-semibold text-amber-300">
              ★ {place.rating.toFixed(1)}
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 p-3">
          <span className="block truncate text-sm font-semibold text-ink transition group-hover:text-white">
            {place.name}
          </span>
          <span className="mt-1 flex items-center gap-x-2 gap-y-1 text-2xs">
            {place.price && <span className="shrink-0 font-medium text-ok">{place.price}</span>}
            {place.type && <span className="truncate text-ink-faint">{place.type}</span>}
          </span>
          {(place.openState || place.address) && (
            <span className="mt-1 flex items-center gap-2 text-2xs">
              {place.openState && (
                <span className={openStateClass(place.openState)}>{place.openState}</span>
              )}
              {place.address && <span className="truncate text-zinc-600">{place.address}</span>}
            </span>
          )}
        </span>
      </button>
    </li>
  );
});

export default function HotelDetailSheet({
  place,
  onClose,
  mode = "overlay",
}: HotelDetailSheetProps) {
  const meta = recMeta(place.type);
  const isHotel = place.type === "hotel";
  // Attractions are a look-at-this-place view: that specific photo and its own
  // facts, nothing else. The "Nearby & suggestions" strip (which auto-opens on
  // restaurants) stays for hotels/restaurants/cities — hotel and restaurant
  // picks belong in the Stays/Restaurants tabs, not inside an attraction.
  const showNearby = place.type !== "attraction";
  const hasCoords = Number.isFinite(place.lat) && Number.isFinite(place.lng);

  // The card's own photo, wherever it lives. Explore cards resolve their
  // picture asynchronously into the shared place-image store, so by the time
  // the sheet opens the photo is usually ALREADY on screen in the grid —
  // reading it here means the hero paints at once instead of waiting for
  // the gallery lookup to come back.
  const photoKey = useMemo(
    () => placePhotoKey(categoryForType(place.type), place.name, place.city ?? ""),
    [place.type, place.name, place.city]
  );
  const sharedPhoto = usePlaceImageSync(photoKey);
  const seedPhotosFor = useCallback(
    (p: Recommendation): HotelPhoto[] => {
      const fromProp = seedPhotos(p);
      if (fromProp.length > 0) return fromProp;
      const shared = peekPlaceImage(photoKey);
      return shared
        ? [
            {
              url: shared,
              thumb: shared,
              section: "Photo",
              source: photoSourceName(undefined, shared),
            },
          ]
        : [];
    },
    [photoKey]
  );

  // Seeded at render (the sheet mounts with `key={place.id}`, so a reopen is a
  // fresh mount): the card's hero first, plus this session's saved gallery if
  // one exists — the window paints full instantly with zero photo requests.
  const [photos, setPhotos] = useState<HotelPhoto[]>(() =>
    mergeSeedPhotos(seedPhotosFor(place), readGallerySession(place) ?? [])
  );
  const [photosReady, setPhotosReady] = useState(
    () => seedPhotosFor(place).length > 0 || (readGallerySession(place)?.length ?? 0) > 0
  );
  const [activePhoto, setActivePhoto] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const nearbySeed = useMemo(() => seedNearby(place), [place]);
  const [nearby, setNearby] = useState<Record<string, NearbyPlace[]>>(nearbySeed);
  const [nearbyCat, setNearbyCat] = useState<string>("restaurants");
  // Seeded from this session's cache, so reopening a card never flashes the
  // empty state before the (instant) cache read lands.
  const [nearbyLoading, setNearbyLoading] = useState<string | null>(
    nearbySeed.restaurants ? null : "restaurants"
  );
  const [nearbyError, setNearbyError] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [childPlace, setChildPlace] = useState<Recommendation | null>(null);

  // Overlays stay mounted just long enough to play their exit animation.
  // "Last" values are adjusted during render when the live value changes —
  // no effect write, so the exit frame has the right content immediately.
  const [lastLightboxIndex, setLastLightboxIndex] = useState<number | null>(lightboxIndex);
  if (lightboxIndex != null && lightboxIndex !== lastLightboxIndex) {
    setLastLightboxIndex(lightboxIndex);
  }
  const [lastChildPlace, setLastChildPlace] = useState<Recommendation | null>(childPlace);
  if (childPlace != null && childPlace !== lastChildPlace) {
    setLastChildPlace(childPlace);
  }

  const [galleryMounted, galleryClosing] = useExitTransition(galleryOpen && photos.length > 0, 170);
  const [lightboxMounted, lightboxClosing] = useExitTransition(
    lightboxIndex != null && photos.length > 0,
    150
  );
  const [childMounted, childClosing] = useExitTransition(childPlace != null, 170);

  const scrollRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const heroTouchX = useRef<number | null>(null);
  /** Section anchors for the Overview / Things to do / Reviews / Location tabs. */
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [tab, setTab] = useState<"overview" | "doing" | "reviews" | "location">("overview");

  const goTab = useCallback(
    (id: "overview" | "doing" | "reviews" | "location") => {
      setTab(id);
      const scroller = scrollRef.current;
      const el = sectionRefs.current[id];
      if (!scroller || !el) return;
      const offset =
        el.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        (collapsed ? 92 : 44);
      scroller.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
    },
    [collapsed]
  );
  // The nearby strip sits below the gallery, so opening a card should not fire
  // an Overpass query that competes with the hero/gallery. It loads when the
  // user actually scrolls near it.
  const nearbyRef = useRef<HTMLElement>(null);
  const nearbyInView = useInView(nearbyRef, "300px 0px");

  const activeIndex = photos.length > 0 ? Math.min(activePhoto, photos.length - 1) : 0;
  const activePhotoData = photos.length > 0 ? photos[activeIndex] : undefined;
  const heroUrls = usePhotoLayers(activePhotoData?.url);

  const tripItem = useMemo(
    () => ({
      name: place.name,
      category: place.type,
      description: place.description,
      image: place.image,
      rating: place.rating,
      price: place.price,
      lat: place.lat,
      lng: place.lng,
      link: place.link,
    }),
    [place]
  );

  const loadNearby = useCallback(
    async (catId: string, opts?: { force?: boolean; prefetch?: boolean }) => {
      if (!hasCoords) return;
      const lat = place.lat as number;
      const lng = place.lng as number;
      const key = nearbyKey(lat, lng, catId, place.name);
      const cached = opts?.force ? undefined : readNearby(key);
      if (cached) {
        setNearby((prev) =>
          prev[catId] === cached.places ? prev : { ...prev, [catId]: cached.places }
        );
        setNearbyError((prev) => (prev[catId] ? { ...prev, [catId]: false } : prev));
        if (!opts?.prefetch) setNearbyLoading((cur) => (cur === catId ? null : cur));
        return;
      }

      if (!opts?.prefetch) setNearbyLoading(catId);
      const places = await requestNearby(key, lat, lng, catId, place.name);
      if (places === null) {
        // Leave `nearby[catId]` undefined: the renderer then shows the
        // connection error with its "Try again" button instead of lying
        // "Nothing found" for an upstream failure.
        setNearbyError((prev) => ({ ...prev, [catId]: true }));
        setNearbyLoading((cur) => (cur === catId ? null : cur));
        return;
      }
      setNearby((prev) => ({ ...prev, [catId]: places }));
      setNearbyError((prev) => (prev[catId] ? { ...prev, [catId]: false } : prev));
      setNearbyLoading((cur) => (cur === catId ? null : cur));
    },
    [hasCoords, place.lat, place.lng, place.name]
  );

  // Initial tab load, deferred until the strip is about to be seen. Tab
  // switches are handled synchronously by the click handler below; this
  // effect also covers the case where the sheet is opened already scrolled
  // near the strip.
  useEffect(() => {
    if (!showNearby || !hasCoords || !nearbyInView) return;
    if (nearby[nearbyCat] !== undefined || nearbyError[nearbyCat]) return;
    // Deferred so this effect does not synchronously set state (the loader
    // flips the loading flag before awaiting its request).
    const timer = window.setTimeout(() => void loadNearby(nearbyCat), 0);
    return () => window.clearTimeout(timer);
  }, [showNearby, hasCoords, nearbyInView, nearbyCat, nearby, nearbyError, loadNearby]);

  useEffect(() => {
    const ac = new AbortController();
    let done = false;
    const seed = seedPhotosFor(place);
    const cached = readGallerySession(place);

    if (isHotel) {
      const payload = { name: place.name, city: place.city, lat: place.lat, lng: place.lng };
      postJson<{ photos: HotelPhoto[] }>("/api/hotels/photos", payload, ac.signal).then((p) => {
        if (done) return;
        const gallery = Array.isArray(p?.photos) ? p.photos : [];

        // Reopen with a cached gallery: photos untouched.
        if (cached && cached.length > 0) return;

        if (gallery.length >= 12) {
          setPhotos(gallery);
          setPhotosReady(true);
          writeGallerySession(place, gallery);
          return;
        }
        // Thin hotel gallery — top up with free-first place photos.
        postJson<{ photos: string[] }>(
          "/api/place-photos",
          { name: place.name, lat: place.lat, lng: place.lng, city: place.city, count: 24 },
          ac.signal
        ).then(async (res) => {
          if (done) return;
          const extra = Array.isArray(res?.photos) ? res.photos : [];
          const seen = new Set(gallery.map((g) => g.url));
          const merged = [...gallery];
          for (const u of extra) {
            if (u && !seen.has(u)) {
              seen.add(u);
              merged.push({
                url: u,
                thumb: u,
                section: "Photo",
                source: photoSourceName(undefined, u),
              });
            }
          }
          // Both free sources empty — the hotel still deserves a picture.
          if (merged.length === 0) {
            const wiki = await fetchPlaceGallery(place.name);
            if (done) return;
            for (const u of wiki) {
              if (u && !seen.has(u)) {
                seen.add(u);
                merged.push({
                  url: u,
                  thumb: u,
                  section: "Photo",
                  source: photoSourceName(undefined, u),
                });
              }
            }
          }
          setPhotos(merged.length > 0 ? merged : seed);
          setPhotosReady(true);
          writeGallerySession(place, merged);
        });
      });
    } else if (!cached || cached.length === 0) {
      // The free Wikimedia gallery runs beside the place-photos lookup: when
      // the metered/free search comes up empty (destinations like Bali often
      // do), the article's own photos still fill the hero instead of leaving
      // the window on "No photos available yet".
      const wikiGallery = fetchPlaceGallery(place.name);
      postJson<{ photos: string[] }>(
        "/api/place-photos",
        { name: place.name, lat: place.lat, lng: place.lng, city: place.city, count: 24 },
        ac.signal
      ).then(async (res) => {
        if (done) return;
        let list = Array.isArray(res?.photos) ? res.photos : [];
        if (list.length === 0) list = await wikiGallery;
        if (done) return;
        if (list.length > 0) {
          const seedUrl = seed[0]?.url;
          const merged: HotelPhoto[] = [...seed];
          const seen = new Set(merged.map((p) => p.url));
          for (const u of list) {
            if (u && u !== seedUrl && !seen.has(u)) {
              seen.add(u);
              merged.push({
                url: u,
                thumb: u,
                section: "Photo",
                source: photoSourceName(undefined, u),
              });
            }
          }
          setPhotos(merged);
          writeGallerySession(place, merged);
        }
        setPhotosReady(true);
      });
    }

    // Nearby loads lazily from the `nearbyInView` effect below; firing it here
    // made the strip's Overpass/Nominatim query compete with the hero gallery
    // for the network and the shared OSM providers, slowing the first paint.

    return () => {
      done = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place]);

  /**
   * The card's photo can land AFTER the sheet opened (the card resolves it
   * in the background). Adjusted during render — the next frame shows it,
   * with no effect and no extra pass — so the window never keeps its empty
   * skeleton while the whole gallery lookup is still running.
   */
  if (sharedPhoto && !photos.some((p) => p.url === sharedPhoto)) {
    setPhotos([
      {
        url: sharedPhoto,
        thumb: sharedPhoto,
        section: "Photo",
        source: photoSourceName(undefined, sharedPhoto),
      },
      ...photos,
    ]);
    if (!photosReady) setPhotosReady(true);
  }

  // Compact header takes over once the hero title has scrolled away.
  // Coalesced to one measurement per frame: scroll events fire far faster than
  // the display refreshes, and reading `offsetHeight` in each one forces a
  // synchronous layout mid-scroll — the classic way to turn a smooth drag into
  // a stutter. The hero's box is cached instead of re-measured, and kept
  // fresh by a ResizeObserver (its height is `aspect-ratio`-derived, so width
  // and late-loading content are the only things that move it).
  const scrollRaf = useRef(0);
  const heroHeight = useRef(0);
  useEffect(() => {
    const measure = () => {
      heroHeight.current = heroRef.current?.offsetHeight ?? 0;
    };
    measure();
    window.addEventListener("resize", measure);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && heroRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(heroRef.current);
    }
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
      cancelAnimationFrame(scrollRaf.current);
      scrollRaf.current = 0;
    };
  }, []);

  const handleScroll = useCallback(() => {
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const scroller = scrollRef.current;
      if (!scroller) return;
      setCollapsed(scroller.scrollTop > Math.max(120, heroHeight.current - 110));

      // Scroll-spy: keep the tab underline on the section being read. All four
      // reads happen after the frame's last write, so they share one layout.
      const scrollerTop = scroller.getBoundingClientRect().top;
      let current: "overview" | "doing" | "reviews" | "location" = "overview";
      for (const id of ["overview", "doing", "reviews", "location"] as const) {
        const el = sectionRefs.current[id];
        if (!el) continue;
        if (el.getBoundingClientRect().top - scrollerTop <= 120) current = id;
      }
      setTab(current);
    });
  }, []);

  const stepHero = useCallback(
    (delta: number) => {
      if (photos.length < 2) return;
      setActivePhoto((i) => Math.min(photos.length - 1, Math.max(0, i + delta)));
    },
    [photos.length]
  );

  const openLightbox = useCallback((index: number) => setLightboxIndex(index), []);

  const openNearbyPlace = useCallback(
    (p: NearbyPlace, index: number) => {
      const cat = NEARBY_CATEGORIES.find((c) => c.id === nearbyCat);
      setChildPlace({
        id: p.id ?? `nearby-${nearbyCat}-${index}-${p.name}`,
        name: p.name,
        type: coerceType(p.type ?? cat?.kind ?? "attraction"),
        lat: typeof p.lat === "number" ? p.lat : place.lat,
        lng: typeof p.lng === "number" ? p.lng : place.lng,
        city: p.city,
        description: p.address,
        rating: p.rating,
        reviews: p.reviews,
        price: p.price,
        image: p.thumbnail,
        openingHours: p.openState,
        link: p.link,
      });
    },
    [nearbyCat, place.lat, place.lng]
  );

  const closeLightbox = useCallback(() => {
    if (lightboxIndex != null) setActivePhoto(lightboxIndex);
    setLightboxIndex(null);
  }, [lightboxIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (lightboxIndex != null) closeLightbox();
      else if (galleryOpen) setGalleryOpen(false);
      else if (childPlace) setChildPlace(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex, galleryOpen, childPlace, closeLightbox, onClose]);

  // Keep the page behind the fullscreen gallery from scrolling underneath.
  useEffect(() => {
    if (lightboxIndex == null && !galleryOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [lightboxIndex, galleryOpen]);

  // The map below is the in-app replacement for the old "open Google Maps"
  // button — details, photos and directions stay inside the site.
  const websiteHref = externalWebsiteHref(place.link);

  /* ————— Booking hand-off —————
     The discovery tiles open this panel instead of jumping out to a booking
     site, so the last step lives here: one honest, provider-side lookup for
     the thing you would do next. Hotels search availability; everything else
     opens the place's Maps card, where reservations/tickets are offered by
     whoever actually sells them. No invented direct links. */
  const bookingQuery = encodeURIComponent([place.name, place.city].filter(Boolean).join(", "));
  const mapsSearchHref = `https://www.google.com/maps/search/?api=1&query=${bookingQuery}`;
  const bookingHref =
    place.type === "hotel"
      ? `https://www.booking.com/searchresults.html?ss=${bookingQuery}`
      : mapsSearchHref;
  const bookingLabel =
    place.type === "hotel"
      ? "Check availability"
      : place.type === "restaurant"
        ? "Find a table"
        : place.type === "destination"
          ? "Find experiences"
          : "Get tickets";
  const directionsHref = hasCoords
    ? `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`
    : mapsSearchHref;

  const previewCount = Math.min(photos.length, 4);
  const hiddenCount = photos.length - previewCount;
  const nearbyKind = useMemo(
    () => NEARBY_CATEGORIES.find((c) => c.id === nearbyCat)?.kind ?? "attraction",
    [nearbyCat]
  );

  // No photos → the hero collapses to a slim band and the title block moves
  // into the flow below it instead of floating over an empty box.
  const noPhotos = photosReady && photos.length === 0;
  // Title + badge + rating — overlaid on the photo hero, in flow under the band.
  const heroTitle = (
    <>
      <h2 className="max-w-3xl text-balance text-2xl font-semibold leading-tight tracking-[-0.02em] text-white [overflow-wrap:anywhere]">
        {place.name}
      </h2>

      {place.city && (
        <p className="mt-1 flex items-center gap-1 text-xs text-white/75">
          <PinIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{place.city}</span>
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-zinc-200">
        {place.rating != null && (
          <span className="inline-flex items-center gap-1.5">
            <StarRating
              value={place.rating}
              className="text-2xs"
              baseClassName="text-white/25"
              fillClassName="text-warn"
            />
            <span className="font-semibold text-amber-300">{place.rating.toFixed(1)}</span>
            {place.reviews ? (
              <span className="text-white/60">({place.reviews.toLocaleString()})</span>
            ) : null}
          </span>
        )}
        {place.price && <span className="font-medium text-emerald-300">{place.price}</span>}
        <span className="text-white/50">{meta.label}</span>
      </div>
    </>
  );

  // Only offer tabs that have a section to land on — a tab that scrolls
  // nowhere reads as broken.
  const detailTabs: Array<{
    id: "overview" | "doing" | "reviews" | "location";
    label: string;
  }> = [
    { id: "overview", label: "Overview" },
    ...(showNearby ? [{ id: "doing" as const, label: "Things to do" }] : []),
    ...(isHotel ? [{ id: "reviews" as const, label: "Reviews" }] : []),
    ...(hasCoords ? [{ id: "location" as const, label: "Location" }] : []),
  ];

  return (
    <div
      className={`absolute inset-0 z-30 flex flex-col bg-[#09090b] text-ink ${
        mode === "panel" ? "animate-panel-in" : "animate-sheet-in"
      }`}
      role="dialog"
      aria-label={`${place.name} details`}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="dark-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {/* ——— Hero ——— */}
        <div
          ref={heroRef}
          onTouchStart={(e) => {
            heroTouchX.current = e.changedTouches[0]?.clientX ?? null;
          }}
          onTouchEnd={(e) => {
            const start = heroTouchX.current;
            heroTouchX.current = null;
            if (start == null || photos.length < 2) return;
            const dx = (e.changedTouches[0]?.clientX ?? start) - start;
            if (Math.abs(dx) > 48) stepHero(dx > 0 ? -1 : 1);
          }}
          className="group relative w-full"
        >
          {/* Image area — 16:9 capped at 320px so the hero stays a band, not
              the whole panel; collapses to a slim 120px strip with no photos. */}
          <div
            className={`relative w-full overflow-hidden bg-zinc-900 ${
              noPhotos ? "h-30" : "aspect-[16/9] max-h-[22rem] md:aspect-[16/7] md:max-h-[23rem]"
            }`}
          >
            <div
              className="absolute inset-0 grid place-items-center text-zinc-700"
              aria-hidden="true"
            >
              <CategoryIcon kind={place.type} className={noPhotos ? "h-7 w-7" : "h-14 w-14"} />
            </div>

            {!photosReady ? (
              <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-zinc-800 via-zinc-900 to-zinc-800" />
            ) : photos.length === 0 ? (
              <span className="absolute inset-0 grid place-items-center text-xs font-medium text-ink-faint">
                No photos available yet
              </span>
            ) : (
              <div
                role="button"
                tabIndex={0}
                aria-label="View photo full size"
                onClick={() => openLightbox(activeIndex)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openLightbox(activeIndex);
                  }
                }}
                className="absolute inset-0 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/70"
              >
                <PhotoLayers urls={heroUrls} alt={`${place.name} photo ${activeIndex + 1}`} />
              </div>
            )}

            <div className="absolute inset-x-0 top-0 z-10 flex items-start justify-end gap-2 bg-gradient-to-b from-black/50 via-black/10 to-transparent px-3 pb-10 pt-3 md:px-4 md:pt-4">
              <span className="flex shrink-0 items-center gap-2">
                <SavePlaceButton
                  placeKey={savedPlaceKey(place.type, place.name)}
                  name={place.name}
                  place={{
                    type: place.type,
                    name: place.name,
                    lat: place.lat,
                    lng: place.lng,
                    city: place.city,
                    rating: place.rating,
                    reviews: place.reviews,
                    price: place.price,
                    image: place.image,
                  }}
                  appearance="ghost"
                />
                <AddToTripButton item={tripItem} size="icon" appearance="solid" />
                <button
                  type="button"
                  onClick={onClose}
                  className="grid h-8 w-8 place-items-center rounded-full bg-black/50 text-white shadow-sm shadow-black/30 backdrop-blur-md transition hover:bg-black/70 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  aria-label="Close place details"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              </span>
            </div>

            {photos.length > 1 && (
              <button
                type="button"
                onClick={() => setGalleryOpen(true)}
                className="absolute bottom-3 right-3 z-10 inline-flex h-8 items-center gap-1.5 rounded-full bg-white/95 px-3 text-2xs font-semibold text-zinc-900 shadow-sm shadow-black/30 transition hover:bg-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <GridIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Show all photos</span>
                <span className="tabular-nums sm:hidden">{photos.length}</span>
              </button>
            )}

            {photos.length > 1 && (
              <>
                {activeIndex > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      stepHero(-1);
                    }}
                    className="absolute left-3 top-1/2 z-10 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-black/45 text-zinc-200 opacity-90 backdrop-blur-sm transition hover:border-white/35 hover:bg-black/75 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                    aria-label="Previous photo"
                  >
                    <ChevronIcon dir="left" />
                  </button>
                )}
                {activeIndex < photos.length - 1 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      stepHero(1);
                    }}
                    className="absolute right-3 top-1/2 z-10 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-black/45 text-zinc-200 opacity-90 backdrop-blur-sm transition hover:border-white/35 hover:bg-black/75 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                    aria-label="Next photo"
                  >
                    <ChevronIcon dir="right" />
                  </button>
                )}
              </>
            )}

            {/* Title overlay — only while a photo hero exists. */}
            {!noPhotos && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[rgba(0,0,0,0.78)] via-black/35 to-transparent pb-4 pl-4 pr-32 pt-16 md:pb-5 md:pl-6 md:pr-36">
                {heroTitle}
              </div>
            )}
          </div>

          {/* No photos: title in flow under the slim band, not over an empty hero. */}
          {noPhotos && <div className="px-4 pb-4 pt-3">{heroTitle}</div>}
        </div>

        {/* ——— Tabs ——— */}
        <div
          className={`sticky z-10 border-b border-white/[0.07] bg-[#09090b]/95 px-4 backdrop-blur-md md:px-6 ${
            collapsed ? "top-12" : "top-0"
          }`}
        >
          <div className="dark-scroll flex gap-5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {detailTabs.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => goTab(id)}
                aria-current={tab === id ? "true" : undefined}
                className={`relative shrink-0 border-b-2 py-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${
                  tab === id
                    ? "border-white text-white"
                    : "border-transparent text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ——— Content ——— */}
        <div className="space-y-7 px-4 pb-16 pt-5 md:px-6">
          <section
            ref={(el) => {
              sectionRefs.current.overview = el;
            }}
          >
            <SectionHead title="About this place" />

            {place.description ? (
              <>
                <p
                  className={`max-w-[68ch] text-[15px] leading-7 text-zinc-300 [overflow-wrap:anywhere] ${
                    descOpen ? "" : "line-clamp-4"
                  }`}
                >
                  {place.description}
                </p>
                {place.description.length > 180 && (
                  <button
                    type="button"
                    onClick={() => setDescOpen((v) => !v)}
                    className="mt-2 text-xs font-semibold text-zinc-300 underline decoration-white/30 underline-offset-2 transition hover:text-white hover:decoration-white"
                  >
                    {descOpen ? "Show less" : "Read more"}
                  </button>
                )}
              </>
            ) : (
              <p className="max-w-[68ch] text-sm italic text-ink-faint">
                No description yet — browse the photos{showNearby ? " and nearby picks" : ""} below.
              </p>
            )}

            {websiteHref && (
              <a
                href={websiteHref}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-300 underline decoration-white/30 underline-offset-2 transition hover:text-white hover:decoration-white"
              >
                Visit website
                <ExternalIcon className="h-3.5 w-3.5" />
              </a>
            )}
          </section>

          {place.type !== "hotel" && (
            <VisitDurationEditor
              name={place.name}
              category={place.type}
              fallback={place.visitDuration}
            />
          )}

          {typeof place.lat === "number" && typeof place.lng === "number" && (
            <section
              ref={(el) => {
                sectionRefs.current.location = el;
              }}
            >
              <SectionHead title="Location" hint="on the trip map" />
              <PlaceMiniMap lat={place.lat} lng={place.lng} kind={place.type} label={place.name} />
            </section>
          )}

          <section>
            <SectionHead
              title="Photos"
              hint={photos.length > 0 ? `${photos.length} in gallery` : undefined}
              right={
                photos.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setGalleryOpen(true)}
                    className="inline-flex shrink-0 items-center gap-1.5 text-2xs font-medium text-zinc-400 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                  >
                    <GridIcon className="h-3.5 w-3.5" />
                    View all
                  </button>
                ) : null
              }
            />
            {!photosReady ? (
              <div className="grid grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-surface-2" />
                ))}
              </div>
            ) : photos.length === 0 ? (
              <div className="flex h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/10 bg-surface-1 text-ink-faint">
                <CategoryIcon kind={place.type} className="h-7 w-7 text-zinc-600" />
                <span className="text-xs font-medium">No photos for this place</span>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {photos.slice(0, previewCount).map((photo, i) => {
                  const isMoreTile = hiddenCount > 0 && i === previewCount - 1;
                  return (
                    <button
                      key={`${photo.url}-${i}`}
                      type="button"
                      onClick={() => (isMoreTile ? setGalleryOpen(true) : openLightbox(i))}
                      className="group relative aspect-[4/3] overflow-hidden rounded-xl bg-zinc-900 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                      aria-label={
                        isMoreTile ? `Browse all ${photos.length} photos` : `Open photo ${i + 1}`
                      }
                    >
                      <SmartImage
                        src={photo.thumb}
                        alt={`${place.name} photo ${i + 1}`}
                        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.06]"
                        loading="eager"
                      />
                      <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent opacity-70 transition-opacity group-hover:opacity-90" />
                      {isMoreTile ? (
                        <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/35 text-md font-bold text-white">
                          +{hiddenCount}
                        </span>
                      ) : (
                        <span className="pointer-events-none absolute inset-0 grid place-items-center text-white opacity-0 transition-opacity group-hover:opacity-100">
                          <svg
                            className="h-5 w-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
                            />
                          </svg>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {hasCoords && showNearby && (
            <section
              ref={(el) => {
                nearbyRef.current = el;
                sectionRefs.current.doing = el;
              }}
            >
              <SectionHead title="Things to do nearby" hint="around this place" />
              <div className="dark-scroll -mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
                {NEARBY_CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={nearbyCat === c.id}
                    aria-busy={nearbyLoading === c.id}
                    onClick={() => {
                      setNearbyCat(c.id);
                      // Always ask: `loadNearby` answers from the session cache
                      // when it can, and revalidates a stale/empty answer. The
                      // old `!nearby[c.id]` guard made an empty category
                      // impossible to refresh without closing the window.
                      void loadNearby(c.id);
                    }}
                    // Warm the next tab on intent: by the time it is clicked,
                    // the request is already in flight (or done) — switching
                    // tabs then costs no visible wait. The in-flight map means
                    // hover + click still share one lookup.
                    onPointerEnter={() => void loadNearby(c.id, { prefetch: true })}
                    onFocus={() => void loadNearby(c.id, { prefetch: true })}
                    className={`inline-flex min-h-touch shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${
                      nearbyCat === c.id
                        ? "border-white bg-white text-zinc-900"
                        : "border-white/[0.12] bg-transparent text-zinc-300 hover:border-white/25 hover:text-white"
                    }`}
                  >
                    <CategoryIcon kind={c.kind} className="h-3.5 w-3.5" />
                    {c.label}
                  </button>
                ))}
              </div>
              {nearbyLoading === nearbyCat && !nearby[nearbyCat] ? (
                <div
                  className="grid grid-cols-2 gap-2"
                  role="status"
                  aria-label="Loading nearby places"
                >
                  <div className="h-39 animate-pulse rounded-2xl bg-surface-2" />
                  <div className="h-39 animate-pulse rounded-2xl bg-surface-2" />
                  <div className="h-39 animate-pulse rounded-2xl bg-surface-2" />
                  <div className="h-39 animate-pulse rounded-2xl bg-surface-2" />
                </div>
              ) : (nearby[nearbyCat]?.length ?? 0) === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-surface-1 px-4 py-6 text-center">
                  <p className="text-sm text-ink-muted">
                    {nearbyError[nearbyCat]
                      ? "Couldn't load nearby places. Check your connection and try again."
                      : "Nothing found in this category nearby."}
                  </p>
                  {nearbyError[nearbyCat] && (
                    <button
                      type="button"
                      onClick={() => void loadNearby(nearbyCat, { force: true })}
                      className="mt-3 inline-flex min-h-touch items-center rounded-xl border border-accent/40 bg-accent-strong/15 px-4 py-2 text-sm font-semibold text-blue-300 transition hover:bg-accent-strong/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                    >
                      Try again
                    </button>
                  )}
                </div>
              ) : (
                <ul className="grid grid-cols-2 gap-2">
                  {nearby[nearbyCat].map((p, i) => (
                    <NearbyCard
                      key={p.id ?? `${p.name}-${i}`}
                      place={p}
                      kind={nearbyKind}
                      index={i}
                      onOpenPlace={openNearbyPlace}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {isHotel && (
            <section
              ref={(el) => {
                sectionRefs.current.reviews = el;
              }}
            >
              <SectionHead title="Guest reviews" />
              {/*
                Guest reviews have no source we can rely on: OpenStreetMap
                carries none, and the paid review provider is gone. The
                section says so plainly instead of spinning on a request
                that would never answer.
              */}
              <div className="rounded-2xl border border-dashed border-white/10 bg-surface-1 px-4 py-6 text-center text-sm text-ink-faint">
                No guest reviews available yet.
              </div>
            </section>
          )}
        </div>

        {/* ——— Booking bar ——— */}
        <div className="sticky bottom-0 z-10 border-t border-white/[0.07] bg-[#09090b]/95 px-4 py-3 backdrop-blur-md md:px-6">
          <div className="flex items-center gap-2">
            <a
              href={bookingHref}
              target="_blank"
              rel="noreferrer"
              className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-white px-4 text-sm font-semibold text-zinc-900 transition-colors hover:bg-zinc-100 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#09090b]"
            >
              {bookingLabel}
              <ExternalIcon className="h-3.5 w-3.5" />
            </a>
            <a
              href={directionsHref}
              target="_blank"
              rel="noreferrer"
              aria-label="Directions"
              title="Directions"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/[0.12] text-zinc-200 transition-colors hover:border-white/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              <PinIcon className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>

      {/* ——— Sticky compact header ——— */}
      <div
        inert={!collapsed}
        aria-hidden={!collapsed}
        className={`absolute inset-x-0 top-0 z-20 flex h-12 items-center gap-2 border-b border-white/[0.07] bg-[#0b0b0c]/95 px-3 backdrop-blur-md transition-[transform,opacity] duration-200 md:px-4 ${
          collapsed
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-full opacity-0"
        }`}
      >
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-300 transition hover:bg-white/[0.08] hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          aria-label="Close place details"
        >
          <XIcon className="h-4 w-4" />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
          {place.name}
        </span>
        <SavePlaceButton
          placeKey={savedPlaceKey(place.type, place.name)}
          name={place.name}
          place={{
            type: place.type,
            name: place.name,
            lat: place.lat,
            lng: place.lng,
            city: place.city,
            rating: place.rating,
            reviews: place.reviews,
            price: place.price,
            image: place.image,
          }}
          appearance="ghost"
          className="!bg-transparent"
        />
        <AddToTripButton item={tripItem} size="icon" appearance="solid" />
      </div>

      {galleryMounted && photos.length > 0 && (
        <PhotoGallery
          photos={photos}
          placeName={place.name}
          onClose={() => setGalleryOpen(false)}
          onOpenPhoto={(i) => setLightboxIndex(i)}
          closing={galleryClosing}
        />
      )}

      {lightboxMounted && photos.length > 0 && (
        <Lightbox
          photos={photos}
          placeName={place.name}
          index={lightboxIndex ?? lastLightboxIndex ?? 0}
          onIndexChange={setLightboxIndex}
          onClose={closeLightbox}
          closing={lightboxClosing}
        />
      )}

      {/* Drill into a nearby place without ever leaving the site. */}
      {childMounted && lastChildPlace && (
        <div
          className={`fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm md:p-4 ${
            childClosing ? "animate-exit pointer-events-none" : "animate-fade-in"
          }`}
          onClick={() => setChildPlace(null)}
          role="presentation"
        >
          <div
            className="relative w-full md:w-175 h-full md:max-h-[90vh] overflow-hidden shadow-2xl shadow-black/70 md:rounded-2xl md:ring-1 md:ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <HotelDetailSheet
              key={lastChildPlace.id}
              place={lastChildPlace}
              onClose={() => setChildPlace(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
