"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { getBasemapLayers } from "@/lib/mapTiles";
import type { Coordinates, RouteResponse } from "@/lib/osrm";

/** A pin for something worth stopping at between origin and destination. */
export interface RouteStopMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  /** Route-order number drawn inside the pin (1-based). */
  index?: number;
  /** Chip colour — defaults to the app's blue. */
  color?: string;
}

interface MapProps {
  origin: Coordinates | null;
  destination: Coordinates | null;
  route: RouteResponse | null;
  stops?: RouteStopMarker[];
  /** Fly to this stop (toggle by passing null to reset). */
  focusStopId?: string | null;
  onStopClick?: (id: string) => void;
}

export default function TravelMap({
  origin,
  destination,
  route,
  stops = [],
  focusStopId = null,
  onStopClick,
}: MapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const routeLayerRef = useRef<L.Polyline | null>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const stopMarkersRef = useRef<L.Marker[]>([]);
  const stopByIdRef = useRef<Map<string, L.Marker>>(new Map());
  const onStopClickRef = useRef(onStopClick);

  useEffect(() => {
    onStopClickRef.current = onStopClick;
  }, [onStopClick]);

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    mapInstanceRef.current = L.map(mapRef.current, {
      center: [20, 0],
      zoom: 2,
      zoomControl: false,
    });
    // Same corner as every other map in the app: top-right, clear of the
    // route controls on the left and consistent with MapView.
    L.control.zoom({ position: "topright" }).addTo(mapInstanceRef.current);

    const configs = getBasemapLayers();
    for (const cfg of configs) {
      L.tileLayer(cfg.url, {
        attribution: cfg.attribution,
        subdomains: cfg.subdomains ?? "abc",
        maxZoom: cfg.maxZoom ?? 19,
        opacity: cfg.opacity ?? 1,
      }).addTo(mapInstanceRef.current);
    }

    return () => {
      mapInstanceRef.current?.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapInstanceRef.current) return;
    const map = mapInstanceRef.current;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    routeLayerRef.current?.remove();

    const createIcon = (color: string) =>
      L.divIcon({
        html: `<div style="width:24px;height:24px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>`,
        className: "",
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

    if (origin) {
      const marker = L.marker([origin.lat, origin.lng], {
        icon: createIcon("#22c55e"),
      })
        .addTo(map)
        .bindPopup("Origin");
      markersRef.current.push(marker);
    }

    if (destination) {
      const marker = L.marker([destination.lat, destination.lng], {
        icon: createIcon("#ef4444"),
      })
        .addTo(map)
        .bindPopup("Destination");
      markersRef.current.push(marker);
    }

    if (route?.routes?.[0]?.geometry?.coordinates) {
      const coords = route.routes[0].geometry.coordinates.map(
        (c) => [c[1], c[0]] as [number, number]
      );
      routeLayerRef.current = L.polyline(coords, {
        color: "#3b82f6",
        weight: 4,
        opacity: 0.8,
      }).addTo(map);

      const bounds = L.latLngBounds(coords);
      if (origin) bounds.extend([origin.lat, origin.lng]);
      if (destination) bounds.extend([destination.lat, destination.lng]);
      map.fitBounds(bounds, { padding: [50, 50] });
    } else if (origin && destination) {
      const bounds = L.latLngBounds([
        [origin.lat, origin.lng],
        [destination.lat, destination.lng],
      ]);
      map.fitBounds(bounds, { padding: [50, 50] });
    } else if (origin) {
      map.setView([origin.lat, origin.lng], 10);
    }
  }, [origin, destination, route]);

  // Stops belong to their own effect: re-running the one above would drop
  // them whenever the route object changes, and re-fitting would fight the
  // "show me this stop" pan below.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    stopMarkersRef.current.forEach((m) => m.remove());
    stopMarkersRef.current = [];
    stopByIdRef.current.clear();

    stops.forEach((stop, i) => {
      const color = stop.color ?? "#3b82f6";
      const badge = stop.index ?? i + 1;
      const marker = L.marker([stop.lat, stop.lng], {
        icon: L.divIcon({
          html: `<div style="display:grid;place-items:center;width:24px;height:24px;border-radius:50% 50% 50% 6px;background:${color};border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.35);color:#fff;font:700 11px/1 system-ui,-apple-system,sans-serif;transform:rotate(0deg);">${badge}</div>`,
          className: "",
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
        zIndexOffset: 300,
      }).addTo(map);
      marker.bindTooltip(stop.label, { direction: "top", offset: [0, -10] });
      marker.on("click", () => onStopClickRef.current?.(stop.id));
      stopMarkersRef.current.push(marker);
      stopByIdRef.current.set(stop.id, marker);
    });
  }, [stops]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !focusStopId) return;
    const marker = stopByIdRef.current.get(focusStopId);
    if (!marker) return;
    const { lat, lng } = marker.getLatLng();
    map.flyTo([lat, lng], Math.max(map.getZoom(), 12), { duration: 0.6 });
    marker.openTooltip();
  }, [focusStopId]);

  return (
    <div
      ref={mapRef}
      /* Map layer: positioned + isolated, so Leaflet's panes/popup/controls
         (raw z-indexes 400–1000) stay inside this box and can never paint
         over an app-level overlay such as the place-detail window (z-50). */
      className="map-canvas relative isolate w-full h-full rounded-xl overflow-hidden border border-white/[0.1]"
      style={{ minHeight: "400px" }}
    />
  );
}
