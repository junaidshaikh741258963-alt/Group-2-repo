export interface StationSuggestion {
  id: string;
  name: string;
  type: string;
  lat?: number;
  lng?: number;
  products?: Record<string, boolean>;
}

export interface TrainLeg {
  kind: "ride" | "walk";
  line: string;
  product: string;
  operator: string;
  direction: string;
  from: string;
  to: string;
  depart: string;
  arrive: string;
  durationMin: number | null;
}

export interface TrainJourney {
  departAt: string;
  arriveAt: string;
  durationMin: number;
  transfers: number;
  from: string;
  to: string;
  price?: number;
  currency?: string;
  legs: TrainLeg[];
}
