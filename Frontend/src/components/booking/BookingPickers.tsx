"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useExitTransition } from "@/lib/useExitTransition";
import { dayLabel, isoDateInDays } from "@/lib/bookingFormat";

const LABEL = "mb-2 block text-sm font-medium text-ink-muted";
const TRIGGER =
  "group relative flex h-12 w-full cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-surface-2 pl-8 pr-8 text-left text-base text-ink outline-none transition-colors focus:border-accent/50 focus:ring-4 focus:ring-blue-500/20";
const NAV_BTN =
  "relative grid h-8 w-8 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink disabled:text-zinc-700 disabled:hover:bg-transparent disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 hit-44-sm";
const STEP_BTN =
  "relative grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-surface-2 text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.12] hover:text-white disabled:cursor-not-allowed disabled:border-white/[0.06] disabled:bg-surface-1 disabled:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 hit-44-sm";

/* ————— icons (same 24 stroke style as the rest of the app) ————— */

function CalendarIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 2v4M16 2v4M3 10h18" />
      <rect x="3" y="4" width="18" height="18" rx="2" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"
      />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path strokeLinecap="round" d="M5 12h14" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path strokeLinecap="round" d="M12 5v14M5 12h14" />
    </svg>
  );
}

/* ————— popover positioning (portal: never clipped by ancestors) ————— */

const PANEL_GAP = 8;
const PANEL_PAD = 8;

/** Fixed position under the trigger, auto-flipped upward when there's no room. */
function positionAnchored(panel: HTMLElement, anchor: HTMLElement, width: number | "anchor") {
  const rect = anchor.getBoundingClientRect();
  const w = width === "anchor" ? Math.round(rect.width) : width;
  panel.style.position = "fixed";
  panel.style.width = `${w}px`;
  panel.style.maxHeight = `${Math.max(240, window.innerHeight - 2 * PANEL_PAD)}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";

  const h = panel.offsetHeight;
  let top = rect.bottom + PANEL_GAP;
  if (top + h > window.innerHeight - PANEL_PAD && rect.top - PANEL_GAP - h >= PANEL_PAD) {
    top = rect.top - PANEL_GAP - h;
  }
  top = Math.min(Math.max(PANEL_PAD, top), Math.max(PANEL_PAD, window.innerHeight - h - PANEL_PAD));
  const left = Math.min(
    Math.max(PANEL_PAD, rect.left),
    Math.max(PANEL_PAD, window.innerWidth - w - PANEL_PAD)
  );
  panel.style.top = `${Math.round(top)}px`;
  panel.style.left = `${Math.round(left)}px`;
}

/** Full-width bottom sheet for small screens. */
function positionSheet(panel: HTMLElement) {
  panel.style.position = "fixed";
  panel.style.top = "auto";
  panel.style.bottom = "0";
  panel.style.left = "0";
  panel.style.right = "0";
  panel.style.width = "auto";
  panel.style.maxHeight = "85svh";
}

function usePicker(width: number | "anchor") {
  const [open, setOpen] = useState(false);
  const [mounted, closing] = useExitTransition(open, 150);
  const [sheet, setSheet] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Small screens swap the anchored popover for a bottom sheet.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setSheet(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Close on outside click and Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Place after paint (the panel starts visibility:hidden, so nothing flashes),
  // then keep it glued to the trigger while the page scrolls or resizes.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const anchor = triggerRef.current;
    if (!panel || !anchor) return;

    const place = () => {
      if (sheet) positionSheet(panel);
      else positionAnchored(panel, anchor, width);
      panel.style.visibility = "visible";
    };
    place();

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (panelRef.current && triggerRef.current) place();
      });
    };
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [open, sheet, width]);

  // Only ever called from event handlers, never during render.
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return { open, mounted, closing, sheet, wrapRef, triggerRef, panelRef, close, setOpen };
}

/* ————— shared shell: label + trigger button + portaled popover panel ————— */

interface PickerFieldProps {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  display: string;
  muted?: boolean;
  open: boolean;
  mounted: boolean;
  closing: boolean;
  sheet: boolean;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  panelRef: React.RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  panelTitle: string;
  panel?: React.ReactNode;
}

function PickerField({
  id,
  label,
  hint,
  icon,
  display,
  muted = false,
  open,
  mounted,
  closing,
  sheet,
  wrapRef,
  triggerRef,
  panelRef,
  onToggle,
  panelTitle,
  panel,
}: PickerFieldProps) {
  return (
    <div className="block" ref={wrapRef}>
      <label className={LABEL} htmlFor={id}>
        {label}
        {hint && <span className="ml-1 normal-case font-medium text-zinc-600">{hint}</span>}
      </label>
      <div className="relative">
        <button
          type="button"
          id={id}
          ref={triggerRef}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={onToggle}
          className={`${TRIGGER}${open ? " border-accent/50 ring-4 ring-blue-500/20" : ""}`}
        >
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint transition-colors group-focus:text-blue-400">
            {icon}
          </span>
          <span className={`min-w-0 flex-1 truncate ${muted ? "text-ink-faint" : "text-ink"}`}>
            {display}
          </span>
          <span
            className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint transition-transform ${
              open ? "rotate-180" : ""
            }`}
          >
            <ChevronDownIcon />
          </span>
        </button>
      </div>

      {mounted &&
        createPortal(
          <>
            {sheet && (
              <div
                aria-hidden
                className={`fixed inset-0 z-[1450] bg-black/55 ${
                  closing ? "animate-exit" : "animate-fade-in"
                }`}
              />
            )}
            <div
              ref={panelRef}
              role="dialog"
              aria-label={panelTitle}
              style={{ visibility: "hidden" }}
              className={`fixed z-[1500] overflow-y-auto border border-white/10 bg-zinc-900 shadow-2xl shadow-black/70 dark-scroll ${
                sheet ? "inset-x-0 bottom-0 rounded-t-2xl p-3" : "rounded-xl p-2"
              } ${
                closing
                  ? "pointer-events-none animate-exit"
                  : sheet
                    ? "animate-sheet-in"
                    : "animate-fade-in"
              }`}
            >
              {sheet && (
                <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/20" />
              )}
              {panel}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}

/* ————— date helpers ————— */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseYmd(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00`);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DATE_PANEL_WIDTH = 320;

/* ————— calendar panel ————— */

interface CalendarPanelProps {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  min?: string;
  max?: string;
  /** Highlights the span between this date and `value` (return-date calendars). */
  rangeStart?: string;
  today: string;
}

function CalendarPanel({
  value,
  onChange,
  onClear,
  min,
  max,
  rangeStart,
  today,
}: CalendarPanelProps) {
  const clamp = (s: string) => {
    if (min && s < min) return min;
    if (max && s > max) return max;
    return s;
  };
  const seed = clamp(value || min || rangeStart || today);

  const [cursor, setCursor] = useState(seed);
  const [view, setView] = useState(() => monthStart(parseYmd(seed)));
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    dayRefs.current.get(cursor)?.focus();
  }, [cursor]);

  const goTo = (s: string) => {
    const next = clamp(s);
    setCursor(next);
    setView(monthStart(parseYmd(next)));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const current = parseYmd(cursor);
    let next: Date | null = null;
    if (e.key === "ArrowLeft") next = addDays(current, -1);
    else if (e.key === "ArrowRight") next = addDays(current, 1);
    else if (e.key === "ArrowUp") next = addDays(current, -7);
    else if (e.key === "ArrowDown") next = addDays(current, 7);
    else if (e.key === "Home") next = new Date(current.getFullYear(), current.getMonth(), 1);
    else if (e.key === "End") next = new Date(current.getFullYear(), current.getMonth() + 1, 0);
    if (!next) return;
    e.preventDefault();
    goTo(ymd(next));
  };

  const y = view.getFullYear();
  const m = view.getMonth();
  const firstDow = new Date(y, m, 1).getDay();
  const numDays = new Date(y, m + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: numDays }, (_, i) => `${y}-${pad2(m + 1)}-${pad2(i + 1)}`),
  ];

  const viewKey = `${y}-${pad2(m + 1)}-01`;
  const prevDisabled = Boolean(min && viewKey <= min);
  const nextFirst = ymd(new Date(y, m + 1, 1));
  const nextDisabled = Boolean(max && nextFirst > max);
  const todayDisabled = Boolean((min && today < min) || (max && today > max));
  const hasRange = Boolean(rangeStart && value && rangeStart !== value);

  return (
    <div className="mx-auto w-76">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          disabled={prevDisabled}
          onClick={() => setView(new Date(y, m - 1, 1))}
          className={NAV_BTN}
        >
          <ChevronLeftIcon />
        </button>
        <span className="text-base font-semibold tracking-tight text-ink">
          {view.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </span>
        <button
          type="button"
          aria-label="Next month"
          disabled={nextDisabled}
          onClick={() => setView(new Date(y, m + 1, 1))}
          className={NAV_BTN}
        >
          <ChevronRightIcon />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1" aria-hidden>
        {WEEKDAYS.map((d) => (
          <span
            key={d}
            className="grid h-7 place-items-center text-xs font-medium text-zinc-600"
          >
            {d}
          </span>
        ))}
      </div>

      <div
        className="grid grid-cols-7 gap-1"
        role="group"
        aria-label="Select a day"
        onKeyDown={onKeyDown}
      >
        {cells.map((s, i) => {
          if (!s) return <span key={`pad-${i}`} aria-hidden />;
          const disabled = Boolean((min && s < min) || (max && s > max));
          const selected = s === value;
          const isToday = s === today;
          const inRange = hasRange && s > (rangeStart as string) && s < value;
          const isRangeStart = hasRange && s === rangeStart;
          return (
            <button
              key={s}
              type="button"
              ref={(el) => {
                if (el) dayRefs.current.set(s, el);
                else dayRefs.current.delete(s);
              }}
              tabIndex={s === cursor ? 0 : -1}
              disabled={disabled}
              aria-pressed={selected}
              aria-current={isToday ? "date" : undefined}
              aria-label={parseYmd(s).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
              onClick={() => onChange(s)}
              className={`grid h-10 w-10 place-items-center rounded-lg text-base font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500/70 ${
                selected
                  ? "bg-accent-strong text-white shadow-sm shadow-blue-950/50"
                  : disabled
                    ? "cursor-not-allowed text-zinc-700"
                    : inRange
                      ? "bg-accent/20 text-blue-100"
                      : isRangeStart
                        ? "bg-accent/40 text-blue-50"
                        : isToday
                          ? "text-blue-300 ring-1 ring-inset ring-blue-500/40 hover:bg-accent/10"
                          : "text-zinc-200 hover:bg-surface-3"
              }`}
            >
              {Number(s.slice(8))}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-hairline px-1 pt-2">
        <button
          type="button"
          disabled={todayDisabled}
          onClick={() => onChange(today)}
          className="rounded-lg px-3 py-2 text-sm font-semibold text-blue-300 transition-colors hover:bg-accent/10 hover:text-blue-200 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
        >
          Today
        </button>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-3 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/* ————— exported pickers ————— */

interface DateFieldProps {
  label: string;
  hint?: string;
  /** "YYYY-MM-DD"; empty string shows the placeholder. */
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  /** Highlights the range from this date to `value` (return-date calendars). */
  rangeStart?: string;
  /** Shows a Clear action (for optional dates). */
  clearable?: boolean;
  placeholder?: string;
}

export function DateField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  rangeStart,
  clearable,
  placeholder = "Pick a date",
}: DateFieldProps) {
  const id = useId();
  const { open, mounted, closing, sheet, wrapRef, triggerRef, panelRef, close, setOpen } =
    usePicker(DATE_PANEL_WIDTH);
  const valid = ISO_RE.test(value);
  const today = isoDateInDays(0);

  return (
    <PickerField
      id={id}
      label={label}
      hint={hint}
      icon={<CalendarIcon />}
      display={valid ? dayLabel(value) : placeholder}
      muted={!valid}
      panelTitle={`${label} calendar`}
      open={open}
      mounted={mounted}
      closing={closing}
      sheet={sheet}
      wrapRef={wrapRef}
      triggerRef={triggerRef}
      panelRef={panelRef}
      onToggle={() => {
        if (open) triggerRef.current?.focus();
        setOpen(!open);
      }}
      panel={
        mounted ? (
          <CalendarPanel
            value={valid ? value : ""}
            min={min}
            max={max}
            rangeStart={rangeStart}
            today={today}
            onChange={(v) => {
              onChange(v);
              close();
            }}
            onClear={
              clearable
                ? () => {
                    onChange("");
                    close();
                  }
                : undefined
            }
          />
        ) : null
      }
    />
  );
}

const TIME_STEP_MIN = 30;

interface TimeFieldProps {
  label: string;
  hint?: string;
  /** "HH:MM" 24h. */
  value: string;
  onChange: (value: string) => void;
}

export function TimeField({ label, hint, value, onChange }: TimeFieldProps) {
  const id = useId();
  const { open, mounted, closing, sheet, wrapRef, triggerRef, panelRef, close, setOpen } =
    usePicker(244);

  const allTimes = Array.from({ length: Math.ceil((24 * 60) / TIME_STEP_MIN) }, (_, i) => {
    const mins = i * TIME_STEP_MIN;
    return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
  });
  const inGrid = allTimes.includes(value);
  const selRef = useRef<HTMLButtonElement | null>(null);
  const exactRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (mounted) (selRef.current ?? exactRef.current)?.focus();
  }, [mounted]);

  return (
    <PickerField
      id={id}
      label={label}
      hint={hint}
      icon={<ClockIcon />}
      display={value || "--:--"}
      panelTitle={`${label} time`}
      open={open}
      mounted={mounted}
      closing={closing}
      sheet={sheet}
      wrapRef={wrapRef}
      triggerRef={triggerRef}
      panelRef={panelRef}
      onToggle={() => {
        if (open) triggerRef.current?.focus();
        setOpen(!open);
      }}
      panel={
        mounted ? (
          <div>
            <div className="grid grid-cols-4 gap-1">
              {allTimes.map((t) => (
                <button
                  key={t}
                  type="button"
                  ref={inGrid && t === value ? selRef : undefined}
                  onClick={() => {
                    onChange(t);
                    close();
                  }}
                  className={`rounded-lg px-1 py-2 text-sm tabular-nums transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500/70 ${
                    t === value
                      ? "bg-accent-strong font-semibold text-white shadow-sm shadow-blue-950/50"
                      : "text-zinc-300 hover:bg-surface-3 hover:text-ink"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 border-t border-hairline px-1 pt-2">
              <span className="text-xs font-medium text-zinc-600">Exact</span>
              <input
                type="time"
                step={900}
                value={value}
                aria-label="Exact time"
                ref={exactRef}
                onChange={(e) => {
                  if (e.target.value) onChange(e.target.value);
                }}
                className="ml-auto w-27.5 rounded-lg border border-white/10 bg-surface-2 px-2 py-2 text-sm text-ink outline-none transition-all focus:border-accent/50 focus:ring-2 focus:ring-blue-500/20 [color-scheme:dark]"
              />
            </div>
          </div>
        ) : null
      }
    />
  );
}

export interface PassengerCounts {
  adults: number;
  children: number;
  infants: number;
}

/** "2 adults, 1 child" — used for the trigger text and the form hint. */
export function passengerSummary(v: PassengerCounts): string {
  const parts = [`${v.adults} ${v.adults === 1 ? "adult" : "adults"}`];
  if (v.children > 0) parts.push(`${v.children} ${v.children === 1 ? "child" : "children"}`);
  if (v.infants > 0) parts.push(`${v.infants} ${v.infants === 1 ? "infant" : "infants"}`);
  return parts.join(", ");
}

const PAX_ROWS = [
  {
    key: "adults",
    title: "Adults",
    sub: "Ages 12 and over",
    min: 1,
    add: "Add one adult",
    remove: "Remove one adult",
  },
  {
    key: "children",
    title: "Children",
    sub: "Ages 2 to 11",
    min: 0,
    add: "Add one child",
    remove: "Remove one child",
  },
  {
    key: "infants",
    title: "Infants",
    sub: "Under 2",
    min: 0,
    add: "Add one infant",
    remove: "Remove one infant",
  },
] as const;

interface PassengerFieldProps {
  label?: string;
  hint?: string;
  value: PassengerCounts;
  onChange: (value: PassengerCounts) => void;
  /** Maximum travelers per booking (adults + children + infants). */
  max?: number;
}

export function PassengerField({
  label = "Passengers",
  hint,
  value,
  onChange,
  max = 9,
}: PassengerFieldProps) {
  const id = useId();
  const { open, mounted, closing, sheet, wrapRef, triggerRef, panelRef, close, setOpen } =
    usePicker("anchor");
  const rootRef = useRef<HTMLDivElement>(null);
  const total = value.adults + value.children + value.infants;

  useEffect(() => {
    if (open) rootRef.current?.focus();
  }, [open]);

  const setCount = (key: keyof PassengerCounts, next: number) => {
    onChange({ ...value, [key]: next });
  };

  return (
    <PickerField
      id={id}
      label={label}
      hint={hint}
      icon={<UserIcon />}
      display={passengerSummary(value)}
      panelTitle={`${label} picker`}
      open={open}
      mounted={mounted}
      closing={closing}
      sheet={sheet}
      wrapRef={wrapRef}
      triggerRef={triggerRef}
      panelRef={panelRef}
      onToggle={() => {
        if (open) triggerRef.current?.focus();
        setOpen(!open);
      }}
      panel={
        mounted ? (
          <div ref={rootRef} tabIndex={-1} className="outline-none">
            <div className="space-y-2">
              {PAX_ROWS.map((row) => {
                const count = value[row.key];
                const atMin = count <= row.min;
                const atMax = total >= max;
                return (
                  <div
                    key={row.key}
                    className="flex items-center justify-between gap-3 rounded-xl border border-hairline bg-surface-1 px-3 py-3"
                  >
                    <div className="min-w-0">
                      <div className="text-base font-semibold text-ink">{row.title}</div>
                      <div className="text-xs text-ink-faint">{row.sub}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        aria-label={row.remove}
                        disabled={atMin}
                        onClick={() => setCount(row.key, count - 1)}
                        className={STEP_BTN}
                      >
                        <MinusIcon />
                      </button>
                      <span className="w-5 text-center text-md font-bold tabular-nums text-ink">
                        {count}
                      </span>
                      <button
                        type="button"
                        aria-label={row.add}
                        disabled={atMax}
                        onClick={() => setCount(row.key, count + 1)}
                        className={STEP_BTN}
                      >
                        <PlusIcon />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="mt-3 px-1 text-xs text-ink-faint">
              {total} of {max} travelers
            </p>

            <button
              type="button"
              onClick={close}
              className="mt-2 h-11 w-full rounded-xl bg-accent-strong text-base font-semibold text-white transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/30"
            >
              Done
            </button>
          </div>
        ) : null
      }
    />
  );
}
