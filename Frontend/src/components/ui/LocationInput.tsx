"use client";

import { useState, useEffect, useRef, useCallback, useId } from "react";
import { geocodePlace, type PlaceSuggestion } from "@/lib/osrm";

interface LocationInputProps {
  label: string;
  value: string;
  onChange: (value: string, coords?: { lat: number; lng: number }) => void;
  placeholder?: string;
  dark?: boolean;
  /** ISO country code(s) — confines the suggestions to that country. */
  countryCodes?: string;
  /** Blocks typing (used until the planner knows which country to search). */
  disabled?: boolean;
}

export default function LocationInput({
  label,
  value,
  onChange,
  placeholder = "Search city or address...",
  dark = false,
  countryCodes,
  disabled = false,
}: LocationInputProps) {
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const listId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const [searched, setSearched] = useState(false);

  const search = useCallback(
    async (q: string) => {
      const seq = ++seqRef.current;
      if (disabled || q.length < 3) {
        setSuggestions([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const results = await geocodePlace(q, countryCodes);
        if (seq !== seqRef.current) return;
        setSuggestions(results);
        setActiveIndex(0);
        setSearched(true);
        setOpen(true);
      } catch {
        if (seq === seqRef.current) {
          setSuggestions([]);
          setSearched(true);
        }
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [countryCodes, disabled]
  );

  const chooseSuggestion = useCallback(
    (s: PlaceSuggestion) => {
      onChange(s.place_name, { lat: s.center[1], lng: s.center[0] });
      setOpen(false);
    },
    [onChange]
  );

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" && open && suggestions.length > 0) {
      e.preventDefault();
      chooseSuggestion(suggestions[activeIndex] ?? suggestions[0]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(value), 400);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, search]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={wrapperRef} className="relative">
      <label
        className={`block text-sm font-medium mb-2 ${dark ? "text-zinc-300" : "text-gray-700"}`}
      >
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-busy={loading}
        className={`w-full px-4 py-3 border rounded-lg outline-none text-md transition-colors ${
          dark
            ? "border-zinc-700 bg-zinc-950/60 text-ink placeholder-zinc-500 focus:border-accent focus:ring-2 focus:ring-blue-500/25 disabled:cursor-not-allowed disabled:opacity-50 disabled:focus:ring-0"
            : "border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-400"
        }`}
      />
      {loading && (
        <div
          role="status"
          className={`absolute right-3 top-[42px] text-sm ${dark ? "text-ink-muted" : "text-gray-500"}`}
        >
          Searching...
        </div>
      )}
      {open && !disabled && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className={`absolute z-50 w-full mt-1 rounded-lg shadow-lg max-h-60 overflow-auto ${
            dark ? "bg-zinc-900 border border-white/10" : "bg-white border border-gray-200"
          }`}
        >
          {!loading && searched && suggestions.length === 0 && (
            <li className={`px-4 py-3 text-sm ${dark ? "text-ink-muted" : "text-gray-500"}`}>
              No places found. Try another search.
            </li>
          )}
          {suggestions.map((s, i) => (
            <li key={i} role="option" aria-selected={i === activeIndex}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(i)}
                onFocus={() => setActiveIndex(i)}
                className={`flex min-h-touch w-full items-center px-4 py-3 cursor-pointer text-sm border-b last:border-0 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/60 ${
                  dark
                    ? `text-zinc-200 border-white/[0.06] hover:bg-surface-2 ${i === activeIndex ? "bg-surface-2" : ""}`
                    : `text-gray-700 border-gray-100 hover:bg-blue-50 ${i === activeIndex ? "bg-blue-50" : ""}`
                }`}
                onClick={() => chooseSuggestion(s)}
              >
                <span className="truncate">{s.place_name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
