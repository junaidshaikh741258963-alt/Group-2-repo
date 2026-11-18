export interface RouteInfo {
  distance: number;
  duration: number;
  distanceText: string;
  durationText: string;
  geometry?: [number, number][];
}

export interface TransportOption {
  type: string;
  description: string;
  estimatedDuration: string;
  estimatedCost: string;
  notes: string;
}

export async function getDrivingRoute(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<RouteInfo | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${originLng},${originLat};${destLng},${destLat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.routes || data.routes.length === 0) return null;

    const route = data.routes[0];
    return {
      distance: route.distance,
      duration: route.duration,
      distanceText: formatDistance(route.distance),
      durationText: formatDuration(route.duration),
      geometry: route.geometry?.coordinates,
    };
  } catch {
    return null;
  }
}

export async function getWalkingRoute(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<RouteInfo | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/foot/${originLng},${originLat};${destLng},${destLat}?overview=false`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.routes || data.routes.length === 0) return null;

    const route = data.routes[0];
    return {
      distance: route.distance,
      duration: route.duration,
      distanceText: formatDistance(route.distance),
      durationText: formatDuration(route.duration),
    };
  } catch {
    return null;
  }
}

export async function getMultiStopRoute(
  stops: Array<{ lat: number; lng: number }>
): Promise<RouteInfo | null> {
  if (stops.length < 2) return null;
  const coords = stops.map((s) => `${s.lng},${s.lat}`).join(";");
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.routes || data.routes.length === 0) return null;

    const route = data.routes[0];
    return {
      distance: route.distance,
      duration: route.duration,
      distanceText: formatDistance(route.distance),
      durationText: formatDuration(route.duration),
      geometry: route.geometry?.coordinates,
    };
  } catch {
    return null;
  }
}

export function suggestTransportModes(distanceKm: number): TransportOption[] {
  const options: TransportOption[] = [];

  if (distanceKm <= 5) {
    options.push({
      type: "walking",
      description: "Walk",
      estimatedDuration: `${Math.round(distanceKm * 12)} min`,
      estimatedCost: "Free",
      notes: "Great for short distances and sightseeing",
    });
    options.push({
      type: "taxi",
      description: "Taxi / Ride-hail",
      estimatedDuration: `${Math.round(distanceKm * 3)} min`,
      estimatedCost: `$${Math.round(3 + distanceKm * 1.5)}-${Math.round(5 + distanceKm * 2)}`,
      notes: "Convenient for door-to-door travel",
    });
  }

  if (distanceKm <= 30) {
    options.push({
      type: "public_transport",
      description: "Public Transit (Bus/Metro)",
      estimatedDuration: `${Math.round(distanceKm * 2.5)}-${Math.round(distanceKm * 4)} min`,
      estimatedCost: `$${Math.round(1 + distanceKm * 0.1)}-${Math.round(2 + distanceKm * 0.15)}`,
      notes: "Most economical option",
    });
    options.push({
      type: "taxi",
      description: "Taxi / Ride-hail",
      estimatedDuration: `${Math.round(distanceKm * 2)}-${Math.round(distanceKm * 3)} min`,
      estimatedCost: `$${Math.round(5 + distanceKm * 1.2)}-${Math.round(8 + distanceKm * 1.8)}`,
      notes: "Convenient, check local ride-hailing apps",
    });
  }

  if (distanceKm > 30) {
    options.push({
      type: "flight",
      description: "Flight",
      estimatedDuration: `${Math.round(distanceKm / 600 + 1.5)}h (including airport time)`,
      estimatedCost: `$${Math.round(50 + distanceKm * 0.08)}-${Math.round(100 + distanceKm * 0.15)}`,
      notes: "Search for flights on Google Flights or Skyscanner",
    });
    options.push({
      type: "train",
      description: "Train",
      estimatedDuration: `${Math.round(distanceKm / 80)}h`,
      estimatedCost: `$${Math.round(20 + distanceKm * 0.05)}-${Math.round(40 + distanceKm * 0.1)}`,
      notes: "Comfortable, scenic, book in advance for savings",
    });
    options.push({
      type: "bus",
      description: "Bus",
      estimatedDuration: `${Math.round(distanceKm / 60)}-${Math.round(distanceKm / 50)}h`,
      estimatedCost: `$${Math.round(10 + distanceKm * 0.03)}-${Math.round(20 + distanceKm * 0.06)}`,
      notes: "Budget-friendly, longest travel time",
    });
  }

  return options;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes} min`;
  return `${hours}h ${minutes}min`;
}
