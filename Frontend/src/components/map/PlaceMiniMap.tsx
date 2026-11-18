"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { getBasemapLayers } from "@/lib/mapTiles";
import { categoryIconSvg } from "@/lib/categoryIcons";
import { recMeta, type RecType } from "@/lib/recommendations";

interface PlaceMiniMapProps {
  lat: number;
  lng: number;
  kind: RecType;
  label: string;
  className?: string;
}

/** Small interactive Leaflet map — keeps "view it on a map" inside the app. */
export default function PlaceMiniMap({ lat, lng, kind, label, className = "" }: PlaceMiniMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const map = L.map(el, {
      center: [lat, lng],
      zoom: 15,
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: false,
      zoomSnap: 0.5,
    });

    const configs = getBasemapLayers();
    for (const cfg of configs) {
      L.tileLayer(cfg.url, {
        attribution: cfg.attribution,
        subdomains: cfg.subdomains ?? "abc",
        maxZoom: cfg.maxZoom ?? 19,
        opacity: cfg.opacity ?? 1,
      }).addTo(map);
    }
    L.control.zoom({ position: "bottomright" }).addTo(map);

    const { color } = recMeta(kind);
    const size = kind === "destination" ? 40 : 34;
    const box = size + 8;
    const icon = L.divIcon({
      className: "map-pin-wrap",
      html: `<div class="map-pin" style="--pin:${color}"><div class="map-pin-dot" style="width:${size}px;height:${size}px"><span class="map-pin-glyph">${categoryIconSvg(kind)}</span></div></div>`,
      iconSize: [box, box],
      iconAnchor: [box / 2, box / 2],
    });
    L.marker([lat, lng], { icon, keyboard: false, title: label }).addTo(map);

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      map.remove();
    };
  }, [lat, lng, kind, label]);

  return (
    <div
      ref={containerRef}
      aria-label={`Map showing ${label}`}
      style={{ height: 192 }}
      className={`map-canvas h-48 w-full overflow-hidden rounded-2xl bg-zinc-200 ring-1 ring-white/10 ${className}`}
    />
  );
}
