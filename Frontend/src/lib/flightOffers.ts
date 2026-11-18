export interface FlightLeg {
  from: string;
  to: string;
  depart: string;
  arrive: string;
  airline: string;
  logo: string;
  flightNumber: string;
  durationMin?: number;
}

export interface FlightOffer {
  kind: string;
  price?: number;
  currency?: string;
  bookingUrl?: string;
  durationMin?: number;
  stops: number;
  airline: string;
  airlineLogo: string;
  travelClass: string;
  departAt: string;
  arriveAt: string;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  legs: FlightLeg[];
}
