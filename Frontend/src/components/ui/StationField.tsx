"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { StationSuggestion } from "@/lib/trains";

interface StationFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  onInputChange: (value: string) => void;
  onSelect: (suggestion: StationSuggestion) => void;
}

const inputCls =
  "w-full rounded-xl border border-white/10 bg-surface-2 px-4 py-3 text-base text-ink placeholder-zinc-500 outline-none transition-all focus:border-accent/50 focus:ring-4 focus:ring-blue-500/20";

function StationGlyph() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 4h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM5 10.5h14M9 16l-2.5 4M15 16l2.5 4"
      />
    </svg>
  );
}

export default function StationField({
  label,
  value,
  placeholder,
  onInputChange,
  onSelect,
}: StationFieldProps) {
  const [items, setItems] = useState<StationSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typedRef = useRef(false);
  const listboxId = useId();

  useEffect(() => {
    if (!typedRef.current) return;
    const q = value.trim();
    if (q.length < 2) return;
    const ac = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/trains", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "autocomplete", q }),
          signal: ac.signal,
        });
        const data = await res.json();
        const list: StationSuggestion[] = Array.isArray(data?.suggestions) ? data.suggestions : [];
        setItems(list);
        setActive(0);
        setOpen(list.length > 0);
      } catch {
        /* aborted or network hiccup — keep current state */
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [value]);

  const choose = (s: StationSuggestion) => {
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
      <span className="mb-2 block text-sm font-medium text-ink-faint">{label}</span>
      <div className="relative">
        <input
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          onChange={(e) => {
            typedRef.current = true;
            const v = e.target.value;
            if (v.trim().length < 2) {
              setItems([]);
              setOpen(false);
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
          className={inputCls}
        />
        {open && items.length > 0 && (
          <ul
            role="listbox"
            id={listboxId}
            className="absolute left-0 right-0 top-full z-30 mt-2 max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-zinc-900 py-1 shadow-2xl shadow-black/60 dark-scroll"
          >
            {items.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(s)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                    i === active ? "bg-accent/15" : "hover:bg-surface-2"
                  }`}
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-300">
                    <StationGlyph />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium text-ink">
                      {s.name}
                    </span>
                    <span className="block truncate text-xs text-ink-faint">
                      {s.type === "station" ? "Station" : "Stop"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
