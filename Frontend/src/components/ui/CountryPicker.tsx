"use client";

import { useEffect, useRef, useState, useId } from "react";
import { searchCountries, type Country } from "@/lib/countries";

interface CountryPickerProps {
  value: Country | null;
  onChange: (country: Country | null) => void;
}

/**
 * Step 1 of the route planner: pick the country first, so the From/To
 * suggestions that follow can be confined to it.
 */
export default function CountryPicker({ value, onChange }: CountryPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const options = searchCountries(query, 8);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const choose = (c: Country) => {
    onChange(c);
    setQuery("");
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % Math.max(options.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + options.length) % Math.max(options.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = options[activeIndex] ?? options[0];
      if (open && pick) choose(pick);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      {value ? (
        <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 px-3 py-3">
          <span className="text-2xl leading-none" aria-hidden="true">
            {value.flag}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold text-ink">{value.name}</div>
            <div className="text-2xs font-medium uppercase tracking-wide text-blue-300/80">
              {value.code} · suggestions limited to this country
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setQuery("");
              setActiveIndex(0);
              setOpen(true);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
            className="shrink-0 rounded-lg border border-white/10 bg-surface-2 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/[0.12] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            Change
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <span
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-md"
              aria-hidden="true"
            >
              🌍
            </span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={handleKeyDown}
              placeholder="Search a country… e.g. France"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-label="Country"
              className="w-full rounded-xl border border-white/10 bg-zinc-950/60 py-3 pl-8 pr-4 text-md text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-blue-500/25"
            />
          </div>

          {open && (
            <ul
              id={listId}
              role="listbox"
              aria-label="Country suggestions"
              className="absolute z-50 mt-1 w-full overflow-auto rounded-xl border border-white/10 bg-zinc-900 shadow-xl max-h-64 dark-scroll"
            >
              {options.length === 0 && (
                <li className="px-4 py-3 text-sm text-ink-muted">No country matches “{query}”.</li>
              )}
              {options.map((c, i) => (
                <li key={c.code} role="option" aria-selected={i === activeIndex}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => choose(c)}
                    className={`flex min-h-touch w-full items-center gap-3 border-b border-white/[0.06] px-4 py-3 text-left text-sm text-zinc-200 transition-colors last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/60 ${
                      i === activeIndex ? "bg-surface-3" : "hover:bg-surface-2"
                    }`}
                  >
                    <span className="text-lg leading-none" aria-hidden="true">
                      {c.flag}
                    </span>
                    <span className="truncate">{c.name}</span>
                    <span className="ml-auto text-2xs font-medium uppercase text-ink-faint">
                      {c.code}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
