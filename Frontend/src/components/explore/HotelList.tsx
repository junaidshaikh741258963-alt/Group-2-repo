"use client";

import { useMemo, useState, useEffect } from "react";
import { searchHotels, type Hotel } from "@/lib/hotels";
import HotelCard from "@/components/explore/HotelCard";
import CategoryIcon from "@/components/ui/CategoryIcon";

interface HotelListProps {
  lat: number;
  lng: number;
  onSelectHotel?: (hotel: Hotel) => void;
}

type SortBy = "price" | "stars" | "distance";

/** Skeleton that matches the HotelCard slot size so the list never jumps
 *  when photos and text arrive. */
function HotelSkeleton() {
  return (
    <div className="flex gap-3 items-start rounded-xl border border-white/[0.06] bg-surface-1 p-3">
      <div className="img-skeleton aspect-[4/3] w-20 sm:w-28 shrink-0 rounded-lg" />
      <div className="flex-1 min-w-0 space-y-2 py-1">
        <div className="h-4 w-3/4 rounded bg-surface-2" />
        <div className="h-3 w-1/2 rounded bg-surface-2" />
        <div className="h-3 w-4/5 rounded bg-surface-2" />
        <div className="h-3 w-1/3 rounded bg-surface-2" />
      </div>
    </div>
  );
}

export default function HotelList({ lat, lng, onSelectHotel }: HotelListProps) {
  const [result, setResult] = useState<{ key: string; hotels: Hotel[] } | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("price");
  const [filterStars, setFilterStars] = useState<number>(0);
  const [radius, setRadius] = useState(5);

  const requestKey = `${lat}:${lng}:${radius}`;
  const loading = !result || result.key !== requestKey;

  useEffect(() => {
    let alive = true;
    searchHotels(lat, lng, radius, 20).then((hotels) => {
      if (alive) setResult({ key: `${lat}:${lng}:${radius}`, hotels });
    });
    return () => {
      alive = false;
    };
  }, [lat, lng, radius, requestKey]);

  const hotels = loading ? [] : (result?.hotels ?? []);

  const filtered = useMemo(
    () =>
      hotels
        .filter((h) => (filterStars === 0 ? true : h.stars === filterStars))
        .sort((a, b) => {
          if (sortBy === "price") return a.pricePerNight - b.pricePerNight;
          if (sortBy === "stars") return b.stars - a.stars;
          return (a.distanceFromCenter || 0) - (b.distanceFromCenter || 0);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, sortBy, filterStars]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-ink">
          Hotels Nearby
          {!loading && (
            <span className="text-sm font-normal text-ink-faint ml-1">({filtered.length})</span>
          )}
        </h3>
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
          className="min-h-touch text-sm border border-white/10 rounded-lg px-3 py-2 bg-zinc-900 text-zinc-300 outline-none transition-colors hover:border-white/20 focus:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 [&>option]:bg-zinc-900"
        >
          <option value="price">Sort by Price</option>
          <option value="stars">Sort by Stars</option>
          <option value="distance">Sort by Distance</option>
        </select>

        <select
          value={filterStars}
          onChange={(e) => setFilterStars(Number(e.target.value))}
          className="min-h-touch text-sm border border-white/10 rounded-lg px-3 py-2 bg-zinc-900 text-zinc-300 outline-none transition-colors hover:border-white/20 focus:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 [&>option]:bg-zinc-900"
        >
          <option value={0}>All Stars</option>
          <option value={5}>5 Stars</option>
          <option value={4}>4 Stars</option>
          <option value={3}>3 Stars</option>
          <option value={2}>2 Stars</option>
          <option value={1}>1 Star</option>
        </select>

        <select
          value={radius}
          onChange={(e) => setRadius(Number(e.target.value))}
          className="min-h-touch text-sm border border-white/10 rounded-lg px-3 py-2 bg-zinc-900 text-zinc-300 outline-none transition-colors hover:border-white/20 focus:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 [&>option]:bg-zinc-900"
        >
          <option value={2}>2 km</option>
          <option value={5}>5 km</option>
          <option value={10}>10 km</option>
          <option value={20}>20 km</option>
        </select>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <HotelSkeleton key={i} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-8 text-ink-faint">
          <span className="mx-auto grid h-10 w-10 place-items-center rounded-lg bg-surface-2 text-zinc-600 mb-3">
            <CategoryIcon kind="hotel" className="w-5 h-5" />
          </span>
          <p>No hotels found in this area.</p>
          <p className="text-sm mt-1">Try increasing the search radius.</p>
        </div>
      ) : (
        <div className="space-y-3 max-h-125 overflow-y-auto pr-1 dark-scroll">
          {filtered.map((hotel) => (
            <HotelCard key={hotel.id} hotel={hotel} onSelect={onSelectHotel} />
          ))}
        </div>
      )}
    </div>
  );
}
