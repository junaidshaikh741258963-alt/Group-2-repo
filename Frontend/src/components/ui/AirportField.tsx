"use client";

import { useEffect, useId, useRef, useState } from "react";

export type { AirportSuggestion } from "@/lib/airports";
import type { AirportSuggestion } from "@/lib/airports";

interface AirportFieldProps {
  label: string;
  value: string;
  placeholder: string;
  onInputChange: (value: string) => void;
  onSelect: (suggestion: AirportSuggestion) => void;
  /** Extra classes for the input (e.g. `h-12` to match sibling fields). */
  inputClassName?: string;
}

export function suggestionLabel(s: AirportSuggestion): string {
  return s.code ? `${s.title} (${s.code})` : s.title;
}

export function suggestionCode(s: AirportSuggestion): string {
  return s.airports[0]?.code || s.id;
}

const inputCls =
  "w-full rounded-xl border border-white/10 bg-surface-2 px-4 py-3 text-base text-ink placeholder-zinc-500 outline-none transition-all focus:border-accent/50 focus:ring-4 focus:ring-blue-500/20";

export default function AirportField({
  label,
  value,
  placeholder,
  onInputChange,
  onSelect,
  inputClassName,
}: AirportFieldProps) {
  const [items, setItems] = useState<AirportSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const typedRef = useRef(false);
  const listboxId = useId();
  const inputId = useId();

  useEffect(() => {
    if (!typedRef.current) return;
    const q = value.trim();
    if (q.length < 2) return;
    const ac = new AbortController();
    // Debounced 300 ms; the searching/loading flags flip inside the timer
    // callback (never synchronously in the effect body).
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch("/api/flights", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "autocomplete", q }),
          signal: ac.signal,
        });
        const data = await res.json();
        const list: AirportSuggestion[] = Array.isArray(data?.suggestions) ? data.suggestions : [];
        setItems(list);
        setActive(0);
        setSearched(true);
        setOpen(list.length > 0);
      } catch {
        /* aborted or network hiccup — keep current state */
      } finally {
        if (!ac.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [value]);

  const choose = (s: AirportSuggestion) => {
    typedRef.current = false;
    setItems([]);
    setOpen(false);
    onSelect(s);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active] ?? items[0]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="block">
      <label htmlFor={inputId} className="mb-2 block text-sm font-medium text-ink-muted">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-busy={searching}
          onChange={(e) => {
            typedRef.current = true;
            const v = e.target.value;
            if (v.trim().length < 2) {
              setItems([]);
              setOpen(false);
              setSearched(false);
            }
            onInputChange(v);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 120);
            typedRef.current = false;
          }}
          onFocus={() => {
            if (typedRef.current && items.length > 0) setOpen(true);
          }}
          className={`${inputCls}${inputClassName ? ` ${inputClassName}` : ""}`}
        />
        {open && (
          <ul
            role="listbox"
            id={listboxId}
            aria-label={`${label} suggestions`}
            className="absolute left-0 right-0 top-full z-30 mt-2 max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-zinc-900 py-1 shadow-2xl shadow-black/60 dark-scroll"
          >
            {searching && items.length === 0 && (
              <li className="px-3 py-3 text-sm text-ink-muted" role="status">
                Searching…
              </li>
            )}
            {!searching && searched && items.length === 0 && (
              <li className="px-3 py-3 text-sm text-ink-muted">
                No airports found. Try another spelling.
              </li>
            )}
            {items.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onClick={() => choose(s)}
                  className={`flex min-h-touch w-full items-center gap-3 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/60 ${
                    i === active ? "bg-accent/15" : "hover:bg-surface-2"
                  }`}
                >
                  <span
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
                      s.type === "city"
                        ? "bg-accent/15 text-blue-300"
                        : "bg-surface-2 text-ink-muted"
                    }`}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      {s.type === "city" ? (
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M17.657 16.657 13.414 20.9a2 2 0 0 1-2.828 0l-4.244-4.243a8 8 0 1 1 11.315 0z"
                        />
                      ) : (
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                        />
                      )}
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium text-ink">
                      {s.title}
                    </span>
                    {s.subtitle && (
                      <span className="block truncate text-xs text-ink-muted">
                        {s.subtitle}
                      </span>
                    )}
                  </span>
                  {s.airports.length > 1 ? (
                    <span className="flex shrink-0 gap-1">
                      {s.airports.slice(0, 3).map((a) => (
                        <span
                          key={a.code}
                          className="rounded-md bg-surface-2 px-2 py-1 text-2xs font-bold tracking-wide text-ink-muted"
                        >
                          {a.code}
                        </span>
                      ))}
                    </span>
                  ) : s.code ? (
                    <span className="shrink-0 rounded-md bg-accent/15 px-2 py-1 text-2xs font-bold tracking-wide text-blue-300">
                      {s.code}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
