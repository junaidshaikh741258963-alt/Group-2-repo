export const GUEST_ID = "guest";

export interface TripPayload {
  origin_name: string;
  destination_name: string;
  origin_lat?: number;
  origin_lng?: number;
  dest_lat?: number;
  dest_lng?: number;
  distance?: number;
  duration?: number;
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export async function saveTrip(payload: TripPayload): Promise<void> {
  const res = await fetch("/api/trips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: GUEST_ID, ...payload }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(data.error || "Failed to save trip");
  }
}
