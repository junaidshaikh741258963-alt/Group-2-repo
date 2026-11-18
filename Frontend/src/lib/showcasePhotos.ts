import bali from "../../images/bali.jpg";
import maldives from "../../images/maldives.jpg";
import newYork from "../../images/newyork.jpg";
import paris from "../../images/paris.jpg";
import santorini from "../../images/santorini.jpg";
import tokyo from "../../images/tokyo.jpg";

/**
 * Showcase photos shipped with the repo (`/images`). They stand in for the
 * remote stock URLs wherever we need a guaranteed-good destination picture:
 * the home grid, the chat hero cards and `recImage()`'s city fallbacks.
 *
 * Bundled via static imports, so each file ships as a hashed asset and a
 * missing photo fails the build instead of rendering a broken card.
 */
export const SHOWCASE_PHOTOS: Record<
  "bali" | "maldives" | "newYork" | "paris" | "santorini" | "tokyo",
  string
> = {
  bali: bali.src,
  maldives: maldives.src,
  newYork: newYork.src,
  paris: paris.src,
  santorini: santorini.src,
  tokyo: tokyo.src,
};
