"use client";

import { useState, useRef, useEffect, useCallback, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import ChatMessage from "@/components/chat/ChatMessage";
import ChatInput from "@/components/chat/ChatInput";
import ChatHero from "@/components/chat/ChatHero";
import ChatQuickActions from "@/components/chat/ChatQuickActions";
import ChatSidebar from "@/components/chat/ChatSidebar";
import MapPane from "@/components/map/MapPane";
import PlaceDetailModal from "@/components/explore/PlaceDetailModal";
import { SHELF_ORDER, type ShelfStep, type ShelfType } from "@/components/chat/StructuredCards";
import HomeBackground from "@/components/home/HomeBackground";
import { useTripItems } from "@/components/trip/TripItemsContext";
import { useLiveItinerary, buildLivePlanText } from "@/components/trip/LiveItineraryContext";
import type { MapMarkerData } from "@/components/map/MapView";
import type { ExploreLoc } from "@/components/explore/ExploreView";

const ExploreView = dynamic(() => import("@/components/explore/ExploreView"), { ssr: false });
/** Only opens from the map toolbar — keep it out of the initial chat bundle. */
const RoutePlanner = dynamic(() => import("@/components/trip/RoutePlanner"), { ssr: false });
import { generateId, type Message } from "@/lib/chat";
import {
  loadConversations,
  saveConversations,
  createConversation,
  deriveTitle,
  type Conversation,
} from "@/lib/conversations";
import {
  collectRecommendations,
  itemsForAssistant,
  itemsFromStructured,
  mergeRecommendations,
  type RecType,
  type Recommendation,
} from "@/lib/recommendations";
import {
  applyStageAnswer,
  defaultChips,
  EMPTY_PROFILE,
  enrichHotelsPayload,
  nextField,
  stripMetaBlocks,
  type PlanningField,
  type TripProfile,
} from "@/lib/tripProfile";
import { deriveFieldFromReply, mergeProfileFromReply, replySuggestions } from "@/lib/ai/aiReply";
import type { AiReply } from "@/lib/ai/aiSchema";
import { formatVisitDuration, formatVisitRange } from "@/lib/itinerary/durations";
import { parseItineraryCommand } from "@/lib/itinerary/ops";
import { resolvePlaceCoords } from "@/lib/placeCoords";
import type { LiveDay, LiveStop } from "@/lib/liveItinerary";
import { loadTripWeather } from "@/lib/weather";
import { readLastDeparture, searchFlights, isoDateIn } from "@/lib/flightQuery";
import type { SourceRef } from "@/lib/rag/types";
import { useExitTransition } from "@/lib/useExitTransition";

interface NearbyPlace {
  name: string;
  rating?: number;
  type?: string;
  price?: string;
  openState?: string;
  address?: string;
  thumbnail?: string;
  lat?: number;
  lng?: number;
  link?: string;
}

/** Mobile fullscreen map sheet: slides up on open, swipe-down on the grip
 *  to dismiss. Live-drag uses inline transform (transform-only, 60fps). */
function MobileMapSheet({
  closing,
  onClose,
  children,
}: {
  closing: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);

  const clearEntered = useCallback((e: React.AnimationEvent<HTMLDivElement>) => {
    // Entrance finished — drop the animation class so swipe transforms apply.
    if (e.animationName === "sheetUpIn") {
      e.currentTarget.classList.remove("animate-sheet-up");
    }
  }, []);

  const onGripStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    drag.current = { y: t.clientY, dy: 0 };
    const el = ref.current;
    if (el) el.style.transition = "none";
  }, []);
  const onGripMove = useCallback((e: React.TouchEvent) => {
    const st = drag.current;
    if (!st) return;
    const dy = Math.max(0, e.touches[0].clientY - st.y);
    st.dy = dy;
    const el = ref.current;
    if (el) el.style.transform = `translateY(${dy}px)`;
  }, []);
  const onGripEnd = useCallback(() => {
    const st = drag.current;
    drag.current = null;
    const el = ref.current;
    if (!el) return;
    el.style.transition = "transform 0.25s cubic-bezier(0.22,1,0.36,1)";
    if (st && st.dy > 110) {
      onClose();
    } else {
      el.style.transform = "";
      window.setTimeout(() => {
        if (ref.current) ref.current.style.transition = "";
      }, 260);
    }
  }, [onClose]);

  return (
    <div
      ref={ref}
      onAnimationEnd={clearEntered}
      className={`lg:hidden fixed inset-0 z-40 flex flex-col bg-[#0a0a0b] ${
        closing ? "animate-exit pointer-events-none" : "animate-sheet-up"
      }`}
    >
      <div
        className="relative z-[90] flex shrink-0 items-center justify-center pt-2 pb-2 touch-none"
        onTouchStart={onGripStart}
        onTouchMove={onGripMove}
        onTouchEnd={onGripEnd}
        aria-hidden
      >
        <span className="h-1 w-10 rounded-full bg-white/25" />
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * Name → data lookup for "add X to day 2" commands, backed by every place
 * card already shown in the conversation. Unknown names simply don't match —
 * the stop then falls back to the command's own text and default duration.
 */
function makeStopLookup(history: Message[]): (name: string) => Partial<LiveStop> | undefined {
  const places = history.flatMap((m) => m.structured?.places ?? []);
  return (name: string) => {
    const needle = name.trim().toLowerCase();
    if (needle.length < 2) return undefined;
    const hit =
      places.find((p) => p.name.toLowerCase() === needle) ??
      places.find((p) => p.name.toLowerCase().includes(needle)) ??
      places.find((p) => needle.includes(p.name.toLowerCase()));
    if (!hit) return undefined;
    return {
      name: hit.name,
      category: hit.category,
      minutes: hit.visitDuration?.typicalMinutes ?? 60,
      lat: hit.lat,
      lng: hit.lng,
      openingHours: hit.openingHours,
      cost: hit.cost || hit.priceLevel,
      source: hit.source,
    };
  };
}

/** "The Louvre" ≈ "louvre, paris" — matches live-plan stops to chat cards. */
function placeKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^(the|le|la|les|el|il|der|die|das)\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Live stops carry free-text categories — map them onto the pin taxonomy. */
function liveMarkerType(category?: string): MapMarkerData["kind"] {
  const c = (category ?? "").toLowerCase();
  if (/hotel|hostel|stay|lodge|resort|riad|\binn\b/.test(c)) return "hotel";
  if (/restaurant|cafe|coffee|food|dining|bistro|\bbar\b|brunch|bakery/.test(c))
    return "restaurant";
  if (/airport|station/.test(c)) return "airport";
  return "attraction";
}

/**
 * A plan stop with no chat card of its own, shaped like a Recommendation so
 * the map can render (and the place sheet can open) without special cases.
 */
function liveStopToPlace(day: LiveDay, stop: LiveStop): Recommendation {
  return {
    id: `live:${stop.id}`,
    name: stop.name,
    type: liveMarkerType(stop.category),
    lat: stop.lat,
    lng: stop.lng,
    description: `Day ${day.day}${day.title ? ` · ${day.title}` : ""}`,
    price: stop.cost,
    openingHours: stop.openingHours,
    visitDuration: {
      minMinutes: stop.minutes,
      typicalMinutes: stop.minutes,
      maxMinutes: stop.minutes,
      confidence: 1,
      basis: `Planned on day ${day.day}`,
      origin: "override",
    },
  };
}

function ChatContent() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") || "";
  const initialView = searchParams.get("view") === "explore" ? "explore" : "chat";

  /**
   * Explore is one window with two doors: the Explore tab here and every
   * "Explore" link elsewhere in the app (saved places, footer). Those links
   * deep-link a location through lat/lng/name so both doors open the same
   * view, on the same place.
   */
  const initialLoc = useMemo<ExploreLoc | undefined>(() => {
    const name = (searchParams.get("name") || "").trim();
    const lat = Number(searchParams.get("lat"));
    const lng = Number(searchParams.get("lng"));
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
    return { name, lat, lng };
  }, [searchParams]);
  const initialMapOpen = searchParams.get("map") === "1";

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** The rail is part of the shell — visible until the traveller folds it. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [focusMarkerId, setFocusMarkerId] = useState<string | null>(null);
  const [hoverMarkerId, setHoverMarkerId] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  /** Desktop aside: collapsed from the map's own top-left back button. */
  const [mapCollapsed, setMapCollapsed] = useState(false);
  /** Set when a card asks for the map, so a card without a pin still opens it. */
  const [mapRequested, setMapRequested] = useState(false);
  /** Geocoded fixes for cards whose reply came without lat/lng. */
  const [geoFixes, setGeoFixes] = useState<Record<string, { lat: number; lng: number }>>({});
  const [routeOpen, setRouteOpen] = useState(false);
  const [detailPlace, setDetailPlace] = useState<Recommendation | null>(null);
  const [isDesktop, setIsDesktop] = useState(false);
  const [stageHits, setStageHits] = useState<Record<string, Recommendation[]>>({});
  const [profile, setProfile] = useState<TripProfile>(EMPTY_PROFILE);
  const [view, setView] = useState<"chat" | "explore">(initialView);

  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const stageFetchRef = useRef<Set<string>>(new Set());
  /** Saved trip board — sent along so recall/preference retrieval can use it. */
  const { items: tripBoard } = useTripItems();
  /** The single editable plan: chat commands mutate it, the map reads it. */
  const { plan: livePlan, applyOps, seedFromReply } = useLiveItinerary();
  const resultsRef = useRef<Recommendation[]>([]);

  const active = conversations.find((c) => c.id === activeId) || null;
  const messages = useMemo(() => active?.messages ?? [], [active]);
  const isEmpty = messages.length === 0;

  // Identity-stable (both helpers cache), so streaming's per-frame messages
  // array doesn't churn `results` → `markers` → the map on every token.
  const results = useMemo(() => {
    const fromChat = collectRecommendations(messages);
    const extras: Recommendation[] = [];
    const msgIds = new Set(messages.map((m) => m.id));
    for (const [key, list] of Object.entries(stageHits)) {
      const msgId = key.slice(0, key.lastIndexOf(":"));
      if (msgIds.has(msgId)) extras.push(...list);
    }
    return mergeRecommendations(fromChat, extras);
  }, [messages, stageHits]);

  /**
   * Cards the model could not place still deserve a pin. `geoFixes` holds
   * coordinates resolved on demand (see `handleFocusPlace`); the card objects
   * themselves stay untouched so card rendering is unchanged.
   */
  const resultsWithCoords = useMemo(() => {
    const fixed = Object.keys(geoFixes);
    if (fixed.length === 0) return results;
    let changed = false;
    const next = results.map((r) => {
      const coords = geoFixes[r.id];
      if (!coords || (typeof r.lat === "number" && typeof r.lng === "number")) return r;
      changed = true;
      return { ...r, lat: coords.lat, lng: coords.lng };
    });
    return changed ? next : results;
  }, [results, geoFixes]);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  // The map renders chat cards and the live plan as one ordered set: plan
  // stops come first in day order (the route line follows the itinerary),
  // each matched to its chat card when one exists — so edits made in chat
  // (move/remove/swap) reorder the pins instantly — and the remaining cards
  // follow. Nothing is stored twice.
  const mapResults = useMemo<Recommendation[]>(() => {
    const located = resultsWithCoords.filter(
      (r) => typeof r.lat === "number" && typeof r.lng === "number"
    );
    const byPlaceId = new Map(located.map((r) => [r.id, r] as const));
    const byKey = new Map<string, Recommendation>();
    for (const r of located) {
      const key = placeKey(r.name);
      if (key && !byKey.has(key)) byKey.set(key, r);
    }
    const used = new Set<string>();
    const ordered: Recommendation[] = [];
    for (const day of livePlan.days) {
      for (const stop of day.stops) {
        if (typeof stop.lat !== "number" || typeof stop.lng !== "number") continue;
        const key = placeKey(stop.name);
        const match = (stop.placeId ? byPlaceId.get(stop.placeId) : undefined) ?? byKey.get(key);
        if (match) {
          if (used.has(match.id)) continue;
          used.add(match.id);
          ordered.push(match);
        } else {
          ordered.push(liveStopToPlace(day, stop));
        }
      }
    }
    for (const r of resultsWithCoords) {
      if (typeof r.lat === "number" && typeof r.lng === "number" && !used.has(r.id)) {
        ordered.push(r);
      }
    }
    return ordered;
  }, [resultsWithCoords, livePlan]);

  const markers = useMemo<MapMarkerData[]>(
    () =>
      mapResults.map((r) => ({
        id: r.id,
        lat: r.lat as number,
        lng: r.lng as number,
        label: r.name,
        kind: r.type,
        description: r.description,
        image: r.image,
        rating: r.rating,
        price: r.price,
        link: r.link,
        city: r.city,
        reviews: r.reviews,
        durationText: r.visitDuration ? `~${formatVisitDuration(r.visitDuration)}` : undefined,
        durationTitle: r.visitDuration
          ? `Typically ${formatVisitRange(r.visitDuration)} on site — ${r.visitDuration.basis}`
          : undefined,
      })),
    [mapResults]
  );

  // Which recommendation cards live in which message. Lets the message list
  // pass focus/hover only to the message that can actually show it, so every
  // other row's props stay identical and memoized rows skip re-rendering.
  //
  // The same pass works out the trip navigator: which shelves this
  // conversation has already covered and which one the newest reply belongs to.
  const { cardIdsByMessage, shelfProgress } = useMemo(() => {
    const index = new Map<string, Set<string>>();
    const covered = new Set<RecType>();
    let latestAssistantId: string | null = null;
    for (const m of messages) if (m.role === "assistant") latestAssistantId = m.id;

    let current = new Set<RecType>();
    for (const m of messages) {
      const items = itemsForAssistant(m.id, m.content, m.structured);
      if (items.length === 0) continue;
      index.set(m.id, new Set(items.map((i) => i.id)));
      if (m.role !== "assistant") continue;
      const types = new Set(items.map((i) => i.type));
      for (const t of types) covered.add(t);
      if (m.id === latestAssistantId) current = types;
    }

    const progress: ShelfStep[] = SHELF_ORDER.map((type) => ({
      type,
      state: current.has(type) ? "current" : covered.has(type) ? "done" : "open",
    }));
    return { cardIdsByMessage: index, shelfProgress: progress };
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const stored = loadConversations();
      setConversations(stored);
      if (stored.length > 0) {
        setActiveId(stored[0].id);
        setProfile(stored[0].profile ?? EMPTY_PROFILE);
      }
      setHydrated(true);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setIsDesktop(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (loading) return;
    const t = window.setTimeout(() => saveConversations(conversations), 300);
    return () => window.clearTimeout(t);
  }, [conversations, hydrated, loading]);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const prevMsgCountRef = useRef(0);
  const prevActiveRef = useRef(activeId);
  // True while the user is pinned to the bottom. Cleared the moment they
  // scroll up manually, so streaming never yanks the viewport back down.
  const stickRef = useRef(true);
  /** Mirrors `loading` for the MutationObserver, which must not re-subscribe. */
  const loadingRef = useRef(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  const handleScrollList = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);
  useEffect(() => {
    const switched = prevActiveRef.current !== activeId;
    prevActiveRef.current = activeId;
    const grew = messages.length > prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    if (grew || switched) {
      stickRef.current = true;
      scrollToBottom(false);
    }
  }, [messages, activeId, scrollToBottom]);

  const prevLoadingRef = useRef(true);
  /** Re-anchor timers for the reply that just landed (see below). */
  const settleTimersRef = useRef<number[]>([]);
  const clearSettleTimers = useCallback(() => {
    for (const t of settleTimersRef.current) window.clearTimeout(t);
    settleTimersRef.current = [];
  }, []);
  useEffect(() => {
    return () => clearSettleTimers();
  }, [clearSettleTimers]);

  useEffect(() => {
    const was = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (!was || loading) return;

    clearSettleTimers();
    const el = scrollRef.current;
    if (!el) return;

    const rows = el.querySelectorAll<HTMLElement>('[data-msg-role="assistant"]');
    const node = rows[rows.length - 1];
    const hasCards = Boolean(node?.querySelector("[data-place-card-id]"));

    if (!node || !hasCards) {
      if (stickRef.current) scrollToBottom(true);
      return;
    }

    // Steer the viewport only when the new reply is on screen. A reply that
    // landed entirely below the fold still gets followed to the bottom; a
    // reader who scrolled up into earlier turns is left exactly where they are.
    const nodeTop = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
    if (nodeTop > el.clientHeight) {
      scrollToBottom(true);
      return;
    }
    if (nodeTop < -el.clientHeight * 0.5) return;

    // A reply that carries cards opens at its own start: the intro, the shelf
    // row and the cards are what the turn is about, and a reply that fits the
    // viewport simply clamps to the bottom.
    const target = () =>
      Math.max(
        0,
        node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12
      );
    let lastTarget = target();
    el.scrollTo({ top: lastTarget, behavior: "smooth" });

    // Cards settle late — imagery and live enrichment land after the stream
    // closes — so re-assert the same anchor for a moment. The first pass runs
    // even mid-animation; later passes back off if the reader has scrolled away.
    [500, 1200, 2200].forEach((delay, i) => {
      settleTimersRef.current.push(
        window.setTimeout(() => {
          if (i > 0 && Math.abs(el.scrollTop - lastTarget) > 80) return;
          lastTarget = target();
          el.scrollTo({ top: lastTarget, behavior: "smooth" });
        }, delay)
      );
    });
  }, [loading, scrollToBottom, clearSettleTimers]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Coalesce rapid streaming mutations into one rAF scroll per frame —
    // the previous version read/wrote scroll metrics synchronously on every
    // token and thrashed layout while scrolling.
    let scheduled = false;
    const obs = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        // Stick only while a reply is streaming AND the user hasn't scrolled
        // up to read. Late arrivals — an image finishing, a card expanding —
        // must not drag the viewport back to the bottom after it settled.
        if (stickRef.current && loadingRef.current) el.scrollTop = el.scrollHeight;
      });
    });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      obs.disconnect();
      scheduled = false;
    };
  }, [isEmpty]);

  // The hero composer autofocuses; on a short viewport the browser reveals the
  // field by scrolling the panel, which slid the badge and heading out of view.
  // The empty state always reads from the top.
  useEffect(() => {
    if (!isEmpty) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [isEmpty]);

  /**
   * On-screen keyboard: browsers either resize the layout viewport
   * (interactive-widget=resizes-content) or overlay the page and pan the
   * visual viewport up — that pan is the "typing moves the whole window"
   * jump. Track the overlay by hand while a text field has focus and expose
   * it as --kb-inset, which `.pb-safe` adds to the composer's bottom padding
   * so the composer rides above the keyboard and the browser never pans.
   * Desktop reports an inset of 0, so nothing changes there.
   */
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const isTextField = (el: EventTarget | null) =>
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable);
    const apply = () => {
      const inset =
        isTextField(document.activeElement) && vv
          ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
          : 0;
      root.style.setProperty("--kb-inset", `${inset}px`);
    };
    // Recompute on blur once the next focus target has settled.
    const onFocusOut = () => window.setTimeout(apply, 0);
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    document.addEventListener("focusin", apply);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      document.removeEventListener("focusin", apply);
      document.removeEventListener("focusout", onFocusOut);
      root.style.removeProperty("--kb-inset");
    };
  }, []);

  const updateConversation = useCallback(
    (id: string, updater: (c: Conversation) => Conversation) => {
      setConversations((prev) => prev.map((c) => (c.id === id ? updater(c) : c)));
    },
    []
  );

  /**
   * Stage-based enrichment: back the assistant's cards with live API results.
   * hotels → /api/hotels; restaurants/attractions → /api/places/nearby anchored
   * on a recommendation already on the map (hotel first for restaurants).
   */
  const maybeEnrichStage = useCallback(
    (assistantId: string, assistantText: string, prof: TripProfile) => {
      const stage = nextField(prof);
      const hotelIntent =
        /\b(hotel|hostel|stay|lodging|accommodation|resort|airbnb|guesthouse|where to sleep|where to stay)\b/i.test(
          assistantText
        );
      const restIntent = /\b(restaurants?|dining|where to eat)\b/i.test(assistantText);
      const attrIntent = /\b(things to do|attractions?|activities|sights)\b/i.test(assistantText);

      let kind: "hotels" | "restaurants" | "attractions" | null = null;
      if (stage === "hotel" || (!prof.hotel && hotelIntent)) kind = "hotels";
      else if (stage === "restaurants" || (!prof.restaurants && restIntent && prof.hotel))
        kind = "restaurants";
      else if (stage === "attractions" || (!prof.attractions && attrIntent)) kind = "attractions";
      if (!kind || !prof.destination) return;

      const key = `${assistantId}:${kind}`;
      if (stageFetchRef.current.has(key)) return;
      stageFetchRef.current.add(key);

      if (kind === "hotels") {
        const payload = enrichHotelsPayload(prof);
        if (!payload?.destination) {
          stageFetchRef.current.delete(key);
          return;
        }
        fetch("/api/hotels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then((r) => r.json())
          .then((data) => {
            const hotels: Recommendation[] = Array.isArray(data?.hotels) ? data.hotels : [];
            if (hotels.length === 0) return;
            setStageHits((prev) => ({
              ...prev,
              [key]: hotels.map((h, i) => ({ ...h, id: `${assistantId}:hotel:${i}` })),
            }));
          })
          .catch(() => {});
        return;
      }

      const recs = resultsRef.current;
      const dest = recs.find((r) => r.type === "destination");
      const hotel = recs.find((r) => r.type === "hotel");
      const anchor = kind === "restaurants" ? (hotel ?? dest) : (dest ?? hotel);
      if (!anchor) {
        stageFetchRef.current.delete(key);
        return;
      }
      fetch("/api/places/nearby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: anchor.lat,
          lng: anchor.lng,
          q: kind === "restaurants" ? "restaurants" : "things to do",
          count: 8,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          const places: NearbyPlace[] = Array.isArray(data?.places) ? data.places : [];
          const type = kind === "restaurants" ? "restaurant" : "attraction";
          const items: Recommendation[] = places
            .filter(
              (p): p is NearbyPlace & { lat: number; lng: number } =>
                typeof p.lat === "number" && typeof p.lng === "number" && Boolean(p.name)
            )
            .map((p, i) => ({
              id: `${assistantId}:near:${i}`,
              name: p.name,
              type,
              lat: p.lat,
              lng: p.lng,
              rating: p.rating,
              price: p.price,
              image: p.thumbnail,
              link: p.link,
              description:
                [p.type, p.address].filter(Boolean).join(" · ") || p.openState || undefined,
            }));
          if (items.length === 0) return;
          setStageHits((prev) => ({ ...prev, [key]: items }));
        })
        .catch(() => {});
    },
    []
  );

  const switchView = useCallback((v: "chat" | "explore") => {
    setView(v);
    setMapOpen(false);
    setMapRequested(false);
    setRouteOpen(false);
    if (v === "explore") setFocusMarkerId(null);
  }, []);

  const handleNewChat = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setActiveId(null);
    setLoading(false);
    setSidebarOpen(false);
    setMapOpen(false);
    setMapRequested(false);
    setMapCollapsed(false);
    setFocusMarkerId(null);
    setStageHits({});
    setGeoFixes({});
    setProfile(EMPTY_PROFILE);
    setView("chat");
    stageFetchRef.current.clear();
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMapRequested(false);
        setMapCollapsed(false);
        setFocusMarkerId(null);
        setStageHits({});
        setGeoFixes({});
        setProfile(EMPTY_PROFILE);
        stageFetchRef.current.clear();
      }
    },
    [activeId]
  );

  const handleSelect = useCallback(
    (id: string) => {
      abortRef.current?.abort();
      abortRef.current = null;
      setActiveId(id);
      setLoading(false);
      setSidebarOpen(false);
      setMapRequested(false);
      setMapCollapsed(false);
      setFocusMarkerId(null);
      setStageHits({});
      setGeoFixes({});
      setView("chat");
      stageFetchRef.current.clear();
      const conv = conversations.find((c) => c.id === id);
      setProfile(conv?.profile ?? EMPTY_PROFILE);
    },
    [conversations]
  );

  const handleFocusPlace = useCallback((id: string) => {
    setMapRequested(true);
    setFocusMarkerId(id);
    // Focusing a place always has somewhere to show it: restore a collapsed
    // aside, and open the sheet on mobile.
    setMapCollapsed(false);
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      setMapOpen(true);
    }

    // A card can arrive without lat/lng (the model is told to omit them when
    // unsure). Resolve the missing pair on demand so the click still lands on
    // a pin instead of doing nothing.
    const item = resultsRef.current.find((r) => r.id === id);
    if (!item || (typeof item.lat === "number" && typeof item.lng === "number")) return;
    const city =
      item.city || resultsRef.current.find((r) => r.type === "destination")?.name;
    void resolvePlaceCoords(item.name, city).then((coords) => {
      if (!coords) return;
      setGeoFixes((prev) => (prev[id] ? prev : { ...prev, [id]: coords }));
    });
  }, []);

  const handleOpenPlace = useCallback((item: Recommendation) => {
    setRouteOpen(false);
    setMapOpen(false);
    setFocusMarkerId(item.id);
    setDetailPlace(item);
  }, []);

  // Tapping a marker scrolls the chat to its card (desktop — on mobile the
  // chat list sits behind the fullscreen map sheet). Cards sit in a horizontal
  // carousel, so centre them on the cross axis too.
  const handleMarkerTap = useCallback((id: string) => {
    if (typeof window === "undefined" || window.innerWidth < 1024) return;
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-place-card-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });
  }, []);

  // Map tap / Escape / another pin closes the card without touching the chat.
  const handleDismissFocus = useCallback(() => {
    setFocusMarkerId(null);
  }, []);

  /** Party size for budget math, from the active conversation's profile. */
  const travelers = useMemo(() => {
    const people = active?.profile?.people ?? profile.people;
    const m = people?.match(/\d{1,2}/);
    return m ? Math.min(30, Math.max(1, parseInt(m[0], 10))) : 1;
  }, [active?.profile?.people, profile.people]);

  // The map's own top-left back button collapses the desktop aside; the
  // header's Map button brings it back.
  const handleCollapseMap = useCallback(() => {
    setMapCollapsed(true);
  }, []);

  // Closing the mobile map sheet — stable so the memoized MapPane keeps its
  // props identical while the chat streams behind it.
  const handleCloseMapSheet = useCallback(() => {
    setMapOpen(false);
  }, []);

  // Draggable chat/map divider (desktop). Width persists across visits.
  const [mapWidth, setMapWidth] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem("tripcraft:mapw"));
      return Number.isFinite(v) && v >= 340 && v <= 760 ? v : null;
    } catch {
      return null;
    }
  });
  const asideRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const mapWidthRef = useRef<number | null>(null);
  /** Latest dragged width — updated synchronously, flushed once per frame. */
  const pendingW = useRef<number | null>(null);
  useEffect(() => {
    mapWidthRef.current = mapWidth;
  }, [mapWidth]);
  const startDividerDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startW: asideRef.current?.getBoundingClientRect().width ?? 520,
    };
  }, []);
  useEffect(() => {
    // Pointer events fire faster than frames — write the width to a ref
    // immediately and flush one setState per rAF so the drag never queues
    // multiple React renders per frame.
    let raf = 0;
    const flush = () => {
      raf = 0;
      const w = pendingW.current;
      if (w != null && w !== mapWidthRef.current) setMapWidth(w);
    };
    const move = (e: PointerEvent) => {
      const st = dragRef.current;
      if (!st) return;
      const w = Math.min(760, Math.max(340, st.startW + (st.startX - e.clientX)));
      pendingW.current = w;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      if (raf) {
        cancelAnimationFrame(raf);
        flush();
      }
      try {
        const w = pendingW.current ?? mapWidthRef.current;
        if (w != null) {
          localStorage.setItem("tripcraft:mapw", String(Math.round(w)));
        }
      } catch {
        // ignore storage errors
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const handleSend = useCallback(
    async (
      text: string,
      answer?: { field: PlanningField | null; value: string },
      opts?: { replay?: boolean }
    ) => {
      if (loading) return;

      const baseMessages: Message[] = active?.messages ?? [];

      // Regenerate: drop the trailing assistant bubble and replay the user's
      // last message — same conversation, no duplicated question, no new
      // stage answer (it is already folded into the profile).
      const isReplay = opts?.replay === true;
      const tail = baseMessages[baseMessages.length - 1] ?? null;
      const prevUser = baseMessages[baseMessages.length - 2] ?? null;
      const replayUser =
        isReplay && tail?.role === "assistant" && prevUser?.role === "user" ? prevUser : null;
      if (isReplay && !replayUser?.content.trim()) return;
      if (!isReplay && !text.trim()) return;

      const history: Message[] = isReplay ? baseMessages.slice(0, -1) : baseMessages;
      const questionText = ((isReplay ? replayUser?.content : text) ?? "").trim();
      const baseProfile = { ...EMPTY_PROFILE, ...(active?.profile || profile) };

      // Itinerary edit commands ("move the Louvre to day 2") apply to the live
      // plan IMMEDIATELY — timeline and map update optimistically, with undo in
      // the toast. The model only acknowledges (tripEdit context below).
      let appliedEdits: string[] = [];
      if (!isReplay && questionText) {
        const ops = parseItineraryCommand(questionText);
        if (ops.length > 0) {
          const result = applyOps(ops, makeStopLookup(history));
          appliedEdits = result.applied;
        }
      }

      // Field the assistant last asked about (structured reply or planning
      // hint), falling back to the machine's next missing stage.
      const lastAssistantMsg = [...history].reverse().find((m) => m.role === "assistant");
      const expectedField = (answer?.field ??
        lastAssistantMsg?.field ??
        nextField(baseProfile)) as PlanningField | null;

      let nextProfile = isReplay ? baseProfile : applyStageAnswer(baseProfile, expectedField, text);
      if (answer) {
        if (answer.field === "hotel") nextProfile = { ...nextProfile, hotel: answer.value };
        else if (answer.field === "restaurants")
          nextProfile = { ...nextProfile, restaurants: answer.value };
        else if (answer.field === "attractions")
          nextProfile = { ...nextProfile, attractions: answer.value };
      }
      setProfile(nextProfile);

      const userMsg: Message = replayUser ?? { id: generateId(), role: "user", content: text };
      const assistantId = generateId();
      const assistantMsg: Message = { id: assistantId, role: "assistant", content: "" };
      let convId = activeId;

      if (!convId) {
        const conv = createConversation([userMsg, assistantMsg], nextProfile);
        convId = conv.id;
        setConversations((prev) => [conv, ...prev]);
        setActiveId(conv.id);
      } else {
        updateConversation(convId, (c) => ({
          ...c,
          profile: nextProfile,
          messages: isReplay
            ? // swap the old assistant bubble for the fresh one
              [...c.messages.slice(0, -1), assistantMsg]
            : [...c.messages, userMsg, assistantMsg],
          title: c.messages.length === 0 ? deriveTitle([userMsg]) : c.title,
          updatedAt: Date.now(),
        }));
      }

      setLoading(true);
      const controller = new AbortController();
      abortRef.current = controller;

      const allMessages = (isReplay ? history : [...history, userMsg]).map((m) => ({
        role: m.role,
        content: stripMetaBlocks(m.content) || m.content,
      }));

      // The plan currently on the table (last structured reply): follow-ups
      // such as "make it cheaper" edit it instead of starting over.
      const plan = lastAssistantMsg?.structured ?? null;

      // Every place already rendered in this conversation — the route injects
      // this ledger into the prompt and drops cards that would repeat it.
      const shownPlaces = history.flatMap((m) =>
        (m.structured?.places ?? []).map((p) => ({
          name: p.name,
          category: p.category,
          city: p.city,
        }))
      );

      // Saved trip board, for preference/recall retrieval (RAG).
      const tripItems = tripBoard.slice(0, 60).map((i) => ({
        name: i.name,
        category: i.category,
        price: i.price,
        detail: i.detail,
        description: i.description,
        rating: i.rating,
      }));

      /** Patch this assistant bubble and keep the profile in sync. */
      const writeReply = (patch: (m: Message) => Message) => {
        updateConversation(convId, (c) => ({
          ...c,
          profile: nextProfile,
          messages: c.messages.map((m) => (m.id === assistantId ? patch(m) : m)),
          updatedAt: Date.now(),
        }));
      };

      /** Background enrichment: attach weather / flight cards to this reply. */
      const enrichMessage = async (msgId: string, q: string, r: AiReply, prof: TripProfile) => {
        const patch = (fn: (m: Message) => Message) =>
          updateConversation(convId, (c) => ({
            ...c,
            messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)),
            updatedAt: Date.now(),
          }));
        const destination = r.destination || prof.destination;
        if (!destination) return;

        // Weather: weather questions, and any newly planned itinerary.
        const wantsWeather =
          /weather|rain|forecast|climate|umbrella|temperature|how (hot|cold|warm|sunny)|best time/i.test(
            q
          ) || r.itinerary.length > 0;
        if (wantsWeather) {
          const days = Math.min(16, Math.max(1, r.itinerary.length || 7));
          const weather = await loadTripWeather({ place: destination, days });
          if (weather) patch((m) => ({ ...m, weather }));
        }

        // Flights: only for flight questions AND when a departure airport is
        // already known from the flight bar — origins are never guessed.
        if (/\b(flights?|flying|airfare|airlines?|plane)\b/i.test(q)) {
          const departure = readLastDeparture();
          if (departure) {
            try {
              const offers = await searchFlights({
                departure,
                arrival: destination,
                dates: prof.dates,
                people: prof.people,
              });
              if (offers.length > 0) {
                patch((m) => ({
                  ...m,
                  flights: {
                    offers: offers.slice(0, 3),
                    from: departure,
                    to: destination,
                    date: isoDateIn(prof.dates),
                    fetchedAt: Date.now(),
                  },
                }));
              }
            } catch {
              /* flight unavailability never blocks the answer */
            }
          }
        }
      };

      /** Commit a validated reply in render order: intro → cards → question → chips. */
      const commitReply = (reply: AiReply, sources?: SourceRef[]) => {
        // Fold what the reply established (destination, dates) back into the
        // trip context so the next request never asks for them twice.
        const merged = mergeProfileFromReply(nextProfile, reply);
        if (merged !== nextProfile) {
          nextProfile = merged;
          setProfile(merged);
        }
        const field = deriveFieldFromReply(reply, nextProfile);
        const chips = replySuggestions(reply);
        writeReply((m) => ({
          ...m,
          content: reply.intro,
          structured: reply,
          sources: sources && sources.length > 0 ? sources : m.sources,
          chips: reply.followUpQuestion
            ? chips.length > 0
              ? chips
              : defaultChips(field, nextProfile)
            : undefined,
          field: field !== "done" ? field : undefined,
        }));
        // An itinerary reply becomes/refreshes the live plan (timeline + map).
        if (reply.itinerary.length > 0) {
          seedFromReply(reply, itemsFromStructured(assistantId, reply, nextProfile.pace), {
            destination: nextProfile.destination,
            dates: nextProfile.dates,
            people: nextProfile.people,
            pace: nextProfile.pace,
          });
        }
        // Live stage results only when the reply itself brought no cards.
        if (reply.places.length === 0) maybeEnrichStage(assistantId, reply.intro, nextProfile);
        void enrichMessage(assistantId, questionText, reply, nextProfile);
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: allMessages,
            profile: nextProfile,
            conversationId: convId ?? undefined,
            plan,
            shownPlaces,
            tripItems,
            livePlan: buildLivePlanText(livePlan) || undefined,
            tripEdit: appliedEdits.length > 0 ? appliedEdits : undefined,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.details || data.error || `Request failed (${res.status})`);
        }

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          // Non-stream fallback (a pre-validated reply, never raw model output).
          const data = await res.json();
          if (data.reply) {
            commitReply(data.reply as AiReply);
          } else if (typeof data.content === "string" && data.content) {
            writeReply((m) => ({ ...m, content: data.content }));
          } else {
            throw new Error(data.details || data.error || "Empty response");
          }
        } else if (res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let acc = "";
          let reply: AiReply | null = null;
          let replySources: SourceRef[] = [];
          let failure: string | null = null;
          // NDJSON events land in bursts → at most one render per frame.
          let rafId = 0;
          const scheduleSnapshot = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
              rafId = 0;
              const snapshot = acc;
              writeReply((m) => ({ ...m, content: snapshot }));
            });
          };

          const handleEvent = (line: string) => {
            if (!line.trim()) return;
            let event: {
              type?: string;
              text?: string;
              reply?: AiReply;
              message?: string;
              sources?: SourceRef[];
            };
            try {
              event = JSON.parse(line);
            } catch {
              return;
            }
            if (event.type === "delta" && typeof event.text === "string") {
              acc += event.text;
              scheduleSnapshot();
            } else if (event.type === "reset") {
              acc = "";
              scheduleSnapshot();
            } else if (event.type === "done" && event.reply) {
              reply = event.reply;
              replySources = Array.isArray(event.sources) ? event.sources : [];
              acc = event.reply.intro || acc;
            } else if (event.type === "error") {
              failure =
                typeof event.message === "string" && event.message
                  ? event.message
                  : "Please try again.";
            }
          };

          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) handleEvent(line);
            }
            buffer += decoder.decode();
            handleEvent(buffer);
          } finally {
            if (rafId) {
              cancelAnimationFrame(rafId);
              rafId = 0;
            }
          }

          if (reply) {
            commitReply(reply, replySources);
          } else if (failure) {
            const failText = failure;
            writeReply((m) => ({ ...m, content: failText }));
          } else if (acc) {
            // Stream cut before a validated reply arrived — keep the intro.
            writeReply((m) => ({ ...m, content: acc }));
          } else {
            throw new Error("Empty response");
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Stopped mid-stream: drop the empty bubble, keep partial text.
          updateConversation(convId, (c) => ({
            ...c,
            messages: c.messages.filter((m) => !(m.id === assistantId && !m.content)),
            updatedAt: Date.now(),
          }));
          return;
        }
        console.error("Chat error:", err);
        const errorText = `Sorry, I encountered an error. ${err instanceof Error ? err.message : "Please try again."}`;
        updateConversation(convId, (c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.id === assistantId ? { ...m, content: errorText } : m
          ),
          updatedAt: Date.now(),
        }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setLoading(false);
      }
    },
    [
      activeId,
      active,
      profile,
      loading,
      updateConversation,
      maybeEnrichStage,
      tripBoard,
      livePlan,
      applyOps,
      seedFromReply,
    ]
  );

  /**
   * Regenerate: replay the last user message through the same pipeline, so a
   * bad or empty reply can be re-asked without retyping anything.
   */
  const handleRegenerate = useCallback(() => {
    if (loading) return;
    const msgs = active?.messages ?? [];
    const prevUser = msgs[msgs.length - 2];
    if (msgs[msgs.length - 1]?.role !== "assistant" || prevUser?.role !== "user") return;
    handleSend(prevUser.content, undefined, { replay: true });
  }, [loading, active, handleSend]);

  /**
   * Thumbs up/down verdict, stored on the message so it is persisted with the
   * conversation and still there on a reload (for later review).
   */
  const handleFeedback = useCallback(
    (messageId: string, verdict: "up" | "down") => {
      if (!activeId) return;
      updateConversation(activeId, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === messageId ? { ...m, feedback: m.feedback === verdict ? undefined : verdict } : m
        ),
        updatedAt: Date.now(),
      }));
    },
    [activeId, updateConversation]
  );

  const handleSelectPlace = useCallback(
    (rec: Recommendation) => {
      if (loading) return;
      const history = active?.messages ?? [];
      const lastAsst = [...history].reverse().find((m) => m.role === "assistant");
      const field = (lastAsst?.field ?? null) as PlanningField | null;
      if (field !== "hotel" && field !== "restaurants" && field !== "attractions") return;
      let value = rec.name;
      if (field !== "hotel") {
        const prev = profile[field];
        if (prev && !prev.includes(rec.name)) value = `${prev}, ${rec.name}`;
        else if (prev) value = prev;
      }
      handleSend(`I'll go with ${rec.name}`, { field, value });
    },
    [loading, active, profile, handleSend]
  );

  /**
   * Stable proxies for the memoized message rows. Streaming rewrites the
   * active conversation every frame, which recreates handleSend /
   * handleSelectPlace / handleRegenerate (they close over `active`); passing
   * them straight through changes every row's props on every token and defeats
   * memo(ChatMessage). These wrappers keep one identity for the whole session
   * and forward to the newest callback held in a ref (updated after commit).
   */
  const sendLatest = useRef(handleSend);
  const selectPlaceLatest = useRef(handleSelectPlace);
  const regenerateLatest = useRef(handleRegenerate);
  useEffect(() => {
    sendLatest.current = handleSend;
    selectPlaceLatest.current = handleSelectPlace;
    regenerateLatest.current = handleRegenerate;
  });

  const handleChip = useCallback((value: string) => {
    void sendLatest.current(value);
  }, []);
  const handleSelectPlaceStable = useCallback((rec: Recommendation) => {
    selectPlaceLatest.current(rec);
  }, []);
  const handleRegenerateStable = useCallback(() => {
    regenerateLatest.current();
  }, []);

  /**
   * Tapping a shelf in the trip navigator asks for exactly that category — the
   * same request a traveller would type, phrased so the intent classifier files
   * it as a recommendation turn (and dedupes it when the shelf is already full).
   */
  const handleShelfPick = useCallback(
    (type: ShelfType) => {
      const done = shelfProgress.find((s) => s.type === type)?.state === "done";
      const where = profile.destination?.trim() ? ` in ${profile.destination.trim()}` : "";
      const noun =
        type === "hotel" ? "hotels" : type === "restaurant" ? "restaurants" : "things to do";
      const more = type === "attraction" ? `more things to do${where}` : `more ${noun}${where}`;
      void sendLatest.current(done ? `Show me ${more}` : `Show me ${noun}${where}`);
    },
    [shelfProgress, profile.destination]
  );
  const shelfPickLatest = useRef(handleShelfPick);
  useEffect(() => {
    shelfPickLatest.current = handleShelfPick;
  });
  const handleShelfPickStable = useCallback((type: ShelfType) => {
    shelfPickLatest.current(type);
  }, []);

  useEffect(() => {
    if (initialQuery && !initialized.current && hydrated) {
      initialized.current = true;
      handleSend(initialQuery);
    }
  }, [initialQuery, handleSend, hydrated]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  /**
   * The same capability rail sits in the hero and in the conversation
   * composer. It sends scoped prompts (so a reply is still one shelf) and
   * opens the real route planner for trains, which has no chat equivalent.
   */
  const quickActions = (
    <ChatQuickActions
      destination={profile.destination}
      disabled={loading}
      onSend={handleSend}
      onOpenRoute={() => {
        setView("chat");
        setMapOpen(false);
        setRouteOpen(true);
      }}
    />
  );

  const stageSelectedName = useMemo(() => {
    const f = lastAssistant?.field;
    if (f === "hotel") return profile.hotel;
    if (f === "restaurants") return profile.restaurants;
    if (f === "attractions") return profile.attractions;
    return null;
  }, [lastAssistant, profile]);

  const showMapAside =
    isDesktop &&
    !isEmpty &&
    view === "chat" &&
    !mapCollapsed &&
    !routeOpen &&
    (mapResults.length > 0 || mapRequested);
  const showMapOverlay = !isDesktop && mapOpen && view === "chat" && !routeOpen;
  const [routeMounted, routeClosing] = useExitTransition(routeOpen && view === "chat", 180);
  const [mapMounted, mapClosing] = useExitTransition(showMapOverlay, 180);

  return (
    <div className="flex h-dvh overflow-hidden text-ink [&_input]:text-ink">
      <HomeBackground />
      <ChatSidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNewChat}
        onDelete={handleDelete}
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex-1 flex min-w-0">
        <div className="chat-canvas relative isolate flex-1 flex flex-col min-w-0">
          {isEmpty && (
            <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
              <div className="hero-bg-vignette" />
            </div>
          )}
          <header className="relative z-20 shrink-0 border-b border-white/[0.07] bg-[#0a0a0b]">
            <div className="flex h-12 items-center gap-2 px-4">
              {(sidebarCollapsed || !isDesktop) && (
                <button
                  onClick={() => {
                    if (isDesktop) setSidebarCollapsed(false);
                    else setSidebarOpen(true);
                  }}
                  aria-label="Open navigation"
                  title="Open navigation"
                  className="nav-btn nav-btn-icon shrink-0"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.8}
                      d="M4 6h16M4 12h16M4 18h16"
                    />
                  </svg>
                </button>
              )}

              {isDesktop && !sidebarCollapsed && (
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  aria-label="Close navigation"
                  title="Close navigation"
                  className="nav-btn nav-btn-icon hidden shrink-0 lg:grid"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <rect x="3" y="4" width="18" height="16" rx="2" strokeWidth={1.8} />
                    <path strokeLinecap="round" strokeWidth={1.8} d="M9 4v16m6-11-3 3 3 3" />
                  </svg>
                </button>
              )}

              {view === "explore" ? (
                <span className="flex min-w-0 max-w-56 items-center truncate px-1 py-1 text-[13px] font-semibold tracking-[-0.01em] text-ink">
                  Explore
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleNewChat}
                  className="flex min-w-0 max-w-56 items-center gap-1 rounded-md px-1 py-1 text-left text-[13px] font-semibold tracking-[-0.01em] text-ink transition-colors hover:text-white"
                  title={active?.title || "Start a new chat"}
                >
                  <span className="truncate">
                    {isEmpty ? "New chat" : active?.title || "New chat"}
                  </span>
                  <svg
                    className="h-3 w-3 shrink-0 text-zinc-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="m6 9 6 6 6-6"
                    />
                  </svg>
                </button>
              )}

              <div className="ml-auto flex items-center gap-1">
                {view === "chat" &&
                  isDesktop &&
                  !isEmpty &&
                  (mapResults.length > 0 || mapRequested) &&
                  !routeOpen && (
                  <button
                    onClick={() => setMapCollapsed((v) => !v)}
                    aria-pressed={!mapCollapsed}
                    title={mapCollapsed ? "Show map" : "Hide map"}
                    className="nav-btn"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0zM15 5.764v15M9 3.236v15"
                      />
                    </svg>
                  </button>
                )}
                {view === "chat" && (
                  <button
                    onClick={() => setRouteOpen((v) => !v)}
                    aria-label="Route planner"
                    aria-pressed={routeOpen}
                    title="Route planner"
                    className="nav-btn hidden md:inline-flex"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.8}
                        d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                      />
                    </svg>
                  </button>
                )}
                {!routeMounted && (
                  <button
                    type="button"
                    onClick={() => switchView(view === "chat" ? "explore" : "chat")}
                    className="nav-btn"
                    aria-label={view === "chat" ? "Explore places" : "Back to chat"}
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <circle cx="11" cy="11" r="7" strokeWidth={1.8} />
                      <path strokeLinecap="round" strokeWidth={1.8} d="m16 16 4.5 4.5" />
                    </svg>
                  </button>
                )}
                <Link
                  href="/plan"
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-3.5 text-xs font-semibold text-zinc-900 transition-colors hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 5v14M5 12h14"
                    />
                  </svg>
                  Create a trip
                </Link>
                {!isEmpty && view === "chat" && !routeOpen && (
                  <button
                    onClick={() => setMapOpen(true)}
                    className="nav-btn nav-btn-icon shrink-0 lg:hidden"
                    aria-label="Open map"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                      />
                    </svg>
                    {results.length > 0 && (
                      <span className="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-white text-3xs font-bold leading-4 text-zinc-900 text-center">
                        {results.length}
                      </span>
                    )}
                  </button>
                )}
              </div>
            </div>
          </header>

          {routeMounted ? (
            <div
              className={`relative isolate flex-1 min-h-0 overflow-hidden bg-zinc-950 ${
                routeClosing ? "animate-exit pointer-events-none" : "animate-fade-in"
              }`}
            >
              <HomeBackground variant="absolute" />
              <RoutePlanner onClose={() => setRouteOpen(false)} />
            </div>
          ) : view === "explore" ? (
            <ExploreView
              key={`${initialLoc?.name ?? ""}-${initialLoc?.lat ?? ""}-${initialLoc?.lng ?? ""}`}
              heightClass="flex-1 min-h-0"
              showBackground={false}
              initialLoc={initialLoc}
              initialMapOpen={initialMapOpen}
            />
          ) : isEmpty ? (
            <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-y-auto dark-scroll">
              <ChatHero onSend={handleSend} disabled={loading} actions={quickActions} />
            </div>
          ) : (
            <>
              <div
                ref={scrollRef}
                onScroll={handleScrollList}
                className="flex-1 min-h-0 overflow-y-auto dark-scroll overscroll-contain animate-view-in"
              >
                <div className="mx-auto flex w-full max-w-140 flex-col gap-6 px-4 py-6 md:px-6">
                  {messages.map((msg) => {
                    const msgCardIds = cardIdsByMessage.get(msg.id);
                    return (
                      <ChatMessage
                        key={msg.id}
                        id={msg.id}
                        role={msg.role}
                        content={msg.content}
                        streaming={
                          loading && msg.role === "assistant" && msg.id === lastAssistant?.id
                        }
                        activePlaceId={
                          focusMarkerId && msgCardIds?.has(focusMarkerId) ? focusMarkerId : null
                        }
                        onFocusPlace={handleFocusPlace}
                        onOpenPlace={handleOpenPlace}
                        hoverPlaceId={
                          hoverMarkerId && msgCardIds?.has(hoverMarkerId) ? hoverMarkerId : null
                        }
                        onHoverPlace={setHoverMarkerId}
                        structured={msg.structured}
                        chips={msg.chips}
                        showChips={
                          msg.role === "assistant" && msg.id === lastAssistant?.id && !loading
                        }
                        onChip={handleChip}
                        field={
                          msg.role === "assistant" && msg.id === lastAssistant?.id && !loading
                            ? msg.field
                            : undefined
                        }
                        onSelectPlace={handleSelectPlaceStable}
                        selectedName={stageSelectedName}
                        feedback={msg.feedback}
                        onFeedback={handleFeedback}
                        sources={msg.sources}
                        weather={msg.weather}
                        flights={msg.flights}
                        travelers={travelers}
                        showActions={
                          msg.role === "assistant" &&
                          msg.id === lastAssistant?.id &&
                          !loading &&
                          Boolean(msg.content)
                        }
                        onRegenerate={handleRegenerateStable}
                        shelfProgress={
                          msg.role === "assistant" &&
                          msg.id === lastAssistant?.id &&
                          msgCardIds &&
                          msgCardIds.size > 0
                            ? shelfProgress
                            : undefined
                        }
                        onShelfPick={handleShelfPickStable}
                      />
                    );
                  })}
                </div>
              </div>

              <div className="relative shrink-0">
                <div className="relative mx-auto w-full max-w-140 px-4 pb-safe pt-2 md:px-6">
                  {loading && (
                    <div className="mb-3 flex justify-center animate-fade-in">
                      <button
                        type="button"
                        onClick={() => abortRef.current?.abort()}
                        className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-surface-2 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-white/[0.2] hover:bg-surface-3 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 active:scale-[0.98]"
                      >
                        <span className="h-2 w-2 rounded-[2px] bg-zinc-300" aria-hidden />
                        Stop generating
                      </button>
                    </div>
                  )}
                  <ChatInput
                    onSend={handleSend}
                    disabled={loading}
                    actions={quickActions}
                    placeholder="Ask anything"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {showMapAside && (
          <aside
            ref={asideRef}
            data-map-aside
            style={mapWidth ? { width: mapWidth } : undefined}
            className={`map-aside-in relative hidden lg:block border-l border-hairline h-dvh ${
              mapWidth ? "flex-none" : "w-[44%] min-w-90 max-w-180"
            }`}
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize map panel"
              onPointerDown={startDividerDrag}
              onDoubleClick={() => {
                setMapWidth(null);
                try {
                  localStorage.removeItem("tripcraft:mapw");
                } catch {
                  // ignore
                }
              }}
              title="Drag to resize (double-click to reset)"
              className="absolute left-0 top-0 bottom-0 z-40 w-2 -ml-1 cursor-col-resize touch-none hover:bg-accent/25 active:bg-accent/40 transition-colors"
            />
            <MapPane
              markers={markers}
              results={mapResults}
              focusId={focusMarkerId}
              onFocus={handleFocusPlace}
              hoverId={hoverMarkerId}
              onHoverChange={setHoverMarkerId}
              onOpenDetails={handleOpenPlace}
              onMarkerTap={handleMarkerTap}
              onDismiss={handleDismissFocus}
              onBack={handleCollapseMap}
              showSearch
              showWeather
              city={profile.destination ?? undefined}
              syncToken={detailPlace ? detailPlace.id : ""}
              className="h-full w-full"
            />
          </aside>
        )}
      </div>

      {mapMounted && (
        <MobileMapSheet closing={mapClosing} onClose={handleCloseMapSheet}>
          <MapPane
            markers={markers}
            results={mapResults}
            focusId={focusMarkerId}
            onFocus={handleFocusPlace}
            hoverId={hoverMarkerId}
            onHoverChange={setHoverMarkerId}
            onOpenDetails={handleOpenPlace}
            onMarkerTap={handleMarkerTap}
            onDismiss={handleDismissFocus}
            showSearch
            showWeather
            city={profile.destination ?? undefined}
            syncToken={detailPlace ? detailPlace.id : ""}
            onClose={handleCloseMapSheet}
            className="h-full w-full"
          />
        </MobileMapSheet>
      )}

      <PlaceDetailModal place={detailPlace} onClose={() => setDetailPlace(null)} />
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center">
          <HomeBackground />
          <div className="w-12 h-12 bg-accent-strong rounded-lg animate-pulse" />
        </div>
      }
    >
      <ChatContent />
    </Suspense>
  );
}
