"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { RecommendationCards } from "@/components/explore/RecommendationCard";
import StructuredCards, { type ShelfStep, type ShelfType } from "@/components/chat/StructuredCards";
import ItineraryTimeline from "@/components/trip/ItineraryTimeline";
import WeatherCard from "@/components/chat/cards/WeatherCard";
import BudgetCard from "@/components/chat/cards/BudgetCard";
import FlightCard from "@/components/chat/cards/FlightCard";
import SourceChips from "@/components/chat/cards/SourceChips";
import {
  itemsForAssistant,
  partitionMarkdown,
  singleShelf,
  type RecType,
  type Recommendation,
} from "@/lib/recommendations";
import { computeBudget } from "@/lib/itinerary/budget";
import type { AiReply } from "@/lib/ai/aiSchema";
import type { SourceRef } from "@/lib/rag/types";
import type { TripWeather } from "@/lib/weather";
import type { ChatFlights } from "@/lib/chat";
import { stripMetaBlocks } from "@/lib/tripProfile";

interface ChatMessageProps {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Structured payload for new replies (intro → cards → question → chips). */
  structured?: AiReply | null;
  streaming?: boolean;
  activePlaceId?: string | null;
  onFocusPlace?: (id: string) => void;
  onOpenPlace?: (item: Recommendation) => void;
  hoverPlaceId?: string | null;
  onHoverPlace?: (id: string | null) => void;
  chips?: string[];
  onChip?: (value: string) => void;
  showChips?: boolean;
  field?: string | null;
  onSelectPlace?: (item: Recommendation) => void;
  selectedName?: string | null;
  /** Thumbs verdict already recorded on this message, if any. */
  feedback?: "up" | "down";
  /**
   * Takes the message id so the parent can pass ONE stable callback — the
   * list stays memoized while other messages stream in.
   */
  onFeedback?: (messageId: string, verdict: "up" | "down") => void;
  /** Show the regenerate action (last committed assistant reply only). */
  showActions?: boolean;
  onRegenerate?: () => void;
  /** Provenance chips for grounded answers. */
  sources?: SourceRef[];
  /** Destination weather attached by client enrichment. */
  weather?: TripWeather | null;
  /** Flight options attached by client enrichment. */
  flights?: ChatFlights | null;
  /** Party size for the budget card (defaults to 1). */
  travelers?: number;
  /**
   * Where this conversation sits in the stay → eat → do sequence. Present only
   * on the newest assistant reply, so the navigator never repeats down the
   * transcript.
   */
  shelfProgress?: ShelfStep[];
  /** Ask for a shelf that is still unplanned (or for more of a finished one). */
  onShelfPick?: (type: ShelfType) => void;
}

const MD_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-lg font-bold text-ink first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-md font-bold text-ink first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-sm font-semibold text-ink first:mt-0">{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="leading-body break-words first:mt-0">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc pl-4 space-y-1">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal pl-4 space-y-1">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="marker:text-ink-faint leading-body break-words">{children}</li>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-ink">{children}</strong>
  ),
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-zinc-100 underline decoration-white/30 underline-offset-2 hover:decoration-white break-words"
    >
      {children}
    </a>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="rounded-md border border-white/[0.06] bg-white/[0.06] px-1.5 py-0.5 text-[0.85em] text-zinc-200 [overflow-wrap:anywhere]">
      {children}
    </code>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="max-w-full overflow-x-auto rounded-lg border border-white/[0.08] bg-[#0b0b0d] p-3 text-xs text-zinc-300">
      {children}
    </pre>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-white/[0.14] pl-3 text-ink-muted">
      {children}
    </blockquote>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="mb-2 max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="whitespace-nowrap border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 text-left font-semibold text-ink">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-white/[0.08] px-2.5 py-2 align-top break-words">{children}</td>
  ),
  hr: () => <hr className="border-white/[0.08]" />,
};

function AssistantAvatar({ thinking = false }: { thinking?: boolean }) {
  return (
    <span
      className={`relative mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white text-zinc-900 ${
        thinking ? "thinking-pulse" : ""
      }`}
      aria-hidden
    >
      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 1.8l2.2 6.1 6.1 2.2-6.1 2.2L12 18.4l-2.2-6.1-6.1-2.2 6.1-2.2L12 1.8z" />
        <path d="M19.2 15.4l1 2.7 2.7 1-2.7 1-1 2.7-1-2.7-2.7-1 2.7-1 1-2.7z" opacity=".7" />
      </svg>
      {thinking && <span className="thinking-ring" aria-hidden />}
    </span>
  );
}

/** Quiet status line while the answer is being prepared. Fades via `leaving`. */
function ThinkingIndicator({ leaving = false }: { leaving?: boolean }) {
  return (
    <div
      className={`thinking-wrap flex items-center gap-2 py-0.5 ${leaving ? "is-leaving" : ""}`}
      role="status"
      aria-label="Thinking"
    >
      <span className="flex gap-1" aria-hidden>
        <span className="typing-dot h-1 w-1 rounded-full bg-zinc-500" />
        <span className="typing-dot h-1 w-1 rounded-full bg-zinc-500" />
        <span className="typing-dot h-1 w-1 rounded-full bg-zinc-500" />
      </span>
      <span className="text-xs font-medium text-zinc-500" aria-hidden>
        Thinking
      </span>
    </div>
  );
}

/** Media-query subscription as an external store — no setState-in-effect. */
function useReducedMotion(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === "undefined") return () => {};
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const getSnapshot = useCallback(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );
  const getServerSnapshot = useCallback(() => false, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Word-buffered reveal: incoming server chunks land at token pace (bursty),
 * but words are uncovered at a steady ~24/s via rAF, with a capped burst when
 * far behind — so text never stutters or dumps big blocks at once, and a
 * shortlist's cards are not held back by a long intro.
 * History messages (streaming=false) render instantly.
 */
function useSmoothWords(text: string, active: boolean, instant: boolean) {
  const words = useMemo(() => text.match(/\S+\s*|\s+/g) ?? [], [text]);
  const [shown, setShown] = useState(() => (active && !instant ? 0 : words.length));
  const shownRef = useRef(active && !instant ? 0 : words.length);
  const targetRef = useRef(words.length);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    targetRef.current = words.length;
    if (!activeRef.current && shownRef.current >= words.length) {
      shownRef.current = words.length;
      setShown(words.length);
    }
  }, [words.length]);

  const catchingUp = shown < words.length;
  const animating = (active || catchingUp) && !instant;

  useEffect(() => {
    if (!animating) return;
    targetRef.current = words.length;
    let raf = 0;
    let last = performance.now();
    const BASE_WPS = 24;
    const tick = (now: number) => {
      const target = targetRef.current;
      const current = shownRef.current;
      if (current >= target) {
        // Caught up with the stream — park the loop instead of re-scheduling
        // a no-op frame every tick. The deps below wake it when the next
        // token grows the target (or when animating flips back on).
        raf = 0;
        return;
      }
      const lag = target - current;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // Steady word pace; capped burst when far behind (stream finished
      // while we were still revealing).
      const step = lag > 48 ? Math.min(lag, 4 + dt * 60) : dt * BASE_WPS;
      const next = Math.min(target, current + step);
      shownRef.current = next;
      if (Math.floor(next) !== Math.floor(current)) setShown(Math.floor(next));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [animating, words.length]);

  const visible = instant || !animating ? text : words.slice(0, shown).join("");
  return { visible, animating };
}

/**
 * Split revealed markdown into independently-animated blocks: headings,
 * quotes and each list item animate in on their own; plain lines accumulate
 * into paragraph blocks. Tables and code fences stay whole (splitting them
 * would render broken fragments mid-stream).
 */
function splitStreamBlocks(md: string): string[] {
  const blocks: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) {
      blocks.push(para.join("\n"));
      para = [];
    }
  };
  for (const line of md.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^(#{1,6}\s+>|#{1,6}\s|>\s?|\s*([-*+]|\d{1,3}[.)])\s+\S)/.test(line)) {
      flush();
      blocks.push(line);
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/** One committed markdown block. Mounts once with a fade/slide entrance;
 *  in-place updates (growing last block) never replay the animation. */
const StreamBlock = memo(function StreamBlock({ text }: { text: string }) {
  return (
    <div className="stream-block-in">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Small icon button in the reply's action row. */
function MsgAction({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`grid h-6 w-6 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${
        active
          ? "bg-white/10 text-white"
          : "text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function ChatMessage({
  id,
  role,
  content,
  structured,
  streaming,
  activePlaceId,
  onFocusPlace,
  onOpenPlace,
  hoverPlaceId,
  onHoverPlace,
  chips,
  onChip,
  showChips,
  field,
  onSelectPlace,
  selectedName,
  feedback,
  onFeedback,
  showActions,
  onRegenerate,
  sources,
  weather,
  flights,
  travelers = 1,
  shelfProgress,
  onShelfPick,
}: ChatMessageProps) {
  const isUser = role === "user";
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    []
  );

  /**
   * The route appends a RAG footer ("--- **Sources:** [S1] …") to the intro so
   * citation ids resolve. Inline, that becomes a multi-line attribution wall
   * between the intro and the cards — and the same sources already render as
   * chips under the answer. Strip it from the prose; keep the chips.
   */
  const cleanText = useMemo(
    () =>
      stripMetaBlocks(content)
        .replace(/\n{2,}---\n\*\*Sources:\*\*[\s\S]*$/i, "")
        .trimEnd(),
    [content]
  );
  const cardItems = useMemo(() => {
    const items = itemsForAssistant(id, content, structured ?? undefined);
    // The reply's destination is a safe city hint for cards whose model
    // payload omitted it. It sharpens image lookups (e.g. a museum whose
    // Wikipedia page is found by name + city) without inventing a place.
    const city = structured?.destination?.trim();
    if (!city) return items;
    return items.map((item) =>
      item.city || item.type === "destination" ? item : { ...item, city }
    );
  }, [id, content, structured]);

  const copyAnswer = useCallback(() => {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard || !cleanText) return;
    void clipboard
      .writeText(cleanText)
      .then(() => {
        setCopied(true);
        if (copyTimer.current) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        /* clipboard denied — leave the button state unchanged */
      });
  }, [cleanText]);

  // Budget from the reply's own cost lines. A stop that matched a place card
  // is counted once (the card's cost), so the same charge never doubles up.
  const budget = useMemo(() => {
    if (!structured) return null;
    const consumed = new Set<string>();
    const entries: Array<{ label: string; category: string; cost: string; day?: number }> = [];
    const placesByName = structured.places.map((p) => ({ key: p.name.toLowerCase(), p }));
    for (const day of structured.itinerary) {
      for (const item of day.items) {
        if (!item.cost) continue;
        const needle = `${item.place} ${item.title}`.toLowerCase();
        const match = placesByName.find((e) => e.key.length >= 3 && needle.includes(e.key));
        if (match) consumed.add(match.key);
        entries.push({
          label: item.title,
          category: match?.p.category ?? "other",
          cost: item.cost,
          day: day.day,
        });
      }
    }
    for (const p of structured.places) {
      if (!p.cost || consumed.has(p.name.toLowerCase())) continue;
      entries.push({ label: p.name, category: p.category, cost: p.cost });
    }
    if (entries.length === 0) return null;
    return computeBudget(entries, travelers);
  }, [structured, travelers]);

  const selectableType: RecType | null =
    field === "hotel"
      ? "hotel"
      : field === "restaurants"
        ? "restaurant"
        : field === "attractions"
          ? "attraction"
          : null;

  const reducedMotion = useReducedMotion();
  const { visible, animating } = useSmoothWords(cleanText, Boolean(streaming), reducedMotion);

  // Committed blocks render as markdown (stable, animated once); the live
  // tail stays plain text so per-word updates never re-parse markdown.
  const { stable, tail } = useMemo(
    () => (animating ? partitionMarkdown(visible) : { stable: visible, tail: "" }),
    [animating, visible]
  );
  const blocks = useMemo(() => splitStreamBlocks(stable), [stable]);

  // Thinking indicator lingers 200ms fading out once the first word arrives.
  // "Leaving" is derived from having content — no state update in an effect.
  const hasContent = visible.length > 0;
  const [thinkingVisible, setThinkingVisible] = useState(true);
  const thinkingLeaving = thinkingVisible && hasContent;
  useEffect(() => {
    if (!hasContent || !thinkingVisible) return;
    const t = window.setTimeout(() => setThinkingVisible(false), 200);
    return () => window.clearTimeout(t);
  }, [hasContent, thinkingVisible]);

  // Tapping a card focuses the place: the map flies to its pin and opens the
  // card beside it. Details live behind that card's ⓘ button, so the
  // full-screen sheet no longer opens from here.
  const focusCard = useCallback(
    (cardId: string) => {
      onFocusPlace?.(cardId);
    },
    [onFocusPlace]
  );

  if (isUser) {
    return (
      <div
        className="animate-msg-in"
        data-message-id={id}
        data-msg-role="user"
      >
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm shadow-black/30"
            aria-hidden
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-7 2.2-7 5v1h14v-1c0-2.8-3-5-7-5Z" />
            </svg>
          </span>
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words pt-0.5 text-[15px] leading-body text-zinc-100 [overflow-wrap:anywhere]">
            {content}
          </div>
        </div>
        <div className="mt-4 h-px bg-white/[0.07]" aria-hidden />
      </div>
    );
  }

  const showThinking = Boolean(streaming) && thinkingVisible && !reducedMotion;
  const showDotsFallback = Boolean(streaming) && !hasContent && (reducedMotion || !thinkingVisible);
  const showCaret = animating && hasContent;
  const hasCards = cardItems.length > 0 && !animating;
  const hasChips = Boolean(showChips && !streaming && chips && chips.length > 0 && onChip);

  const hasItinerary = Boolean(structured && structured.itinerary.length > 0) && !animating;
  const followUp = !animating ? (structured?.followUpQuestion.trim() ?? "") : "";

  return (
    <div className="animate-msg-in" data-message-id={id} data-msg-role={role}>
      <div className="flex items-start gap-3">
        <AssistantAvatar thinking={showThinking} />

        <div className="w-full min-w-0 text-md leading-body text-zinc-300 chat-markdown">
        {(showThinking || showDotsFallback || hasContent) && (
          <div className="max-w-none">
            {showThinking && <ThinkingIndicator leaving={thinkingLeaving} />}
            {showDotsFallback && (
              <div className="flex gap-2 py-1" role="status" aria-label="Thinking">
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-400/80" />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-400/80" />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-400/80" />
              </div>
            )}
            {hasContent && (
              <div className="min-h-[1.4em] max-w-3xl">
                {blocks.map((b, i) => (
                  <StreamBlock key={i} text={b} />
                ))}
                {(tail || (showCaret && blocks.length === 0)) && (
                  <p className="mb-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-body">
                    {tail}
                    {showCaret && <span className="stream-caret" aria-hidden />}
                  </p>
                )}
                {showCaret && !tail && blocks.length > 0 && (
                  <span className="stream-caret" aria-hidden />
                )}
              </div>
            )}
          </div>
        )}

        {hasCards &&
          (structured ? (
            <StructuredCards
              items={cardItems}
              activeId={activePlaceId}
              hoverId={hoverPlaceId}
              onFocus={focusCard}
              onHover={onHoverPlace}
              selectableType={selectableType}
              onSelect={onSelectPlace}
              selectedName={selectedName}
              onDetails={onOpenPlace}
              progress={shelfProgress}
              onPick={onShelfPick}
            />
          ) : (
            <div className="mt-3 animate-card-group-in">
              <RecommendationCards
                items={singleShelf(cardItems)}
                layout="row"
                activeId={activePlaceId}
                hoverId={hoverPlaceId}
                onFocus={focusCard}
                onHover={onHoverPlace}
                selectableType={selectableType}
                onSelect={onSelectPlace}
                selectedName={selectedName}
                onDetails={onOpenPlace}
              />
            </div>
          ))}

        {hasItinerary && (
          <ItineraryTimeline
            days={structured!.itinerary}
            places={cardItems}
            onFocus={focusCard}
            onOpenPlace={onOpenPlace}
          />
        )}

        {!animating && sources && sources.length > 0 && <SourceChips sources={sources} />}

        {!animating && weather && weather.days.length > 0 && <WeatherCard weather={weather} />}

        {!animating && flights && flights.offers.length > 0 && (
          <FlightCard
            offers={flights.offers}
            from={flights.from}
            to={flights.to}
            date={flights.date}
            returnDate={flights.returnDate}
            fetchedAt={flights.fetchedAt}
          />
        )}

        {!animating && budget && <BudgetCard summary={budget} travelers={travelers} />}

        {followUp && (
          <p className="mt-4 text-[15px] font-medium leading-body text-zinc-100 [overflow-wrap:anywhere]">
            {followUp}
          </p>
        )}

        {hasChips && (
          <div className="mt-3 flex flex-wrap gap-2">
            {chips!.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => onChip!(chip)}
                className="chip focus-ring"
              >
                {chip}
              </button>
            ))}
          </div>
        )}

        {!streaming && Boolean(content) && (
          <div className="mt-2 flex items-center gap-1">
            {showActions && (
              <>
                <MsgAction
                  label="Good reply"
                  active={feedback === "up"}
                  onClick={() => onFeedback?.(id, "up")}
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"
                    />
                  </svg>
                </MsgAction>
                <MsgAction
                  label="Bad reply"
                  active={feedback === "down"}
                  onClick={() => onFeedback?.(id, "down")}
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"
                    />
                  </svg>
                </MsgAction>
                {onRegenerate && (
                  <button
                    type="button"
                    onClick={onRegenerate}
                    className="ml-1 inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-2xs font-medium text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.8}
                      viewBox="0 0 24 24"
                      aria-hidden
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"
                      />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 3v5h-5" />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"
                      />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H3v5" />
                    </svg>
                    Regenerate
                  </button>
                )}
              </>
            )}
            <MsgAction
              label={copied ? "Copied" : "Copy answer"}
              active={copied}
              onClick={copyAnswer}
            >
              {copied ? (
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="m5 12 4.5 4.5L19 7" />
                </svg>
              ) : (
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  viewBox="0 0 24 24"
                  aria-hidden
                >
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 15V5a2 2 0 0 1 2-2h8" />
                </svg>
              )}
            </MsgAction>
            {copied && (
              <span className="text-2xs font-medium text-emerald-300" role="status">
                Copied
              </span>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

export default memo(ChatMessage);
