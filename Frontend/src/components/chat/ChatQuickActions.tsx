"use client";

import type { ReactNode } from "react";

type QuickAction = "flights" | "trains" | "stays" | "food" | "sights" | "weather";

interface QuickActionSpec {
  key: QuickAction;
  label: string;
  title: string;
  icon: ReactNode;
}

const icon = (path: ReactNode) => (
  <svg
    className="hidden h-3.5 w-3.5 shrink-0 text-ink-faint transition-colors duration-200 group-hover/qa:text-blue-300 md:block"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    viewBox="0 0 24 24"
    aria-hidden
  >
    {path}
  </svg>
);

const ACTIONS: QuickActionSpec[] = [
  {
    key: "flights",
    label: "Flights",
    title: "Find live flight offers for this trip",
    icon: icon(<path d="M2.5 19.5 21 12 2.5 4.5 5.2 11l8.8 1-8.8 1-2.7 6.5Z" />),
  },
  {
    key: "trains",
    label: "Trains",
    title: "Open the live train and route planner",
    icon: icon(
      <>
        <rect x="5" y="3.5" width="14" height="13" rx="3" />
        <path d="M5 10h14M8.5 20l1.5-3.5M15.5 20 14 16.5" />
        <circle cx="8.7" cy="13.2" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="15.3" cy="13.2" r="0.9" fill="currentColor" stroke="none" />
      </>
    ),
  },
  {
    key: "stays",
    label: "Stays",
    title: "Show hotels for this destination",
    icon: icon(
      <>
        <path d="M3 18v-9M3 15h18v3M21 18v-5a2 2 0 0 0-2-2H9v4" />
        <path d="M6.5 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
      </>
    ),
  },
  {
    key: "food",
    label: "Food",
    title: "Show restaurants and food worth planning around",
    icon: icon(
      <>
        <path d="M6 3v7M9 3v7M6 10v11M9 10v11M6 7h3" />
        <path d="M15.5 3c2.2 0 3.5 2.2 3.5 5.5S17.7 14 15.5 14V3Zm0 11v7" />
      </>
    ),
  },
  {
    key: "sights",
    label: "Sights",
    title: "Show things to do and see",
    icon: icon(
      <>
        <path d="M3 20h18M5 20V9l7-5 7 5v11" />
        <path d="M9 20v-6h6v6M12 4v3" />
      </>
    ),
  },
  {
    key: "weather",
    label: "Weather",
    title: "Check the forecast for this destination",
    icon: icon(
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
      </>
    ),
  },
];

interface ChatQuickActionsProps {
  /** Adds "in Tokyo" / "to Tokyo" to every prompt once the trip knows it. */
  destination?: string | null;
  disabled?: boolean;
  onSend: (message: string) => void;
  /** The train/route tool is a real in-app planner, not a chat prompt. */
  onOpenRoute: () => void;
  className?: string;
}

/**
 * A capability rail inside the composer: the six things this planner can do
 * that a general chat cannot — live fares, the rail planner, real stays, food,
 * sights and a forecast. Tapping one sends a scoped prompt (or opens the route
 * tool), so the conversation stays one-shelf and the trip context is reused.
 */
export default function ChatQuickActions({
  destination,
  disabled,
  onSend,
  onOpenRoute,
  className = "",
}: ChatQuickActionsProps) {
  const place = destination?.trim() ?? "";
  const inPlace = place ? ` in ${place}` : "";
  const toPlace = place ? ` to ${place}` : "";

  const prompt: Record<QuickAction, string> = {
    flights: `Find live flights${toPlace}`,
    trains: "",
    stays: `Show me hotels${inPlace}`,
    food: `Show me restaurants${inPlace}`,
    sights: `Show me things to do${inPlace}`,
    weather: `What's the weather like${inPlace}?`,
  };

  const run = (key: QuickAction) => {
    if (disabled) return;
    if (key === "trains") {
      onOpenRoute();
      return;
    }
    onSend(prompt[key]);
  };

  return (
    <div className={`w-full ${className}`}>
      <div
        className="flex w-full items-center gap-0.5 overflow-x-auto rounded-xl border border-white/[0.07] bg-white/[0.025] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="group"
        aria-label="Live trip tools"
      >
        <span className="flex shrink-0 items-center gap-1.5 pl-1.5 pr-1.5 text-2xs font-medium uppercase tracking-[0.08em] text-ink-faint md:pr-2">
          <span
            className="h-1.5 w-1.5 rounded-full bg-emerald-400/80 shadow-[0_0_0_3px_rgba(52,211,153,0.08)]"
            aria-hidden
          />
          <span className="hidden md:inline">Live</span>
        </span>
        <span className="mr-0.5 hidden h-4 w-px shrink-0 bg-white/[0.08] md:block" aria-hidden />
        {ACTIONS.map((action) => (
          <button
            key={action.key}
            type="button"
            onClick={() => run(action.key)}
            disabled={disabled}
            title={action.title}
            aria-label={action.title}
            className="group/qa inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg px-1.5 text-2xs font-medium text-ink-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 disabled:pointer-events-none disabled:opacity-45 md:flex-1 md:gap-1.5 md:px-2"
          >
            {action.icon}
            <span className="whitespace-nowrap">{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
