"use client";

import { useState } from "react";
import SmartImage from "@/components/ui/SmartImage";

interface ShowcaseCardProps {
  name: string;
  img: string;
  position: string;
  className?: string;
  loading?: "lazy" | "eager";
  fetchPriority?: "high" | "auto";
  index?: number;
}

/**
 * Home showcase tile: photo, bottom scrim, caption. Hover lifts the card a
 * couple of pixels and eases the photo in — nothing else moves.
 */
export default function ShowcaseCard({
  name,
  img,
  position,
  className = "",
  loading = "lazy",
  fetchPriority = "auto",
  index = 0,
}: ShowcaseCardProps) {
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <a
      href={`/chat?q=${encodeURIComponent(`Plan a trip to ${name}`)}`}
      className={`showcase-card animate-card-in focus-ring ${className}`}
      style={{ animationDelay: `${320 + index * 70}ms` }}
    >
      <span className="showcase-card__clip">
        {img && !imgFailed ? (
          <SmartImage
            src={img}
            alt={name}
            loading={loading}
            fetchPriority={fetchPriority}
            onError={() => setImgFailed(true)}
            className="showcase-card__img"
            style={{ objectPosition: position }}
          />
        ) : (
          <span
            className="showcase-card__img grid place-items-center bg-zinc-900 text-zinc-600"
            aria-hidden
          >
            <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
              />
            </svg>
          </span>
        )}
        <span className="showcase-card__shade" aria-hidden />
      </span>

      <span className="showcase-card__body">
        <span className="showcase-card__label">{name}</span>
        <span className="showcase-card__hint">
          Plan trip
          <span aria-hidden className="showcase-card__arrow">
            →
          </span>
        </span>
      </span>
    </a>
  );
}
