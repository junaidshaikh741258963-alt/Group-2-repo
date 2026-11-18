"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { getBasemapLayers } from "@/lib/mapTiles";

export interface MiniMapPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface ChatMiniMapProps {
  places: MiniMapPlace[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
}

/**
 * Compact numbered-pin map used inside the chat's mini-map card. Same pin
 * style as the route planner, without clustering or controls — the full map
 * in the right pane (or its expanded view) is one tap away.
 */
export default function ChatMiniMap({ places, activeId = null, onSelect }: ChatMiniMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, {
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
      dragging: true,
    }).setView([20, 0], 2);
    const configs = getBasemapLayers();
    for (const cfg of configs) {
      L.tileLayer(cfg.url, {
        attribution: cfg.attribution,
        subdomains: cfg.subdomains ?? "abc",
        maxZoom: cfg.maxZoom ?? 19,
        opacity: cfg.opacity ?? 1,
      }).addTo(map);
    }
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const points: L.LatLngExpression[] = [];
    places.forEach((p, i) => {
      const marker = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          html: `<div style="display:grid;place-items:center;width:22px;height:22px;border-radius:50% 50% 50% 6px;background:#3b82f6;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.35);color:#fff;font:700 10px/1 system-ui,-apple-system,sans-serif;">${i + 1}</div>`,
          className: "",
          iconSize: [22, 22],
          iconAnchor: [11, 22],
        }),
      })
        .addTo(map)
        .bindTooltip(p.name, { direction: "top", offset: [0, -24] });
      marker.on("click", () => onSelectRef.current?.(p.id));
      markersRef.current.push(marker);
      points.push([p.lat, p.lng]);
    });

    if (points.length === 1) {
      map.setView(points[0], 12);
    } else if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 14 });
    }
    // Leaflet sizes itself before layout settles; nudge it once.
    const t = window.setTimeout(() => map.invalidateSize(), 120);
    return () => window.clearTimeout(t);
  }, [places]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !activeId) return;
    const idx = places.findIndex((p) => p.id === activeId);
    const marker = markersRef.current[idx];
    if (marker) {
      map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 13), { duration: 0.5 });
      marker.openTooltip();
    }
  }, [activeId, places]);

  return (
    <div
      ref={hostRef}
      aria-label="Map of these places"
      className="map-canvas relative isolate h-full w-full overflow-hidden"
    />
  );
}
