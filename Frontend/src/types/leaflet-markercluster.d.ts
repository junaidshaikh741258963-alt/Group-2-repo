import * as L from "leaflet";

declare module "leaflet" {
  interface MarkerClusterGroupOptions extends L.LayerOptions {
    showCoverageOnHover?: boolean;
    zoomToBoundsOnClick?: boolean;
    spiderfyOnMaxZoom?: boolean;
    spiderfyOnEveryZoom?: boolean;
    maxClusterRadius?: number | ((zoom: number) => number);
    iconCreateFunction?: (cluster: MarkerCluster) => L.DivIcon;
  }

  interface MarkerCluster extends L.Marker {
    getChildCount(): number;
    getAllChildMarkers(): L.Marker[];
  }

  interface MarkerClusterGroup extends L.LayerGroup {
    zoomToShowLayer(layer: L.Layer, callback?: () => void): void;
    spiderfy(): void;
    unspiderfy(): void;
  }

  function markerClusterGroup(options?: MarkerClusterGroupOptions): MarkerClusterGroup;
}

declare module "leaflet.markercluster";
