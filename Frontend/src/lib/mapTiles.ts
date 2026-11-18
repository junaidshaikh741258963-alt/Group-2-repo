export interface BasemapTileLayer {
  url: string;
  attribution: string;
  subdomains?: string;
  maxZoom?: number;
  opacity?: number;
}

const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const OSM_FALLBACK: BasemapTileLayer = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: OSM_ATTRIBUTION,
  maxZoom: 19,
};

/** Plain OSM layer, used when the primary tiles fail (offline/blocked CDN). */
export function getOsmFallbackLayer(): BasemapTileLayer {
  return { ...OSM_FALLBACK };
}

const CARTO_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>';

const ESRI_ATTRIBUTION =
  'Tiles © <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const MAPBOX_ATTRIBUTION =
  '© <a href="https://www.mapbox.com/">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> improve=';

/**
 * Basemap resolution order:
 * 1. NEXT_PUBLIC_MAPTILE_URL — full custom XYZ template
 * 2. NEXT_PUBLIC_MAPTILE_PROVIDER — "osm" (default): the standard, full-colour
 *    OpenStreetMap basemap. Free, keyless, no quota and no CSS recolouring —
 *    the map looks the way OSM draws it.
 *    "esri": light grey canvas. "carto": light CARTO Positron.
 *    "esri-dark": Esri Dark Gray Canvas. "carto-dark": CARTO Dark Matter
 *    (now watermarks tiles without a key). "mapbox" when a token is set.
 * No API key is needed for the default path or "osm".
 */
export function getBasemapLayers(): BasemapTileLayer[] {
  const customUrl = process.env.NEXT_PUBLIC_MAPTILE_URL?.trim();
  if (customUrl) {
    return [
      {
        url: customUrl,
        attribution: process.env.NEXT_PUBLIC_MAPTILE_ATTRIBUTION?.trim() || OSM_ATTRIBUTION,
        subdomains: process.env.NEXT_PUBLIC_MAPTILE_SUBDOMAINS?.trim() || "abcd",
        maxZoom: 20,
      },
    ];
  }

  const provider = (process.env.NEXT_PUBLIC_MAPTILE_PROVIDER || "osm").toLowerCase();

  if (provider === "mapbox") {
    const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN?.trim();
    if (mapboxToken) {
      const style = process.env.NEXT_PUBLIC_MAPBOX_STYLE?.trim() || "mapbox/light-v10";
      return [
        {
          url: `https://api.mapbox.com/styles/v1/${style}/tiles/256/{z}/{x}/{y}?access_token=${encodeURIComponent(mapboxToken)}`,
          attribution: MAPBOX_ATTRIBUTION,
          maxZoom: 22,
        },
      ];
    }
  }

  if (provider === "esri-dark") {
    // Base (land, water, roads) + a transparent reference layer (labels).
    return [
      {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        attribution: ESRI_ATTRIBUTION,
        maxZoom: 19,
      },
      {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
        attribution: ESRI_ATTRIBUTION,
        maxZoom: 19,
      },
    ];
  }

  if (provider === "carto-dark") {
    const cartoKey = process.env.NEXT_PUBLIC_CARTO_API_KEY?.trim();
    return [
      {
        url: `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png${cartoKey ? `?key=${encodeURIComponent(cartoKey)}` : ""}`,
        attribution: CARTO_ATTRIBUTION,
        subdomains: "abcd",
        maxZoom: 20,
      },
    ];
  }

  if (provider === "carto") {
    const cartoKey = process.env.NEXT_PUBLIC_CARTO_API_KEY?.trim();
    return [
      {
        url: `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png${cartoKey ? `?key=${encodeURIComponent(cartoKey)}` : ""}`,
        attribution: CARTO_ATTRIBUTION,
        subdomains: "abcd",
        maxZoom: 20,
      },
    ];
  }

  if (provider === "esri") {
    return [
      {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        attribution: ESRI_ATTRIBUTION,
        maxZoom: 19,
      },
      {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
        attribution: ESRI_ATTRIBUTION,
        maxZoom: 19,
      },
    ];
  }

  return [
    {
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: OSM_ATTRIBUTION,
      maxZoom: 19,
    },
  ];
}
