import type { AiReply } from "@/lib/ai/aiSchema";
import type { SourceRef } from "@/lib/rag/types";
import type { TripWeather } from "@/lib/weather";
import type { FlightOffer } from "@/lib/flightOffers";

/** Flight options attached to a message by client enrichment. */
export interface ChatFlights {
  offers: FlightOffer[];
  from?: string;
  to?: string;
  date?: string;
  returnDate?: string;
  fetchedAt: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Structured payload for new replies; absent on legacy (tag-based) ones. */
  structured?: AiReply;
  places?: Place[];
  itinerary?: ItineraryDay[];
  chips?: string[];
  field?: string;
  /** Thumbs verdict on this reply — persisted with the conversation so the
   *  user can review what helped and what didn't later. */
  feedback?: "up" | "down";
  /** Provenance chips for grounded answers (attached from the stream's done event). */
  sources?: SourceRef[];
  /** Weather for the destination, fetched when the turn is about weather/planning. */
  weather?: TripWeather;
  /** Live flight options, fetched when the turn is about flights. */
  flights?: ChatFlights;
}

interface Place {
  name: string;
  type: "hotel" | "restaurant" | "attraction";
  rating: number;
  price: string;
  description: string;
  lat: number;
  lng: number;
}

interface ItineraryDay {
  day: number;
  title: string;
  places: Place[];
}

export function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export type { Message, Place, ItineraryDay };
