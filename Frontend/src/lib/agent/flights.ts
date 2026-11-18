export interface FlightSuggestion {
  route: string;
  type: string;
  estimatedDuration: string;
  estimatedPriceRange: string;
  searchQuery: string;
  tips: string;
}

export async function getFlightSuggestions(
  origin: string,
  destination: string,
  departureDate: string,
  returnDate?: string,
  _travelers: number = 1
): Promise<FlightSuggestion[]> {
  const originCity = origin.split(",")[0].trim();
  const destCity = destination.split(",")[0].trim();

  const distance = await estimateFlightDistance(originCity, destCity);

  const suggestions: FlightSuggestion[] = [];

  // Direct flight suggestion
  suggestions.push({
    route: `${originCity} → ${destCity}`,
    type: "Direct flight",
    estimatedDuration: estimateFlightDuration(distance),
    estimatedPriceRange: estimateFlightPrice(distance, "economy"),
    searchQuery: `flights from ${originCity} to ${destCity} on ${departureDate}${returnDate ? ` returning ${returnDate}` : ""}`,
    tips: "Book 2-3 weeks in advance for best prices. Use Google Flights or Skyscanner to compare.",
  });

  // Budget option
  suggestions.push({
    route: `${originCity} → ${destCity}`,
    type: "Budget / Connecting",
    estimatedDuration: estimateFlightDuration(distance, true),
    estimatedPriceRange: estimateFlightPrice(distance, "budget"),
    searchQuery: `cheap flights from ${originCity} to ${destCity} on ${departureDate}`,
    tips: "Consider budget airlines (Ryanair, AirAsia, Spirit, IndiGo) or connecting flights for savings.",
  });

  // Alternative airports
  suggestions.push({
    route: `${originCity} → ${destCity} area`,
    type: "Nearby airports",
    estimatedDuration: estimateFlightDuration(distance),
    estimatedPriceRange: estimateFlightPrice(distance, "alternative"),
    searchQuery: `flights to ${destCity} area airports on ${departureDate}`,
    tips: "Check nearby airports - sometimes flying into a secondary airport saves significantly.",
  });

  return suggestions;
}

async function estimateFlightDistance(origin: string, destination: string): Promise<number> {
  // Rough distance estimation based on known city coordinates
  const cities: Record<string, [number, number]> = {
    "new york": [40.7, -74.0],
    london: [51.5, -0.1],
    paris: [48.9, 2.3],
    tokyo: [35.7, 139.7],
    delhi: [28.6, 77.2],
    mumbai: [19.1, 72.9],
    dubai: [25.2, 55.3],
    singapore: [1.3, 103.8],
    bangkok: [13.8, 100.5],
    bali: [-8.3, 115.2],
    rome: [41.9, 12.5],
    berlin: [52.5, 13.4],
    sydney: [-33.9, 151.2],
    "los angeles": [34.1, -118.2],
    "san francisco": [37.8, -122.4],
    chicago: [41.9, -87.6],
    toronto: [43.7, -79.4],
    miami: [25.8, -80.2],
    amsterdam: [52.4, 4.9],
    barcelona: [41.4, 2.2],
    madrid: [40.4, -3.7],
    istanbul: [41.0, 28.9],
    cairo: [30.0, 31.2],
    nairobi: [-1.3, 36.8],
    "cape town": [-33.9, 18.4],
    "rio de janeiro": [-22.9, -43.2],
    "buenos aires": [-34.6, -58.4],
    "mexico city": [19.4, -99.1],
    seoul: [37.6, 127.0],
    "hong kong": [22.3, 114.2],
    "kuala lumpur": [3.1, 101.7],
    hanoi: [21.0, 105.8],
    "phnom penh": [11.6, 104.9],
    prague: [50.1, 14.4],
    vienna: [48.2, 16.4],
    budapest: [47.5, 19.1],
    lisbon: [38.7, -9.1],
    zurich: [47.4, 8.5],
    stockholm: [59.3, 18.1],
    oslo: [59.9, 10.7],
    copenhagen: [55.7, 12.6],
    helsinki: [60.2, 24.9],
    athens: [37.9, 23.7],
    jaipur: [26.9, 75.8],
    goa: [15.4, 73.8],
    kathmandu: [27.7, 85.3],
    colombo: [6.9, 79.9],
    malé: [4.2, 73.5],
    taipei: [25.0, 121.5],
    manila: [14.6, 121.0],
    jakarta: [-6.2, 106.8],
    "ho chi minh": [10.8, 106.6],
    phuket: [7.9, 98.3],
    "chiang mai": [18.8, 98.9],
    "siem reap": [13.4, 103.9],
    "luang prabang": [19.9, 102.1],
    yangon: [16.9, 96.2],
    kolkata: [22.6, 88.4],
    chennai: [13.1, 80.3],
    bangalore: [12.9, 77.6],
    hyderabad: [17.4, 78.5],
    agra: [27.2, 78.0],
    varanasi: [25.3, 83.0],
    udaipur: [24.6, 73.7],
    jodhpur: [26.3, 73.0],
    pushkar: [26.5, 74.6],
    manali: [32.2, 77.2],
    shimla: [31.1, 77.2],
    ladakh: [34.2, 77.6],
    kashmir: [34.1, 74.8],
  };

  const o = cities[origin.toLowerCase()];
  const d = cities[destination.toLowerCase()];

  if (o && d) {
    return haversineDistance(o[0], o[1], d[0], d[1]);
  }

  // Default estimate
  return 5000;
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateFlightDuration(distanceKm: number, connecting: boolean = false): string {
  const hours = distanceKm / 600 + (connecting ? 2 : 1);
  return `${Math.round(hours)}h${connecting ? "+" : ""}`;
}

function estimateFlightPrice(distanceKm: number, type: string): string {
  const base = distanceKm * 0.08;
  switch (type) {
    case "budget":
      return `$${Math.round(base * 0.5)}-$${Math.round(base * 0.8)}`;
    case "alternative":
      return `$${Math.round(base * 0.7)}-$${Math.round(base * 1.1)}`;
    default:
      return `$${Math.round(base * 0.8)}-$${Math.round(base * 1.4)}`;
  }
}

export function formatFlightsForAgent(suggestions: FlightSuggestion[]): string {
  if (suggestions.length === 0) return "No flight data available.";
  return suggestions
    .map(
      (s) =>
        `- ${s.type}: ${s.route}, ~${s.estimatedDuration}, ${s.estimatedPriceRange}\n  Search: "${s.searchQuery}"\n  Tip: ${s.tips}`
    )
    .join("\n");
}
