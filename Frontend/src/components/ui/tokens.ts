/**
 * Shared maps for the layout primitives.
 *
 * Spacing ONLY from the 4·8·12·16·24·32·48·64 scale — the keys below are the
 * whole vocabulary. Primitive class names must stay literal strings so the
 * Tailwind scanner can see them.
 */

export const SPACE = {
  0: "gap-0",
  1: "gap-1",
  2: "gap-2",
  3: "gap-3",
  4: "gap-4",
  6: "gap-6",
  8: "gap-8",
  12: "gap-12",
  16: "gap-16",
} as const;

export type SpaceKey = keyof typeof SPACE;

export const PAD = {
  0: "p-0",
  1: "p-1",
  2: "p-2",
  3: "p-3",
  4: "p-4",
  6: "p-6",
  8: "p-8",
  12: "p-12",
} as const;

export const COLS = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  6: "grid-cols-6",
  12: "grid-cols-12",
} as const;

export const MD_COLS = {
  1: "md:grid-cols-1",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
  6: "md:grid-cols-6",
  12: "md:grid-cols-12",
} as const;
