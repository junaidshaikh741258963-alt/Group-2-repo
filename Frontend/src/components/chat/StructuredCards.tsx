"use client";

import { memo, useMemo } from "react";
import { RecommendationCards } from "@/components/explore/RecommendationCard";
import { dominantCardGroup, groupCardsByCategory } from "@/lib/ai/aiReply";
import type { RecType, Recommendation } from "@/lib/recommendations";

/** Plain-language headings — a reply reads like a shortlist, not a database. */
const GROUP_LABEL: Record<RecType, string> = {
  destination: "Places to go",
  attraction: "Things to do",
  restaurant: "Where to eat",
  hotel: "Where to stay",
  airport: "Getting there",
};

/** The three shelves a trip is built from, in the order travellers plan them. */
export type ShelfType = "hotel" | "restaurant" | "attraction";

export const SHELF_ORDER: ShelfType[] = ["hotel", "restaurant", "attraction"];

export type ShelfState = "done" | "current" | "open";

export interface ShelfStep {
  type: ShelfType;
  state: ShelfState;
}

function groupLabel(type: RecType): string {
  return GROUP_LABEL[type] ?? "More places";
}

function optionCount(n: number): string {
  return `${n} ${n === 1 ? "option" : "options"}`;
}

interface StructuredCardsProps {
  items: Recommendation[];
  activeId?: string | null;
  hoverId?: string | null;
  onFocus?: (id: string) => void;
  onHover?: (id: string | null) => void;
  selectableType?: RecType | null;
  onSelect?: (item: Recommendation) => void;
  selectedName?: string | null;
  /** Opens the place detail sheet from a card's "Details" action. */
  onDetails?: (item: Recommendation) => void;
  /** Where this conversation is in the stay → eat → do sequence. */
  progress?: ShelfStep[];
  /** Ask for a shelf that has not been planned yet (or for more of a done one). */
  onPick?: (type: ShelfType) => void;
}

/** Hard ceiling on a single reply. The server enforces it too — this is the
 *  client-side backstop so no payload can turn a chat turn into a card dump. */
const MAX_CHAT_CARDS = 8;

/** Stays and restaurants carry enough prose to read as a list; sights and
 *  destinations work better as photo-first tiles. */
const LIST_TYPES: RecType[] = ["hotel", "restaurant"];

/**
 * A reply's places as one shelf. The server ships one category per turn (see
 * `applyTurnIntent`), and `dominantCardGroup` is the client backstop. The
 * heading stays a quiet caption under the cards: the places themselves — not
 * a navigation rail — should be the loudest thing in the reply.
 */
function StructuredCardsInner({
  items,
  activeId,
  hoverId,
  onFocus,
  onHover,
  selectableType,
  onSelect,
  selectedName,
  onDetails,
}: StructuredCardsProps) {
  const visible = useMemo(() => items.slice(0, MAX_CHAT_CARDS), [items]);
  // One shelf per reply: keep the dominant group only. The server enforces
  // this too; this is the client backstop for stored/legacy mixed payloads.
  const group = useMemo(() => dominantCardGroup(groupCardsByCategory(visible)), [visible]);
  if (!group) return null;

  const asList = LIST_TYPES.includes(group.type);
  const firstLocated = group.items.find(
    (item) => typeof item.lat === "number" && typeof item.lng === "number"
  );

  return (
    <div className="mt-4 animate-card-group-in">
      <RecommendationCards
        items={group.items}
        presentation={asList ? "row" : "tile"}
        layout={asList ? "list" : "row"}
        activeId={activeId}
        hoverId={hoverId}
        onFocus={onFocus}
        onHover={onHover}
        selectableType={selectableType}
        onSelect={onSelect}
        selectedName={selectedName}
        onDetails={onDetails}
      />

      <div className="mt-2 flex items-center gap-3">
        <span className="text-2xs text-zinc-500">
          {groupLabel(group.type)} · {optionCount(group.items.length)}
        </span>
        <span className="h-px flex-1 bg-white/[0.06]" aria-hidden />
        {onFocus && (
          <button
            type="button"
            onClick={() => onFocus((firstLocated ?? group.items[0]).id)}
            className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-zinc-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            title="Show these places on the map"
            aria-label={`Show ${groupLabel(group.type)} on the map`}
          >
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 21s7-5.1 7-11a7 7 0 1 0-14 0c0 5.9 7 11 7 11Z"
              />
              <circle cx="12" cy="10" r="2.4" />
            </svg>
            Map
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(StructuredCardsInner);
