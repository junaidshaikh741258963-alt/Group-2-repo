"use client";

import type { ReactNode } from "react";
import ChatInput from "@/components/chat/ChatInput";
import SmartImage from "@/components/ui/SmartImage";
import { SHOWCASE_PHOTOS } from "@/lib/showcasePhotos";

interface Destination {
  name: string;
  country: string;
  query: string;
  img: string;
  position?: string;
}

const DESTINATIONS: Destination[] = [
  {
    name: "Paris",
    country: "France",
    query: "Plan a trip to Paris",
    img: SHOWCASE_PHOTOS.paris,
    position: "center 55%",
  },
  {
    name: "Tokyo",
    country: "Japan",
    query: "Plan a trip to Tokyo",
    img: SHOWCASE_PHOTOS.tokyo,
    position: "center 45%",
  },
  {
    name: "Bali",
    country: "Indonesia",
    query: "Plan a trip to Bali",
    img: SHOWCASE_PHOTOS.bali,
  },
  {
    name: "Santorini",
    country: "Greece",
    query: "Plan a romantic getaway to Santorini",
    img: SHOWCASE_PHOTOS.santorini,
    position: "center 60%",
  },
];

const PROMPTS: Array<{ label: string; query: string }> = [
  { label: "Surprise me", query: "Surprise me with a destination for my next trip" },
  { label: "Weekend escape", query: "Plan a weekend escape somewhere new" },
];

interface ChatHeroProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  /** Capability rail shown inside the composer. */
  actions?: ReactNode;
}

export default function ChatHero({ onSend, disabled, actions }: ChatHeroProps) {
  return (
    <div className="flex min-h-full flex-col items-center px-4 py-8 md:py-10">
      <div className="my-auto w-full max-w-140">
        <div className="hero-in hero-in-1 flex justify-center">
          <span
            className="grid h-12 w-12 place-items-center rounded-full bg-gradient-to-b from-white/[0.14] to-white/[0.03] text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
            aria-hidden
          >
            <svg
              className="h-7 w-7"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.3}
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M3.6 9h16.8M3.6 15h16.8" />
              <path d="M12 3c2.5 2.4 3.8 5.4 3.8 9s-1.3 6.6-3.8 9c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3Z" />
            </svg>
          </span>
        </div>

        <h1 className="hero-in hero-in-1 mt-4 text-center text-2xl font-semibold tracking-[-0.02em] text-white">
          Where to today?
        </h1>

        <p className="hero-in hero-in-2 mx-auto mt-2 max-w-md text-center text-sm leading-relaxed text-zinc-400">
          Tell me a place, a mood, or a date. I&apos;ll find real places, weigh the routes, and
          shape a trip you can keep editing.
        </p>

        <div className="hero-in hero-in-2 mt-4 flex flex-wrap items-center justify-center gap-2">
          {PROMPTS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => onSend(p.query)}
              disabled={disabled}
              className="rounded-full border border-white/[0.1] bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/25 hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="hero-in hero-in-3 mt-6">
          <ChatInput
            variant="hero"
            onSend={onSend}
            disabled={disabled}
            autoFocus
            actions={actions}
            placeholder="Ask anything about your trip…"
          />
        </div>

        <div className="hero-in hero-in-4 mt-8">
          <div className="mb-3 flex items-center gap-3">
            <span className="text-2xs font-medium uppercase tracking-[0.12em] text-zinc-500">
              Trending now
            </span>
            <span className="h-px flex-1 bg-white/[0.07]" aria-hidden />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {DESTINATIONS.map((d, i) => (
              <button
                key={d.name}
                onClick={() => onSend(d.query)}
                disabled={disabled}
                style={{ animationDelay: `${0.4 + i * 0.06}s` }}
                className="dest-card focus-ring hero-in group aspect-[4/5] rounded-lg text-left disabled:cursor-not-allowed disabled:opacity-60"
              >
                <SmartImage
                  src={d.img}
                  alt={d.name}
                  loading={i === 0 ? "eager" : "lazy"}
                  fetchPriority={i === 0 ? "high" : "auto"}
                  sizes="(max-width: 640px) 45vw, 130px"
                  widths={[320, 640]}
                  className="absolute inset-0 h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                  style={{ objectPosition: d.position || "center" }}
                />
                <span
                  aria-hidden
                  className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent"
                />
                <span className="relative flex h-full flex-col justify-end p-2.5">
                  <span className="block text-xs font-semibold leading-tight text-white">
                    {d.name}
                  </span>
                  <span className="mt-0.5 block truncate text-2xs text-zinc-300/90">
                    {d.country}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
