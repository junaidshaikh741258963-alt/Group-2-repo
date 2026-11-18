"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import { recMeta, type RecType } from "@/lib/recommendations";
import { categoryIconSvg } from "@/lib/categoryIcons";
import { useExitTransition } from "@/lib/useExitTransition";
import { getBasemapLayers, getOsmFallbackLayer } from "@/lib/mapTiles";
import { useMapWeather } from "@/lib/mapWeather";
import MapCard from "@/components/map/MapCard";
import MapClusterStack from "@/components/map/MapClusterStack";

export interface MapMarkerData {
  id: string;
  lat: number;
  lng: number;
  label: string;
  kind: RecType;
  description?: string;
  image?: string;
  rating?: number;
  /** Review count for the card's rating line — rendered as 13k / 14.3k. */
  reviews?: number;
  price?: string;
  link?: string;
  /** "City, Region" line under the card's category (e.g. "Pune, Maharashtra"). */
  city?: string;
  /** Preformatted visit-duration chip, e.g. "~2h" (Phase 4). */
  durationText?: string;
  /** Full tooltip for the chip: range + basis. */
  durationTitle?: string;
}

interface MapViewProps {
  markers: MapMarkerData[];
  focusId: string | null;
  onFocus?: (id: string) => void;
  /** Highlight driven from outside (e.g. hovering a result card). */
  hoverId?: string | null;
  /** Reports marker hover back up so the matching card can highlight. */
  onHoverChange?: (id: string | null) => void;
  /** Opens the full place-details sheet for a marker (optional). */
  onOpenDetails?: (id: string) => void;
  /** Also fired on marker tap (used to scroll chat to the matching card). */
  onMarkerTap?: (id: string) => void;
  /** Closes the open place card (map tap, Escape, close button). */
  onDismiss?: () => void;
  /** Back / collapse button pinned to the map's top-left. */
  onBack?: () => void;
  /** Search button + overlay at the top-left. */
  showSearch?: boolean;
  /** Weather chip at the bottom-left (Open-Meteo, cached per city). */
  showWeather?: boolean;
  /** City name used for the pin pill and the weather chip. */
  city?: string;
  /** Space kept clear at the bottom (chat's card strip); also lifts the chip. */
  bottomInset?: number;
  /** Draw an ordered route line + numbered stops through the markers. */
  showRoute?: boolean;
  /** Show the Leaflet +/- zoom control. */
  zoomControl?: boolean;
  /**
   * Bumped by the owning pane whenever the space around the map changes
   * (bottom strip removed, detail window opened/closed, divider drag).
   * Leaflet only re-measures when told to, so each bump re-runs invalidateSize.
   */
  syncToken?: string;
}

/** Air between a pin's edge and the card that points at it. */
const CARD_GAP = 14;
/** Cards stay this far off the map's edges. */
const EDGE = 10;
/** Half of a pin's footprint — the card never sits on top of it. */
const PIN_R = 18;
/** Extra keep-out under the city pill riding the main pin. */
const PILL_H = 26;
/** Close animation: fade + scale, transform/opacity only. */
const CLOSE_MS = 170;
/** How long a hovered cluster/pin may survive before its overlay retires. */
const HOVER_HIDE_DELAY = 150;

type Side = "right" | "left" | "above" | "below";

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

interface CardLayout {
  side: Side;
  fits: boolean;
}

/** What a hovered cluster is showing: where it sits and what's inside. */
interface ClusterStackData {
  lat: number;
  lng: number;
  items: MapMarkerData[];
  total: number;
}

const box = (l: number, t: number, w: number, h: number): Box => ({ l, t, r: l + w, b: t + h });

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
  const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return w > 0 && h > 0 ? w * h : 0;
}

/** How much of `rect` falls outside the window — 0 means it fits completely. */
function outsideArea(rect: Box, left: number, top: number, right: number, bottom: number): number {
  const full = Math.max(0, rect.r - rect.l) * Math.max(0, rect.b - rect.t);
  const insideW = Math.max(0, Math.min(rect.r, right) - Math.max(rect.l, left));
  const insideH = Math.max(0, Math.min(rect.b, bottom) - Math.max(rect.t, top));
  return full - insideW * insideH;
}

function clampBox(rect: Box, left: number, top: number, right: number, bottom: number): Box {
  const w = rect.r - rect.l;
  const h = rect.b - rect.t;
  const l = right - left >= w ? Math.min(Math.max(rect.l, left), right - w) : left;
  const t = bottom - top >= h ? Math.min(Math.max(rect.t, top), bottom - h) : top;
  return box(l, t, w, h);
}

/**
 * Regions the card must never cover: the control stack (top-right), the
 * attribution (bottom-right), the map's own top-left chrome — widened while
 * the search field is open — the weather chip (bottom-left), the chat's card
 * strip, and the pin itself.
 */
function reservedBoxes(
  size: { x: number; y: number },
  bottomInset: number,
  chromeW: number,
  withWeather: boolean
): Box[] {
  const boxes: Box[] = [
    { l: size.x - 62, t: 0, r: size.x, b: 210 },
    { l: Math.max(0, size.x - 260), t: size.y - 32, r: size.x, b: size.y },
  ];
  if (chromeW > 0) boxes.push({ l: 0, t: 0, r: Math.min(size.x, chromeW), b: 62 });
  if (withWeather) boxes.push({ l: 0, t: size.y - 46, r: 240, b: size.y });
  if (bottomInset > 0) boxes.push({ l: 0, t: size.y - bottomInset, r: size.x, b: size.y });
  return boxes;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Marker markup: a small round dot in the category colour with a white
 * category glyph on top. The selected pin flips to white (see .map-pin-active)
 * so the card standing next to it reads as one selection.
 */
function pinHtml(kind: RecType, label: string, stopNumber?: number, pill?: string | null): string {
  const { color } = recMeta(kind);
  const size = kind === "destination" ? 36 : 32;
  const stop =
    stopNumber != null ? `<span class="map-stop" aria-hidden="true">${stopNumber}</span>` : "";
  const pillHtml = pill ? `<span class="map-pin-pill">${escapeHtml(pill)}</span>` : "";
  return `<div class="map-pin" style="--pin:${color}">
    <div class="map-pin-dot" style="width:${size}px;height:${size}px">
      <span class="map-pin-glyph">${categoryIconSvg(kind)}</span>
    </div>${stop}${pillHtml}
    <span class="sr-only">${escapeHtml(label)}</span>
  </div>`;
}

/** Cluster pill: overlap of category faces + the number of pins inside. */
function clusterHtml(count: number, kinds: RecType[]): string {
  const faces = kinds
    .slice(0, 3)
    .map(
      (kind) =>
        `<span class="map-cluster-face" style="--pin:${recMeta(kind).color}">${categoryIconSvg(
          kind
        )}</span>`
    )
    .join("");
  return `<div class="map-cluster" title="Zoom in">
    <span class="map-cluster-faces" aria-hidden="true">${faces}</span>
    <span class="map-cluster-count">${count}</span>
  </div>`;
}

/** The pin that carries the city name pill: the destination, else the first pin. */
function mainPillFor(markers: MapMarkerData[], city?: string): { id: string; text: string } | null {
  if (markers.length === 0) return null;
  const main = markers.find((m) => m.kind === "destination") ?? markers[0];
  const text = (
    city?.trim() ||
    main.city?.trim() ||
    (main.kind === "destination" ? main.label : "")
  ).trim();
  return text ? { id: main.id, text } : null;
}

function MapWeatherChip({
  city,
  lat,
  lng,
  bottomInset,
}: {
  city?: string;
  lat?: number;
  lng?: number;
  bottomInset: number;
}) {
  const weather = useMapWeather(city, lat ?? null, lng ?? null);
  if (!weather) return null;
  return (
    <div className="map-weather" style={{ bottom: `${12 + bottomInset}px` }} role="status">
      <svg className="map-weather-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M10 13.5V5.75a2 2 0 1 1 4 0V13.5a4 4 0 1 1-4 0Z"
          stroke="currentColor"
          strokeWidth="1.7"
        />
      </svg>
      <span className="map-weather-temp">{weather.tempC}°C</span>
      <span className="map-weather-label">{weather.label}</span>
    </div>
  );
}

function MapView({
  markers,
  focusId,
  onFocus,
  hoverId,
  onHoverChange,
  onOpenDetails,
  onMarkerTap,
  onDismiss,
  onBack,
  showSearch = false,
  showWeather = false,
  city,
  bottomInset = 0,
  showRoute = false,
  zoomControl = true,
  syncToken,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const routeRef = useRef<L.LayerGroup | null>(null);
  const markerByIdRef = useRef<Map<string, L.Marker>>(new Map());
  const cardElRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<MapMarkerData[]>(markers);
  const baseZRef = useRef<Map<string, number>>(new Map());
  const prevFocusRef = useRef<string | null>(null);
  const sigRef = useRef<string>("");
  const contentSigRef = useRef<string>("");
  const focusIdRef = useRef<string | null>(focusId);
  const openIdRef = useRef<string | null>(null);
  const searchOpenRef = useRef(false);
  const markerHoverRef = useRef<string | null>(null);
  const hoverIdRef = useRef<string | null>(hoverId ?? null);
  const stackHoverRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const stackElRef = useRef<HTMLDivElement | null>(null);
  const stackDataRef = useRef<ClusterStackData | null>(null);
  const onFocusRef = useRef(onFocus);
  const onMarkerTapRef = useRef(onMarkerTap);
  const onHoverChangeRef = useRef(onHoverChange);
  const onOpenDetailsRef = useRef(onOpenDetails);
  const onDismissRef = useRef(onDismiss);
  const locateMarkerRef = useRef<L.CircleMarker | null>(null);
  /** Auto-pan runs once per opened card — never in a move/pan loop. */
  const pannedForRef = useRef<string | null>(null);
  const lastLayoutRef = useRef<CardLayout | null>(null);
  const reducedMotionRef = useRef(false);

  const [markerHover, setMarkerHover] = useState<string | null>(null);
  /** Last pin hovered — anchors the preview card while it fades out. */
  const [lastPreviewId, setLastPreviewId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [wheelHint, setWheelHint] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** Cards floating over the cluster under the cursor. */
  const [clusterStack, setClusterStack] = useState<ClusterStackData | null>(null);

  const bottomInsetRef = useRef(bottomInset);
  const showWeatherRef = useRef(showWeather);
  /** Width of the top-left chrome the card has to clear (grows while searching). */
  const chromeRef = useRef(0);
  const mainPillRef = useRef<{ id: string; text: string } | null>(null);
  const pillIdsRef = useRef<Set<string>>(new Set());

  // The pane bumps syncToken whenever the space around the map changes: the
  // bottom strip is gone (full-height panel), and the place-detail window
  // opening/closing shifts the layout. Leaflet only re-measures when asked.
  useEffect(() => {
    if (!syncToken) return;
    const map = mapRef.current;
    if (!map) return;
    const t = window.setTimeout(() => map.invalidateSize(), 60);
    return () => window.clearTimeout(t);
  }, [syncToken]);

  useEffect(() => {
    onFocusRef.current = onFocus;
  }, [onFocus]);
  useEffect(() => {
    onMarkerTapRef.current = onMarkerTap;
  }, [onMarkerTap]);
  useEffect(() => {
    onHoverChangeRef.current = onHoverChange;
  }, [onHoverChange]);
  useEffect(() => {
    onOpenDetailsRef.current = onOpenDetails;
  }, [onOpenDetails]);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reducedMotionRef.current = mq.matches;
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const mainPill = useMemo(() => mainPillFor(markers, city), [markers, city]);

  /* ————— One open card at a time: hovering a pin previews it, clicking
     pins it. The hovered pin wins while the cursor is on it, so the clicked
     card comes back as soon as the pointer wanders off. ————— */
  const focusedId = focusId && focusId !== dismissed ? focusId : null;
  const openId = markerHover ?? focusedId;
  const openMarker = openId ? (markers.find((m) => m.id === openId) ?? null) : null;
  const [cardMounted, cardClosing] = useExitTransition(Boolean(openId), CLOSE_MS);
  /**
   * Keeps the place on screen while it fades out: `dismissed` anchors a
   * clicked card the user closed, `lastPreviewId` a hover preview that just
   * ended — both are state, so no ref is read during render.
   */
  const cardMarker =
    openMarker ??
    (dismissed ? (markers.find((m) => m.id === dismissed) ?? null) : null) ??
    (lastPreviewId ? (markers.find((m) => m.id === lastPreviewId) ?? null) : null);

  /**
   * Mirror this render's values into refs — after render, before paint, and
   * ahead of every layout effect that positions the card from them.
   */
  useLayoutEffect(() => {
    focusIdRef.current = focusId;
    hoverIdRef.current = hoverId ?? null;
    markersRef.current = markers;
    bottomInsetRef.current = bottomInset;
    showWeatherRef.current = showWeather;
    chromeRef.current = !onBack && !showSearch ? 0 : searchOpen ? 470 : 170;
    mainPillRef.current = mainPill;
    pillIdsRef.current = mainPill ? new Set([mainPill.id]) : new Set();
    openIdRef.current = openId;
    searchOpenRef.current = searchOpen;
  });

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const applyMarkerHover = useCallback((id: string | null) => {
    if (markerHoverRef.current === id) return;
    const prev = markerHoverRef.current;
    markerHoverRef.current = id;
    setMarkerHover(id);
    // Remember the preview that just closed — it anchors the card while it
    // fades out (and is deliberately kept out of `dismissed`, which belongs
    // to the clicked card only).
    if (!id && prev) setLastPreviewId(prev);
    // A pin card and a cluster stack never show at once.
    if (id) setClusterStack(null);
    onHoverChangeRef.current?.(id);
  }, []);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      if (stackHoverRef.current) return;
      applyMarkerHover(null);
      setClusterStack(null);
    }, HOVER_HIDE_DELAY);
  }, [cancelHide, applyMarkerHover]);

  /** Focus a place: opens its card and tells the chat to scroll to it. */
  const focusPlace = useCallback(
    (id: string) => {
      cancelHide();
      setDismissed(null);
      pannedForRef.current = null;
      onFocusRef.current?.(id);
      onMarkerTapRef.current?.(id);
    },
    [cancelHide]
  );

  /** Close whatever card is open: a hover preview just hides, the focused
   *  (clicked) card is dismissed so it doesn't pop straight back. */
  const closeCard = useCallback(() => {
    const id = openIdRef.current;
    if (!id) return;
    pannedForRef.current = null;
    if (id === focusIdRef.current) {
      setDismissed(id);
      onDismissRef.current?.();
    } else {
      applyMarkerHover(null);
    }
  }, [applyMarkerHover]);

  const openCardDetails = useCallback((id: string) => {
    onOpenDetailsRef.current?.(id);
  }, []);

  const handleCardEnter = useCallback(
    (id: string) => {
      cancelHide();
      applyMarkerHover(id);
    },
    [cancelHide, applyMarkerHover]
  );

  const handleCardLeave = useCallback(() => {
    scheduleHide();
  }, [scheduleHide]);

  const handleCardSelect = useCallback(
    (id: string) => {
      focusPlace(id);
    },
    [focusPlace]
  );

  /** Pin the cluster stack above (or below) its bubble, clamped into view. */
  const positionStack = useCallback(() => {
    const el = stackElRef.current;
    const map = mapRef.current;
    const data = stackDataRef.current;
    if (!el || !map || !data) return;
    const pt = map.latLngToContainerPoint([data.lat, data.lng]);
    const size = map.getSize();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const roomAbove = pt.y - 30;
    const roomBelow = size.y - pt.y - 30;
    const above = roomAbove >= h || roomAbove >= roomBelow;
    const x =
      size.x > w + 12 ? Math.min(Math.max(pt.x, w / 2 + 6), size.x - w / 2 - 6) : size.x / 2;
    el.style.setProperty("--stack-x", `${x}px`);
    el.style.setProperty("--stack-y", `${pt.y}px`);
    el.classList.toggle("map-stack-below", !above);
    el.classList.toggle(
      "map-stack-off",
      pt.x < -w || pt.x > size.x + w || pt.y < -h - 30 || pt.y > size.y + 30
    );
  }, []);

  /**
   * Place the open card beside its pin — on whichever of the four sides has
   * room, inside the map, and clear of the pin, the control stack, the
   * attribution and the chrome. Reads sizes first, writes styles after.
   */
  const layoutCard = useCallback((): CardLayout | null => {
    const map = mapRef.current;
    const el = cardElRef.current;
    const id = openIdRef.current;
    if (!map || !el || !id) {
      lastLayoutRef.current = null;
      return null;
    }
    const marker = markersRef.current.find((m) => m.id === id);
    if (!marker) {
      lastLayoutRef.current = null;
      return null;
    }

    const size = map.getSize();
    const pt = map.latLngToContainerPoint([marker.lat, marker.lng]);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const inset = bottomInsetRef.current;
    const left = EDGE;
    const top = EDGE;
    const right = Math.max(left, size.x - EDGE);
    const bottom = Math.max(top, size.y - EDGE - inset);

    // The pin (and its city pill) is a keep-out: no side may cover it.
    const keep: Box = {
      l: pt.x - PIN_R - CARD_GAP,
      t: pt.y - PIN_R - CARD_GAP,
      r: pt.x + PIN_R + CARD_GAP,
      b: pt.y + PIN_R + CARD_GAP + (pillIdsRef.current.has(id) ? PILL_H : 0),
    };
    const reserved = reservedBoxes(size, inset, chromeRef.current, showWeatherRef.current);

    const candidates: Array<{ side: Side; rect: Box }> = [
      { side: "right", rect: box(pt.x + PIN_R + CARD_GAP, pt.y - h / 2, w, h) },
      { side: "left", rect: box(pt.x - PIN_R - CARD_GAP - w, pt.y - h / 2, w, h) },
      { side: "above", rect: box(pt.x - w / 2, pt.y - PIN_R - CARD_GAP - h, w, h) },
      { side: "below", rect: box(pt.x - w / 2, pt.y + PIN_R + CARD_GAP, w, h) },
    ];

    let best: { side: Side; rect: Box; score: number } | null = null;
    for (const candidate of candidates) {
      const rect = clampBox(candidate.rect, left, top, right, bottom);
      let score = outsideArea(rect, left, top, right, bottom);
      for (const reservedBox of reserved) score += overlapArea(rect, reservedBox);
      score += overlapArea(rect, keep);
      if (!best || score < best.score) best = { side: candidate.side, rect, score };
      if (best.score === 0) break;
    }
    if (!best) return null;

    const off = pt.x < -PIN_R || pt.x > size.x + PIN_R || pt.y < -PIN_R || pt.y > size.y + PIN_R;

    el.style.setProperty("--card-l", `${best.rect.l}px`);
    el.style.setProperty("--card-t", `${best.rect.t}px`);
    el.style.setProperty("--card-px", `${Math.min(Math.max(pt.x - best.rect.l, 0), w)}px`);
    el.style.setProperty("--card-py", `${Math.min(Math.max(pt.y - best.rect.t, 0), h)}px`);
    for (const side of ["right", "left", "above", "below"] as Side[]) {
      el.classList.toggle(`map-card-side-${side}`, best.side === side && !off);
    }
    el.classList.toggle("map-card-off", off);

    const layout: CardLayout = { side: best.side, fits: best.score === 0 };
    lastLayoutRef.current = layout;
    return layout;
  }, []);

  /**
   * autoPan: if no side fits where the pin stands, nudge the map just enough
   * (with padding) for the card to land fully inside — then the next layout
   * pass places it. Runs at most once per opened card.
   */
  const ensureCardRoom = useCallback(() => {
    const map = mapRef.current;
    const layout = lastLayoutRef.current;
    const id = openIdRef.current;
    if (!map || !layout || layout.fits || !id || pannedForRef.current === id) return;
    // Hover previews never move the map — the layout clamps them into view,
    // and panning under the cursor would fight the user's mouse.
    if (id !== focusIdRef.current) return;
    const marker = markersRef.current.find((m) => m.id === id);
    if (!marker) return;
    const size = map.getSize();
    const el = cardElRef.current;
    const w = el?.offsetWidth ?? 300;
    const h = el?.offsetHeight ?? 360;
    const inset = bottomInsetRef.current;
    const padL = EDGE + (layout.side === "left" ? w + CARD_GAP : 0);
    const padR = EDGE + (layout.side === "right" ? w + CARD_GAP : 0);
    const padT = EDGE + (layout.side === "above" ? h + CARD_GAP : 0);
    const padB = EDGE + inset + (layout.side === "below" ? h + CARD_GAP : 0);
    // Nothing to gain when the map is smaller than the padding box itself.
    if (padL + padR >= size.x || padT + padB >= size.y) return;
    pannedForRef.current = id;
    map.panInside([marker.lat, marker.lng], {
      paddingTopLeft: [padL, padT],
      paddingBottomRight: [padR, padB],
      animate: !reducedMotionRef.current,
      duration: 0.35,
    });
  }, []);

  const runEnsure = useCallback(() => {
    layoutCard();
    ensureCardRoom();
  }, [layoutCard, ensureCardRoom]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const surface = containerRef.current;

    const map = L.map(surface, {
      center: [20, 0],
      zoom: 2,
      zoomControl: false,
      attributionControl: true,
      zoomSnap: 0.5,
      // Wheel zoom arms on first click so page/trackpad scroll is never hijacked.
      scrollWheelZoom: false,
    });
    mapRef.current = map;

    /* ————— Basemap —————
       One configured basemap for the life of the map; the only switch left is
       the automatic fall back to plain OSM when the primary tiles fail. */
    const tileLayers: L.TileLayer[] = [];
    let tileErrors = 0;
    let swappedToOsm = false;

    const wireTileErrors = (layer: L.TileLayer) => {
      layer.on("tileerror", () => {
        tileErrors += 1;
        if (tileErrors >= 12 && !swappedToOsm) {
          swappedToOsm = true;
          applyBasemap(true);
        }
      });
    };

    const applyBasemap = (useOsmFallback = false) => {
      for (const layer of tileLayers) {
        layer.off("tileerror");
        map.removeLayer(layer);
      }
      tileLayers.length = 0;
      const configs = useOsmFallback ? [getOsmFallbackLayer()] : getBasemapLayers();
      for (const cfg of configs) {
        const layer = L.tileLayer(cfg.url, {
          attribution: cfg.attribution,
          subdomains: cfg.subdomains ?? "abc",
          maxZoom: cfg.maxZoom ?? 19,
          opacity: cfg.opacity ?? 1,
        }).addTo(map);
        wireTileErrors(layer);
        tileLayers.push(layer);
      }
    };
    applyBasemap();

    /* ————— Control stack (right): locate me, zoom — 8px gaps ————— */
    const makeCtrlButton = (
      className: string,
      title: string,
      label: string,
      inner: string,
      onClick: (btn: HTMLButtonElement) => void
    ) => {
      const ctrl = new L.Control({ position: "topright" });
      ctrl.onAdd = () => {
        const btn = L.DomUtil.create("button", className) as HTMLButtonElement;
        btn.type = "button";
        btn.title = title;
        btn.setAttribute("aria-label", label);
        btn.innerHTML = inner;
        L.DomEvent.on(btn, "click", (e) => {
          L.DomEvent.stopPropagation(e);
          onClick(btn);
        });
        return btn;
      };
      return ctrl;
    };

    const locateInner =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>';

    makeCtrlButton("map-ctrl-btn", "Show my location", "Show my location", locateInner, (btn) => {
      if (!navigator.geolocation) {
        btn.title = "Location unavailable";
        return;
      }
      btn.classList.add("is-active");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          btn.classList.remove("is-active");
          const m = mapRef.current;
          if (!m) return;
          locateMarkerRef.current?.remove();
          const dot = L.circleMarker([pos.coords.latitude, pos.coords.longitude], {
            radius: 8,
            color: "#ffffff",
            weight: 2,
            fillColor: "#3b82f6",
            fillOpacity: 1,
          });
          dot.addTo(m);
          locateMarkerRef.current = dot;
          m.flyTo([pos.coords.latitude, pos.coords.longitude], Math.max(m.getZoom(), 14), {
            duration: reducedMotionRef.current ? 0 : 0.8,
          });
        },
        () => {
          btn.classList.remove("is-active");
          btn.title = "Location unavailable";
          window.setTimeout(() => {
            btn.title = "Show my location";
          }, 2000);
        },
        { enableHighAccuracy: false, timeout: 8000 }
      );
    }).addTo(map);

    if (zoomControl) L.control.zoom({ position: "topright" }).addTo(map);

    /* ————— Pins ————— */
    const cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      spiderfyOnMaxZoom: true,
      maxClusterRadius: 54,
      iconCreateFunction: (c) => {
        const kinds: RecType[] = c
          .getAllChildMarkers()
          .map((child) => (child as L.Marker & { recId?: string }).recId)
          .filter((rid): rid is string => Boolean(rid))
          .map((rid) => markersRef.current.find((m) => m.id === rid)?.kind)
          .filter((kind): kind is RecType => Boolean(kind));
        return L.divIcon({
          html: clusterHtml(c.getChildCount(), kinds),
          className: "map-cluster-wrap",
          iconSize: [82, 34],
          iconAnchor: [41, 17],
        });
      },
    });
    cluster.addTo(map);
    clusterRef.current = cluster;

    const route = L.layerGroup().addTo(map);
    routeRef.current = route;

    let raf = 0;
    const followOverlays = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        positionStack();
        layoutCard();
      });
    };
    const enableWheel = () => {
      map.scrollWheelZoom.enable();
      setWheelHint(false);
    };
    const onMapClick = () => {
      enableWheel();
      closeCard();
    };
    map.on("move zoom resize", followOverlays);
    map.on("moveend", runEnsure);
    map.on("click", onMapClick);
    // Escape closes the open card (the search overlay claims it first).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (searchOpenRef.current) {
        e.preventDefault();
        setSearchOpen(false);
        setQuery("");
        return;
      }
      if (openIdRef.current) {
        e.preventDefault();
        closeCard();
      }
    };
    window.addEventListener("keydown", onKey);

    // Hovering a cluster reveals what's inside it as a stack of cards
    // (markercluster's own coverage box stays off).
    const showClusterStack = (e: L.LeafletEvent) => {
      const layer = (e as unknown as { layer?: L.MarkerCluster }).layer;
      if (!layer || typeof layer.getAllChildMarkers !== "function") return;
      const children = layer.getAllChildMarkers();
      const ids = new Set(
        children.map((c) => (c as L.Marker & { recId?: string }).recId).filter(Boolean)
      );
      const items = markersRef.current.filter((m) => ids.has(m.id));
      if (items.length === 0) return;
      const ll = layer.getLatLng();
      stackDataRef.current = { lat: ll.lat, lng: ll.lng, items, total: children.length };
      cancelHide();
      applyMarkerHover(null);
      setClusterStack(stackDataRef.current);
    };
    const hideClusterStack = () => scheduleHide();
    cluster.on("clustermouseover", showClusterStack);
    cluster.on("clustermouseout", hideClusterStack);
    // User drags dismiss hover overlays (the open card stays put).
    map.on("dragstart", () => {
      const pm = markerHoverRef.current;
      if (pm && pm !== focusIdRef.current) applyMarkerHover(null);
      setClusterStack(null);
    });

    // Layout changes (expand, divider drag, header) need an explicit nudge:
    // one now, one after any CSS transition has settled.
    let sizeRaf = 0;
    let sizeTimer = 0;
    const ro = new ResizeObserver(() => {
      if (sizeRaf) cancelAnimationFrame(sizeRaf);
      sizeRaf = requestAnimationFrame(() => {
        sizeRaf = 0;
        map.invalidateSize();
        layoutCard();
      });
      window.clearTimeout(sizeTimer);
      sizeTimer = window.setTimeout(() => {
        map.invalidateSize();
        layoutCard();
      }, 320);
    });
    ro.observe(surface);

    const markerMap = markerByIdRef.current;
    return () => {
      ro.disconnect();
      cancelAnimationFrame(sizeRaf);
      window.clearTimeout(sizeTimer);
      window.removeEventListener("keydown", onKey);
      if (raf) cancelAnimationFrame(raf);
      cancelHide();
      map.off("move zoom resize", followOverlays);
      map.off("moveend", runEnsure);
      map.off("click", onMapClick);
      cluster.off("clustermouseover", showClusterStack);
      cluster.off("clustermouseout", hideClusterStack);
      map.remove();
      mapRef.current = null;
      clusterRef.current = null;
      routeRef.current = null;
      markerMap.clear();
      // The map instance is gone; the marker/route layers it held go with it.
      // Clear the render signatures so the marker effect repopulates the next
      // instance — without this, React's StrictMode/HMR double-invoke leaves
      // the fresh map empty and nothing ever appears on screen.
      contentSigRef.current = "";
      sigRef.current = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ————— Only the open card is positioned ————— */
  // Re-place whenever anything the layout actually reads changes: the open
  // card (or the marker it points at), the pin set, the card's own content,
  // the bottom inset, and the reserved chrome (search overlay / top buttons /
  // weather chip). Map move/zoom/resize and element resizes drive their own
  // passes above — this used to also run on EVERY render, forcing a layout
  // read (offsetWidth/Height) per render for nothing.
  useLayoutEffect(() => {
    layoutCard();
  }, [
    layoutCard,
    openId,
    cardMarker,
    markers,
    city,
    bottomInset,
    searchOpen,
    showWeather,
    onBack,
    showSearch,
  ]);

  // The card grows when its city/area line arrives — re-place it.
  useEffect(() => {
    const el = cardElRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      layoutCard();
      ensureCardRoom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [layoutCard, ensureCardRoom, openId]);

  // The stack can unmount without firing mouseleave when the cursor steps off
  // the cluster; reset the hover flag so hide-timers are never stuck.
  useEffect(() => {
    stackHoverRef.current = false;
    return () => {
      stackHoverRef.current = false;
    };
  }, [clusterStack]);

  useLayoutEffect(() => {
    stackDataRef.current = clusterStack;
    positionStack();
  }, [clusterStack, positionStack]);

  /** Icon for a pin: coloured dot, white glyph, optional city pill. */
  const buildIcon = useCallback(
    (m: MapMarkerData, index: number) => {
      const size = m.kind === "destination" ? 36 : 32;
      const pill = mainPillRef.current?.id === m.id ? mainPillRef.current.text : null;
      return L.divIcon({
        html: pinHtml(m.kind, m.label, showRoute ? index + 1 : undefined, pill),
        className: "map-pin-wrap",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
    },
    [showRoute]
  );

  /** Re-apply focus/hover rings after any icon swap (setIcon replaces the node). */
  const applyPinStates = useCallback(() => {
    const focus = focusIdRef.current;
    const hover = markerHoverRef.current ?? hoverIdRef.current;
    for (const [id, marker] of markerByIdRef.current) {
      const pin = marker.getElement()?.querySelector(".map-pin");
      if (!pin) continue;
      pin.classList.toggle("map-pin-active", id === focus);
      pin.classList.toggle("map-pin-hover", id === hover && id !== focus);
      const base = baseZRef.current.get(id) ?? 0;
      marker.setZIndexOffset(id === focus ? 1000 : id === hover ? 900 : base);
    }
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const cluster = clusterRef.current;
    const routeLayer = routeRef.current;
    if (!map || !cluster || !routeLayer) return;

    // Pins only render these fields. When they're unchanged (e.g. every
    // streaming token re-creates the results array upstream) skip the full
    // teardown so the pins never flicker or thrash the DOM.
    const pill = mainPillRef.current;
    const contentSig =
      markers.map((m) => `${m.id}|${m.lat}|${m.lng}|${m.kind}|${m.label}`).join("§") +
      `#${pill?.id ?? ""}|${pill?.text ?? ""}`;
    if (contentSig === contentSigRef.current) return;
    contentSigRef.current = contentSig;

    cluster.clearLayers();
    routeLayer.clearLayers();
    markerByIdRef.current.clear();
    baseZRef.current.clear();

    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      const dest = m.kind === "destination";
      const baseZ = dest ? 400 : 0;
      const marker = L.marker([m.lat, m.lng], {
        icon: buildIcon(m, i),
        zIndexOffset: baseZ,
      }) as L.Marker & { recId?: string };
      // Back-pointer used when a cluster reveals its contents on hover.
      marker.recId = m.id;
      marker.on("click", () => focusPlace(m.id));
      marker.on("mouseover", () => {
        cancelHide();
        applyMarkerHover(m.id);
      });
      marker.on("mouseout", scheduleHide);
      marker.addTo(cluster);
      markerByIdRef.current.set(m.id, marker);
      baseZRef.current.set(m.id, baseZ);
    }

    // Ordered route line + casing through the stops.
    if (showRoute && markers.length >= 2) {
      const latlngs = markers.map((m) => [m.lat, m.lng] as [number, number]);
      L.polyline(latlngs, {
        color: "#020617",
        weight: 6,
        opacity: 0.75,
        interactive: false,
      }).addTo(routeLayer);
      L.polyline(latlngs, {
        color: "#60a5fa",
        weight: 3,
        opacity: 0.95,
        interactive: false,
      }).addTo(routeLayer);
    }

    if (markerHoverRef.current && !markers.some((m) => m.id === markerHoverRef.current)) {
      applyMarkerHover(null);
    }

    const sig = markers.map((m) => m.id).join("|");
    if (sig !== sigRef.current) {
      const isNewPlaces =
        sigRef.current === "" || markers.some((m) => !sigRef.current.split("|").includes(m.id));
      sigRef.current = sig;
      if (markers.length === 0) {
        map.setView([20, 0], 2, { animate: false });
      } else if (isNewPlaces && focusIdRef.current === prevFocusRef.current) {
        const bounds = L.latLngBounds(markers.map((m) => [m.lat, m.lng] as [number, number]));
        map.fitBounds(bounds, {
          padding: [40, 40],
          maxZoom: 14,
          animate: !reducedMotionRef.current,
          duration: reducedMotionRef.current ? 0 : 0.6,
        });
      }
    }
  }, [
    markers,
    showRoute,
    cancelHide,
    applyMarkerHover,
    scheduleHide,
    buildIcon,
    applyPinStates,
    focusPlace,
  ]);

  useEffect(() => {
    applyPinStates();
  }, [focusId, markerHover, hoverId, markers, applyPinStates]);

  /* Flying to a pin: only when it is out of view (or the cluster hides it),
     so tapping a visible pin just opens its card. */
  useEffect(() => {
    if (!focusId || focusId === prevFocusRef.current) {
      prevFocusRef.current = focusId;
      return;
    }
    const map = mapRef.current;
    const marker = markerByIdRef.current.get(focusId);
    // The pin can arrive after the card click — for example when a card came
    // without coordinates and they are geocoded on demand, or while the map is
    // still mounting. Don't consume the focus yet: the effect runs again when
    // `markers` change, and then the late pin still flies into view.
    if (!map || !marker) return;
    prevFocusRef.current = focusId;
    setDismissed(null);
    pannedForRef.current = null;

    const reveal = () => {
      const m = mapRef.current;
      const mk = markerByIdRef.current.get(focusId);
      if (!m || !mk) return;
      const target = mk.getLatLng();
      const visible = m.getBounds().pad(-0.08).contains(target) && m.getZoom() >= 10;
      if (!visible) {
        m.flyTo(target, Math.max(m.getZoom(), 13), {
          duration: reducedMotionRef.current ? 0 : 0.85,
        });
      }
      m.off("moveend", runEnsure);
      m.once("moveend", runEnsure);
      runEnsure();
    };

    // Reveal markers hidden inside a cluster before flying to them — but only
    // while the cluster is actually on the map.
    const cluster = clusterRef.current;
    if (cluster && map.hasLayer(cluster) && typeof cluster.zoomToShowLayer === "function") {
      cluster.zoomToShowLayer(marker, reveal);
    } else {
      reveal();
    }
  }, [focusId, markers, runEnsure]);

  const handleStackEnter = useCallback(() => {
    cancelHide();
    stackHoverRef.current = true;
  }, [cancelHide]);
  const handleStackLeave = useCallback(() => {
    stackHoverRef.current = false;
    scheduleHide();
  }, [scheduleHide]);
  const handleStackSelect = useCallback(
    (id: string) => {
      cancelHide();
      stackHoverRef.current = false;
      setClusterStack(null);
      focusPlace(id);
    },
    [cancelHide, focusPlace]
  );

  /* ————— Top-left search ————— */
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Focus only: the query itself is cleared by the close paths (toggle,
  // Escape, picking a result), never from inside an effect.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!searchOpen || q.length < 1) return [];
    return markers.filter((m) => m.label.toLowerCase().includes(q)).slice(0, 6);
  }, [searchOpen, query, markers]);

  const toggleSearch = useCallback(() => {
    if (searchOpenRef.current) setQuery("");
    setSearchOpen((v) => !v);
  }, []);

  const pickSearchResult = useCallback(
    (id: string) => {
      setSearchOpen(false);
      setQuery("");
      focusPlace(id);
    },
    [focusPlace]
  );

  const weatherAnchor = useMemo(() => {
    const main = markers.find((m) => m.kind === "destination") ?? markers[0];
    return main ? { lat: main.lat, lng: main.lng } : null;
  }, [markers]);
  /** City drives the chip's cache key; without one the fetch is skipped. */
  const weatherCity = city?.trim() || undefined;

  return (
    <div className="absolute inset-0 z-0 overflow-hidden isolate" aria-label="Map">
      <div ref={containerRef} className="absolute inset-0 map-surface" />

      {cardMounted && cardMarker && (
        <div className="map-card-layer">
          <MapCard
            key={cardMarker.id}
            marker={cardMarker}
            stopNumber={
              showRoute ? markers.findIndex((m) => m.id === cardMarker.id) + 1 : undefined
            }
            closing={cardClosing}
            hostRef={cardElRef}
            onEnter={handleCardEnter}
            onLeave={handleCardLeave}
            onSelect={handleCardSelect}
            onOpenDetails={openCardDetails}
            canOpenDetails={Boolean(onOpenDetails)}
          />
        </div>
      )}

      {(onBack || showSearch) && (
        <div className="map-topleft">
          {onBack && (
            <button
              type="button"
              className="map-ctrl-btn"
              onClick={onBack}
              title="Back"
              aria-label="Back"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          {showSearch && (
            <button
              type="button"
              className={`map-ctrl-btn${searchOpen ? " is-active" : ""}`}
              onClick={toggleSearch}
              title="Search places"
              aria-label="Search places"
              aria-expanded={searchOpen}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="6.5" />
                <path strokeLinecap="round" d="m16 16 4.5 4.5" />
              </svg>
            </button>
          )}

          {showSearch && searchOpen && (
            <div className="map-search">
              <div className="map-search-field">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="6.5" />
                  <path strokeLinecap="round" d="m16 16 4.5 4.5" />
                </svg>
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search places on the map"
                  aria-label="Search places on the map"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && searchMatches[0]) {
                      e.preventDefault();
                      pickSearchResult(searchMatches[0].id);
                    }
                  }}
                />
              </div>
              {searchMatches.length > 0 && (
                <ul className="map-search-list">
                  {searchMatches.map((m) => (
                    <li key={m.id}>
                      <button type="button" onClick={() => pickSearchResult(m.id)}>
                        <span
                          className="map-search-dot"
                          style={{ background: recMeta(m.kind).color }}
                          aria-hidden="true"
                        />
                        <span className="truncate">{m.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {showWeather && weatherAnchor && (
        <MapWeatherChip
          city={weatherCity}
          lat={weatherAnchor.lat}
          lng={weatherAnchor.lng}
          bottomInset={bottomInset}
        />
      )}

      {clusterStack && clusterStack.items.length > 0 && (
        <MapClusterStack
          ref={stackElRef}
          items={clusterStack.items}
          total={clusterStack.total}
          onEnter={handleStackEnter}
          onLeave={handleStackLeave}
          onSelect={handleStackSelect}
        />
      )}

      {wheelHint && markers.length > 0 && (
        <div className="map-wheel-hint" aria-hidden="true">
          Click map to enable scroll zoom
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {openMarker ? `${openMarker.label} card open` : ""}
      </span>
    </div>
  );
}

export default memo(MapView);
