/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import HomeBackground from "@/components/home/HomeBackground";
import Card from "@/components/ui/Card";
import Container from "@/components/ui/Container";
import Row from "@/components/ui/Row";
import Stack from "@/components/ui/Stack";
import { useLiveItinerary } from "@/components/trip/LiveItineraryContext";
import {
  decodeShareToken,
  duplicateSavedTrip,
  loadSavedTrips,
  removeSavedTrip,
  saveTripToStore,
  shareTripUrl,
  type SavedTrip,
} from "@/lib/savedTripsStore";
import { buildIcs, downloadIcs, icsFileName } from "@/lib/itinerary/ics";
import { scheduleDay, type ScheduleStopInput } from "@/lib/itinerary/scheduler";
import { dateForDay, parseTripStart } from "@/lib/tripDates";
import { hasStops, stopCount } from "@/lib/liveItinerary";
import { toast } from "@/lib/toast";

const GUEST_ID = "guest";

interface RouteTrip {
  id: string;
  origin_name: string;
  destination_name: string;
  origin_lat: number;
  origin_lng: number;
  dest_lat: number;
  dest_lng: number;
  distance: number;
  duration: number;
  created_at: string;
}

const btnBase =
  "inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60";
const btnQuiet = `${btnBase} border-white/[0.12] bg-white/5 text-zinc-200 hover:border-white/[0.2] hover:bg-white/10 hover:text-white`;
const btnDanger = `${btnBase} border-transparent text-ink-faint hover:bg-rose-500/10 hover:text-rose-300`;

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** .ics for one saved trip (scheduled with smart travel legs). */
function icsForTrip(trip: SavedTrip): string | null {
  const start = parseTripStart(trip.itinerary.dates);
  if (!start) return null;
  const entries = trip.itinerary.days.flatMap((day) => {
    const inputs: ScheduleStopInput[] = day.stops.map((s) => ({
      id: s.id,
      name: s.name,
      minutes: s.minutes,
      lat: s.lat,
      lng: s.lng,
      openingHours: s.openingHours,
      category: s.category,
    }));
    const plan = scheduleDay(inputs);
    return plan.stops.map((s) => ({
      date: dateForDay(start.iso, day.day),
      start: s.start,
      end: s.end,
      summary: s.name,
      description: `Day ${day.day}${day.title ? ` · ${day.title}` : ""}`,
      location: trip.itinerary.destination,
    }));
  });
  return buildIcs({ title: trip.name, entries });
}

function TripsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { replace, plan } = useLiveItinerary();

  const [saved, setSaved] = useState<SavedTrip[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [routeTrips, setRouteTrips] = useState<RouteTrip[]>([]);
  const [shareState, setShareState] = useState<"pending" | "done" | "dismissed">("pending");

  const sharedTrip = useMemo(() => {
    const token = searchParams.get("t");
    return token ? decodeShareToken(token) : null;
  }, [searchParams]);

  const refresh = useCallback(() => {
    setSaved(loadSavedTrips());
  }, []);

  useEffect(() => {
    refresh();
    setLoaded(true);
  }, [refresh]);

  // Route-planner trips (MySQL) are a bonus section — silent when unavailable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/trips?userId=${GUEST_ID}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.trips)) setRouteTrips(data.trips);
      } catch {
        /* no database in this environment */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openTrip = useCallback(
    (trip: SavedTrip) => {
      replace(trip.itinerary);
      toast.success(`Opened “${trip.name}” as your live plan`);
      router.push("/itinerary");
    },
    [replace, router]
  );

  const handleDuplicate = useCallback(
    (trip: SavedTrip) => {
      const copy = duplicateSavedTrip(trip.id);
      if (!copy) return;
      refresh();
      toast.success(`Duplicated as “${copy.name}”`);
    },
    [refresh]
  );

  const handleShare = useCallback(async (trip: SavedTrip) => {
    const url = shareTripUrl(trip, window.location.origin);
    if (!url) {
      toast.error("This trip is too large to share as a link — export the .ics instead.");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Share link copied to the clipboard.");
    } catch {
      window.prompt("Copy this share link:", url);
    }
  }, []);

  const handleExport = useCallback((trip: SavedTrip) => {
    const ics = icsForTrip(trip);
    if (!ics) {
      toast.error("This trip has no travel dates — add them in chat, then export again.");
      return;
    }
    downloadIcs(ics, icsFileName(trip.name));
    toast.success("Calendar file downloaded.");
  }, []);

  const handleDelete = useCallback(
    (trip: SavedTrip) => {
      removeSavedTrip(trip.id);
      refresh();
      toast.success(`Deleted “${trip.name}”`, {
        label: "Undo",
        run: () => {
          saveTripToStore(trip.name, trip.itinerary, trip.travelParty, trip.id);
          refresh();
        },
      });
    },
    [refresh]
  );

  const handleSaveShared = useCallback(() => {
    if (!sharedTrip) return;
    const savedTrip = saveTripToStore(sharedTrip.name, sharedTrip.itinerary, sharedTrip.travelParty);
    refresh();
    setShareState("done");
    toast.success(`Saved “${savedTrip.name}” to your trips`);
  }, [sharedTrip, refresh]);

  const handleOpenShared = useCallback(() => {
    if (!sharedTrip) return;
    replace(sharedTrip.itinerary);
    setShareState("done");
    router.push("/itinerary");
  }, [sharedTrip, replace, router]);

  const formatDist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
  const formatDur = (s: number) => {
    const h = Math.floor(s / 3600);
    const min = Math.floor((s % 3600) / 60);
    return h === 0 ? `${min} min` : `${h}h ${min}min`;
  };

  return (
    <Container size="list" className="py-8">
      <HomeBackground />
      <Stack gap={8}>
        <Row justify="between" align="center" gap={4}>
          <Stack gap={1}>
            <h1 className="text-2xl md:text-3xl font-medium tracking-[-0.025em] text-ink">
              Saved trips
            </h1>
            <p className="text-ink-muted text-md">
              Every trip you saved — open one to make it your current trip. They keep working
              offline.
            </p>
          </Stack>
          <button
            onClick={() => router.push("/chat")}
            className="btn btn-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Plan in chat
          </button>
        </Row>

        {/* Shared-trip import banner */}
        {sharedTrip && shareState === "pending" && (
          <Card pad={4} className="border-blue-400/30 bg-blue-500/[0.07] animate-card-in">
            <Stack gap={3}>
              <div className="text-sm text-ink">
                <span className="font-semibold">A trip was shared with you:</span>{" "}
                {sharedTrip.name}
                {sharedTrip.itinerary.destination ? ` · ${sharedTrip.itinerary.destination}` : ""} ·{" "}
                {stopCount(sharedTrip.itinerary)} stops
              </div>
              <Row gap={2} wrap>
                <button type="button" onClick={handleSaveShared} className="btn btn-primary">
                  Save to my trips
                </button>
                <button type="button" onClick={handleOpenShared} className={btnQuiet}>
                  Open as live plan
                </button>
                <button
                  type="button"
                  onClick={() => setShareState("dismissed")}
                  className={btnDanger}
                >
                  Dismiss
                </button>
              </Row>
            </Stack>
          </Card>
        )}
        {sharedTrip && shareState === "done" && (
          <p className="text-sm text-ok">Shared trip added — look for it in the list below.</p>
        )}

        {/* Live plan shortcut */}
        {hasStops(plan) && (
          <Card pad={4} className="animate-card-in">
            <Row justify="between" align="center" gap={4} wrap>
              <Stack gap={1} className="min-w-0">
                <div className="text-md font-medium text-ink">
                  Current live plan: {plan.destination || "Untitled trip"}
                </div>
                <div className="text-sm text-ink-muted tabular-nums">
                  {plan.days.length} days · {stopCount(plan)} stops
                </div>
              </Stack>
              <Row gap={2} wrap>
                <button type="button" onClick={() => router.push("/itinerary")} className={btnQuiet}>
                  Open trip
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const t = saveTripToStore(
                      plan.destination ? `${plan.destination} trip` : "My trip",
                      plan
                    );
                    refresh();
                    toast.success(`Saved “${t.name}”`);
                  }}
                  className="btn btn-primary"
                >
                  Save as trip
                </button>
              </Row>
            </Row>
          </Card>
        )}

        {/* Saved trips */}
        {loaded && saved.length === 0 && !sharedTrip ? (
          <Card pad={0} className="text-center py-16">
            <Stack gap={4} className="items-center px-6">
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-surface-2 text-ink-muted">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.8}
                    d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                  />
                </svg>
              </span>
              <h3 className="text-lg font-medium text-ink">No saved trips yet</h3>
              <p className="text-ink-muted text-sm max-w-sm">
                Build a plan in chat, then hit “Save trip” on the itinerary page — it lands here,
                exportable as a calendar file and shareable by link.
              </p>
              <button onClick={() => router.push("/chat")} className="btn btn-primary">
                Plan your first trip
              </button>
            </Stack>
          </Card>
        ) : (
          <Stack gap={3}>
            {saved.map((trip, i) => {
              const days = trip.itinerary.days.filter((d) => d.stops.length > 0).length;
              return (
                <Card
                  key={trip.id}
                  pad={4}
                  style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
                  className="animate-card-in transition-[border-color,transform,background-color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-hairline-strong hover:bg-surface-2 hover:-translate-y-0.5"
                >
                  <Stack gap={3} className="min-w-0">
                    <Row justify="between" align="center" gap={3} wrap>
                      <Stack gap={1} className="min-w-0">
                        <div className="text-md font-medium text-ink truncate">{trip.name}</div>
                        <div className="text-sm text-ink-muted tabular-nums">
                          {trip.itinerary.destination ? `${trip.itinerary.destination} · ` : ""}
                          {trip.itinerary.dates ? `${trip.itinerary.dates} · ` : ""}
                          {days} {days === 1 ? "day" : "days"} · {stopCount(trip.itinerary)} stops
                          {trip.travelParty ? ` · ${trip.travelParty}` : ""} · updated{" "}
                          {formatDate(trip.updatedAt)}
                        </div>
                      </Stack>
                      <button type="button" onClick={() => openTrip(trip)} className="btn btn-primary">
                        Open
                      </button>
                    </Row>
                    <Row gap={2} wrap>
                      <button type="button" onClick={() => handleDuplicate(trip)} className={btnQuiet}>
                        Duplicate
                      </button>
                      <button type="button" onClick={() => handleShare(trip)} className={btnQuiet}>
                        Share link
                      </button>
                      <button type="button" onClick={() => handleExport(trip)} className={btnQuiet}>
                        Calendar (.ics)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(trip)}
                        className={`${btnDanger} ml-auto`}
                      >
                        Delete
                      </button>
                    </Row>
                  </Stack>
                </Card>
              );
            })}
          </Stack>
        )}

        {/* Route-planner trips from the database, when present */}
        {routeTrips.length > 0 && (
          <Stack gap={3}>
            <h2 className="text-lg font-medium text-ink">Saved routes</h2>
            {routeTrips.map((trip) => (
              <Card
                key={trip.id}
                pad={4}
                className="flex flex-col justify-between gap-4 md:flex-row md:items-center"
              >
                <Stack gap={2} className="min-w-0">
                  <Row gap={2} className="text-md font-medium text-ink">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-ok" />
                    <span className="truncate">{trip.origin_name}</span>
                    <svg
                      className="h-4 w-4 shrink-0 text-zinc-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                    <span className="truncate">{trip.destination_name}</span>
                    <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
                  </Row>
                  <Row wrap gap={4} className="text-sm text-ink-muted gap-y-1">
                    {trip.distance > 0 && <span>{formatDist(trip.distance)}</span>}
                    {trip.duration > 0 && <span>{formatDur(trip.duration)}</span>}
                    <span>
                      {new Date(trip.created_at).toLocaleDateString()}
                    </span>
                  </Row>
                </Stack>
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/trips?id=${trip.id}`, { method: "DELETE" });
                      if (!res.ok) throw new Error("delete failed");
                      setRouteTrips((prev) => prev.filter((t) => t.id !== trip.id));
                    } catch {
                      toast.error("Couldn't delete that route — try again.");
                    }
                  }}
                  aria-label={`Delete route from ${trip.origin_name} to ${trip.destination_name}`}
                  className={`${btnDanger} self-start md:self-center`}
                >
                  Delete
                </button>
              </Card>
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}

export default function TripsPage() {
  return (
    <Suspense
      fallback={
        <Container size="list" className="py-16">
          <HomeBackground />
          <div className="text-base text-ink-faint">Loading your trips…</div>
        </Container>
      }
    >
      <TripsPageInner />
    </Suspense>
  );
}
