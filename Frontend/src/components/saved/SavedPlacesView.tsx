"use client";

import Link from "next/link";
import CategoryIcon from "@/components/ui/CategoryIcon";
import SmartImage from "@/components/ui/SmartImage";
import AddToTripButton from "@/components/ui/AddToTripButton";
import { clearSavedPlaces, removeSavedPlace, useSavedPlaces } from "@/lib/savedPlaces";
import { recMeta, type RecType } from "@/lib/recommendations";
import { formatReviewCount } from "@/lib/reviews";

function asRecType(type: string): RecType {
  return type === "hotel" ||
    type === "restaurant" ||
    type === "attraction" ||
    type === "airport" ||
    type === "destination"
    ? type
    : "attraction";
}

export default function SavedPlacesView() {
  const places = useSavedPlaces();

  return (
    <section className="mx-auto w-full max-w-[80rem] px-6 py-8 md:px-8 lg:px-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Your places</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">Saved</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {places.length > 0
              ? `${places.length} ${places.length === 1 ? "place" : "places"} saved from Explore, chat and maps.`
              : "Keep the places you love in one list, ready for the next trip."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/chat?view=explore" className="btn btn-quiet">
            Explore places
          </Link>
          {places.length > 0 && (
            <button
              type="button"
              onClick={clearSavedPlaces}
              className="btn btn-quiet text-ink-muted hover:text-rose-300"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {places.length === 0 ? (
        <div className="mt-16 flex flex-col items-center text-center">
          <span className="grid h-16 w-16 place-items-center rounded-full border border-hairline bg-surface-1 text-rose-400">
            <svg
              className="h-7 w-7"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              />
            </svg>
          </span>
          <h2 className="mt-5 text-lg font-semibold text-ink">Nothing saved yet</h2>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-faint">
            Tap the heart on any place card in Explore, on the map or in a recommendation to save
            it here.
          </p>
          <Link href="/chat?view=explore" className="btn btn-primary mt-6">
            Find places to save
          </Link>
        </div>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {places.map((place) => {
            const kind = asRecType(place.type);
            const meta = recMeta(kind);
            const reviews = formatReviewCount(place.reviews);
            const hasCoords =
              typeof place.lat === "number" && typeof place.lng === "number";

            return (
              <li
                key={place.key}
                className="group flex flex-col overflow-hidden rounded-xl border border-hairline bg-zinc-900/80 shadow-lg shadow-black/30"
              >
                <div className="relative aspect-[16/10] overflow-hidden bg-gradient-to-br from-zinc-800 to-zinc-900">
                  {place.image ? (
                    <SmartImage
                      src={place.image}
                      alt={place.name}
                      sizes="(max-width: 767px) 92vw, (max-width: 1023px) 46vw, 300px"
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                      fallback={
                        <span className="absolute inset-0 grid place-items-center text-zinc-600">
                          <CategoryIcon kind={kind} className="h-10 w-10" />
                        </span>
                      }
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-zinc-600">
                      <CategoryIcon kind={kind} className="h-10 w-10" />
                    </div>
                  )}
                  <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/20" />
                  <span className="absolute top-2 left-2 inline-flex items-center gap-2 rounded-md border border-white/10 bg-black/60 px-2 py-1 text-2xs font-medium text-ink">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: meta.color }}
                      aria-hidden
                    />
                    {meta.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeSavedPlace(place.key)}
                    aria-label={`Remove ${place.name} from saved places`}
                    title="Remove from saved"
                    className="absolute top-2 right-2 grid h-8 w-8 place-items-center rounded-full border border-rose-300/50 bg-rose-500 text-white shadow-lg shadow-black/40 transition-transform hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/70"
                  >
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                    </svg>
                  </button>
                </div>

                <div className="flex flex-1 flex-col p-3">
                  <h2 className="truncate text-sm font-semibold leading-ui text-ink">
                    {place.name}
                  </h2>
                  <p className="mt-1 truncate text-xs text-ink-muted">
                    {meta.label}
                    {place.city ? ` · ${place.city}` : ""}
                  </p>
                  <div className="mt-2 flex h-6 items-center gap-2 text-2xs text-ink-faint">
                    {typeof place.rating === "number" && (
                      <span className="inline-flex items-center gap-1 font-semibold text-amber-300">
                        <span aria-hidden>★</span>
                        {place.rating.toFixed(1)}
                        {reviews && (
                          <span className="font-normal text-amber-200/70">({reviews})</span>
                        )}
                      </span>
                    )}
                    {place.price && (
                      <span className="font-semibold text-ok">{place.price}</span>
                    )}
                  </div>

                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
                    <AddToTripButton
                      item={{
                        name: place.name,
                        category: kind,
                        description: place.city,
                        image: place.image,
                        rating: place.rating,
                        price: place.price,
                        lat: place.lat,
                        lng: place.lng,
                      }}
                    />
                    {hasCoords && (
                      <Link
                        href={`/chat?view=explore&lat=${place.lat}&lng=${place.lng}&name=${encodeURIComponent(
                          place.name
                        )}&map=1`}
                        className="shrink-0 text-2xs font-semibold text-blue-400 transition-colors hover:text-blue-300"
                      >
                        Explore →
                      </Link>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
