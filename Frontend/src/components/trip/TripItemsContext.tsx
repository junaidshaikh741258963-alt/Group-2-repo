"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createTripItem,
  loadTripItems,
  saveTripItems,
  tripItemKey,
  TRIP_MAX_ITEMS,
  type TripItem,
  type TripItemInput,
} from "@/lib/tripItems";

interface TripItemsValue {
  items: TripItem[];
  count: number;
  /** True once the board has hit `TRIP_MAX_ITEMS` — adds are refused. */
  full: boolean;
  has: (category: TripItem["category"], name: string) => boolean;
  hasKey: (key: string) => boolean;
  add: (input: TripItemInput) => string;
  remove: (key: string) => void;
  move: (key: string, dir: -1 | 1) => void;
  reorder: (from: number, to: number) => void;
  clear: () => void;
}

const TripItemsContext = createContext<TripItemsValue | null>(null);

export function TripItemsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<TripItem[]>([]);
  const hydrated = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setItems(loadTripItems());
      hydrated.current = true;
    }, 0);

    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === "tripcraft_trip_items") {
        setItems(loadTripItems());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    saveTripItems(items);
  }, [items]);

  const hasKey = useCallback((key: string) => items.some((i) => i.key === key), [items]);

  const has = useCallback(
    (category: TripItem["category"], name: string) => hasKey(tripItemKey(category, name)),
    [hasKey]
  );

  const add = useCallback(
    (input: TripItemInput) => {
      const item = createTripItem(input);
      // Refuse up front when the board is full, then re-check inside the
      // updater so a concurrent change can't push past the cap.
      if (items.length >= TRIP_MAX_ITEMS) return "";
      if (items.some((i) => i.key === item.key)) return "";
      setItems((prev) => {
        if (prev.length >= TRIP_MAX_ITEMS) return prev;
        if (prev.some((i) => i.key === item.key)) return prev;
        return [item, ...prev];
      });
      return item.key;
    },
    [items]
  );

  const remove = useCallback((key: string) => {
    setItems((prev) => prev.filter((i) => i.key !== key));
  }, []);

  const move = useCallback((key: string, dir: -1 | 1) => {
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.key === key);
      if (idx < 0) return prev;
      const next = idx + dir;
      if (next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      const [moved] = copy.splice(idx, 1);
      copy.splice(next, 0, moved);
      return copy;
    });
  }, []);

  const reorder = useCallback((from: number, to: number) => {
    setItems((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) {
        return prev;
      }
      const copy = [...prev];
      const [moved] = copy.splice(from, 1);
      copy.splice(to, 0, moved);
      return copy;
    });
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const value = useMemo<TripItemsValue>(
    () => ({
      items,
      count: items.length,
      full: items.length >= TRIP_MAX_ITEMS,
      has,
      hasKey,
      add,
      remove,
      move,
      reorder,
      clear,
    }),
    [items, has, hasKey, add, remove, move, reorder, clear]
  );

  return <TripItemsContext.Provider value={value}>{children}</TripItemsContext.Provider>;
}

export function useTripItems(): TripItemsValue {
  const ctx = useContext(TripItemsContext);
  if (!ctx) throw new Error("useTripItems must be used within <TripItemsProvider>");
  return ctx;
}
