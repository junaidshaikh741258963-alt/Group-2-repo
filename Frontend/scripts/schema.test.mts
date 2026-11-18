/**
 * Schema resilience checks — the "why did my cards not show up?" guard.
 *
 *   node scripts/schema.test.mts
 *
 * A reply should only be REJECTED when the contract is genuinely broken.
 * Type drift (numbers as strings, an object where a string belongs), an
 * over-long description or one malformed card must not invalidate the reply —
 * that is what used to make the intro stream and then lose every card.
 */

import { parseAiReply } from "../src/lib/aiSchema.ts";

interface Case {
  name: string;
  input: unknown;
  expectOk: boolean;
  /** When expectOk: how many cards should survive. */
  cards?: number;
}

const CASES: Case[] = [
  {
    name: "minimal reply, no cards",
    input: {
      intro: "Tell me your dates and I'll plan Tokyo.",
      places: [],
      itinerary: [],
      followUpQuestion: "When are you going?",
      suggestions: ["Next month", "This weekend", "June"],
    },
    expectOk: true,
    cards: 0,
  },
  {
    name: "numbers quoted as strings",
    input: {
      intro: "Here are three hotels.",
      destination: "Tokyo",
      dates: "12-18 Oct 2026",
      places: [
        { name: "Hotel A", category: "hotel", lat: "35.68", lng: "139.77", rating: "4.6", cost: 180, duration: 2 },
        { name: "Hotel B", category: "hotel", lat: "35.67", lng: "139.76", rating: 4.2 },
      ],
      itinerary: [{ day: "2", title: "Day two", items: [{ time: "09:00", title: "Market", duration: "1h", cost: 5 }] }],
      followUpQuestion: "",
      suggestions: [],
    },
    expectOk: true,
    cards: 2,
  },
  {
    name: "dates as an object",
    input: {
      intro: "Got it.",
      destination: { city: "Kyoto", country: "Japan" },
      dates: { from: "2026-11-02", to: "2026-11-09" },
      places: [],
      itinerary: [],
      followUpQuestion: "",
      suggestions: [],
    },
    expectOk: true,
    cards: 0,
  },
  {
    name: "over-long description is clipped, not rejected",
    input: {
      intro: "Nice pick.",
      places: [
        {
          name: "Very Long Named Place",
          category: "attraction",
          lat: 0,
          lng: 0,
          description: "x".repeat(500),
        },
      ],
      itinerary: [],
      followUpQuestion: "",
      suggestions: [],
    },
    expectOk: true,
    cards: 1,
  },
  {
    name: "one malformed card, two good ones",
    input: {
      intro: "Three picks.",
      places: [
        { name: "Good One", category: "restaurant", lat: 1, lng: 1 },
        { category: "restaurant", lat: 1, lng: 1 }, // no name
        { name: "Good Two", category: "restaurant", lat: 1, lng: 1 },
      ],
      itinerary: [],
      followUpQuestion: "",
      suggestions: [],
    },
    expectOk: true,
    cards: 2,
  },
  {
    // Regression guard: models often know a place but not its coordinates.
    // Requiring lat/lng made EVERY card fail, which rejected the whole reply,
    // burned a correction retry (and then the daily quota) — the cards never
    // reached the UI at all.
    name: "cards with missing or null coordinates still show",
    input: {
      intro: "Five hotels to consider.",
      destination: "Tokyo",
      places: [
        { name: "Hotel A", category: "hotel" },
        { name: "Hotel B", category: "hotel", lat: null, lng: null },
        { name: "Hotel C", category: "hotel", lat: "35.68", lng: 139.77 },
      ],
      itinerary: [],
      followUpQuestion: "",
      suggestions: [],
    },
    expectOk: true,
    cards: 3,
  },
  {
    name: "every card malformed → reject (retry fires)",
    input: {
      intro: "Three picks.",
      places: [{ category: "x" }, { nope: true }],
      itinerary: [],
      followUpQuestion: "",
      suggestions: [],
    },
    expectOk: false,
  },
  {
    name: "missing intro → reject (retry fires)",
    input: { places: [], itinerary: [], followUpQuestion: "", suggestions: [] },
    expectOk: false,
  },
  {
    name: "not JSON at all → reject",
    input: "Sorry, I cannot help with that.",
    expectOk: false,
  },
];

let failed = 0;
for (const c of CASES) {
  const parsed = parseAiReply(JSON.stringify(c.input));
  const ok = parsed.ok === c.expectOk;
  const cardsOk = !c.expectOk || !parsed.ok || (c.cards ?? -1) === parsed.reply.places.length;
  if (ok && cardsOk) {
    const extra = parsed.ok ? ` → ${parsed.reply.places.length} card(s)` : "";
    console.log(`  ok   ${c.name}${extra}`);
  } else {
    failed++;
    const detail = parsed.ok
      ? `ok, ${parsed.reply.places.length} card(s) (wanted ${c.cards})`
      : `rejected: ${parsed.errors.slice(0, 3).join(" | ")}`;
    console.log(`  FAIL ${c.name} → ${detail}`);
  }
}

console.log(failed === 0 ? `\n${CASES.length} checks passed` : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
