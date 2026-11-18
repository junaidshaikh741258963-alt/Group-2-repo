/**
 * Turn-intent + reply-policy checks. Run with:
 *   node scripts/intent.test.mts
 * (Node's built-in type stripping — no bundler, no aliases.)
 */

import { classifyIntent, applyTurnIntent, normalizePlaceKey } from "../src/lib/aiIntent.ts";
import type { TurnIntent } from "../src/lib/aiIntent.ts";
import type { AiReply } from "../src/lib/aiSchema.ts";

let failures = 0;
let checks = 0;

function check(label: string, cond: boolean, detail = "") {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function classify(
  question: string,
  opts: Partial<Parameters<typeof classifyIntent>[0]> = {}
): TurnIntent {
  return classifyIntent({
    question,
    stagePending: false,
    itineraryRequested: false,
    hasPlan: false,
    planHasItinerary: false,
    ...opts,
  });
}

function reply(over: Partial<AiReply> = {}): AiReply {
  return {
    intro: "",
    places: [],
    itinerary: [],
    followUpQuestion: "",
    suggestions: [],
    ...over,
  };
}

const place = (name: string) => ({
  name,
  category: "attraction",
  city: "Tokyo",
  lat: 35,
  lng: 139,
  description: "",
  priceLevel: "",
});

console.log("\nintent classification (user's examples)");
{
  const a = classify("I want to visit Tokyo.");
  check("trip opener → recommendation cards", a.kind === "recommendation", a.kind);
  check("trip opener allows cards", a.maxPlaces >= 4, String(a.maxPlaces));
  check("trip opener forbids itinerary", !a.allowItinerary);

  const b = classify("What about the budget?", { hasPlan: true, stagePending: true });
  check("budget follow-up → followup", b.kind === "followup" || b.kind === "factual", b.kind);
  check("budget follow-up stays short", b.maxIntro <= 340, String(b.maxIntro));
  check("budget follow-up ships no itinerary", !b.allowItinerary);
  check("budget follow-up is text-first", b.maxPlaces <= 3, String(b.maxPlaces));

  const c = classify("Show me hotels.", { stagePending: true });
  check("'show me hotels' → recommendation", c.kind === "recommendation", c.kind);
  check("'show me hotels' allows cards", c.maxPlaces >= 4, String(c.maxPlaces));
  check("'show me hotels' ships no itinerary", !c.allowItinerary);

  const d = classify("What did you recommend earlier?", { hasPlan: true });
  check("recall question → recall", d.kind === "recall", d.kind);
  check("recall ships no new cards", d.maxPlaces === 0, String(d.maxPlaces));
  check("recall ships no itinerary", !d.allowItinerary);

  const e = classify("Tell me about Senso-ji.", { stagePending: true });
  check("place explainer → factual", e.kind === "factual", e.kind);
  check("place explainer stays short", e.maxIntro <= 340, String(e.maxIntro));
  check("place explainer ships no itinerary", !e.allowItinerary);
}

console.log("\nintent classification (other shapes)");
{
  const plan = classify("Plan a 3-day trip to Tokyo");
  check("plan request → plan", plan.kind === "plan", plan.kind);
  check("plan allows itinerary", plan.allowItinerary);

  const edit = classify("make it cheaper", { hasPlan: true, planHasItinerary: true });
  check("plan edit → edit", edit.kind === "edit", edit.kind);
  check("plan edit keeps its itinerary", edit.allowItinerary);
  check("plan edit may re-issue its cards", !edit.dedupe);

  const stage = classify("2 adults", { stagePending: true });
  check("stage answer → stage", stage.kind === "stage", stage.kind);
  check("stage answer allows cards", stage.maxPlaces >= 4, String(stage.maxPlaces));

  const hotelName = classify("Hotel Gracery Shinjuku", { stagePending: true, hasPlan: true });
  check("bare hotel name stays a stage answer", hotelName.kind === "stage", hotelName.kind);

  const yes = classify("yes please", { itineraryRequested: true });
  check("affirming a pending itinerary → plan", yes.kind === "plan", yes.kind);

  const factual = classify("Is the metro safe to take at night in Tokyo?");
  check("safety question → factual", factual.kind === "factual", factual.kind);
  check("safety question ships no itinerary", !factual.allowItinerary);
  check("safety question caps cards", factual.maxPlaces <= 3, String(factual.maxPlaces));
}

console.log("\nreply policy (dedupe / caps / itinerary)");
{
  const shown = new Set(["eiffel tower", "louvre museum"]);
  const turn = classify("Show me restaurants.", { hasPlan: true });

  const mixed = applyTurnIntent(
    reply({ places: [place("Eiffel Tower"), place("Le Petit Cler"), place("Louvre Museum")] as never }),
    turn,
    shown
  );
  check(
    "already-shown cards are dropped",
    mixed.places.length === 1 && mixed.places[0].name === "Le Petit Cler",
    JSON.stringify(mixed.places.map((p) => p.name))
  );

  const factualTurn = classify("what was that restaurant called?", { hasPlan: true });
  const repeat = applyTurnIntent(
    reply({ places: [place("Eiffel Tower"), place("Louvre Museum")] as never }),
    factualTurn,
    shown
  );
  check("non-card turns drop repeats entirely", repeat.places.length === 0, String(repeat.places.length));

  const cardTurn = classify("Show me hotels.");
  const allDup = applyTurnIntent(
    reply({ places: [place("Eiffel Tower"), place("Louvre Museum")] as never }),
    cardTurn,
    shown
  );
  check(
    "card turn is never emptied by dedupe",
    allDup.places.length === 2,
    String(allDup.places.length)
  );

  const many = applyTurnIntent(
    reply({
      places: [place("A"), place("B"), place("C"), place("D"), place("E"), place("F")] as never,
      itinerary: [{ day: 1, title: "x", items: [] }],
    }),
    classify("Tell me about Tokyo Station.", { hasPlan: false }),
    new Set()
  );
  check("factual turn caps cards to 3", many.places.length === 3, String(many.places.length));
  check("factual turn strips an itinerary", many.itinerary.length === 0);

  const recall = applyTurnIntent(
    reply({
      places: [place("A"), place("B")] as never,
      itinerary: [{ day: 1, title: "x", items: [] }],
    }),
    classify("What did you recommend earlier?"),
    new Set()
  );
  check("recall ships zero cards", recall.places.length === 0, String(recall.places.length));
  check("recall ships no itinerary", recall.itinerary.length === 0);

  const editReply = applyTurnIntent(
    reply({
      places: [place("Eiffel Tower"), place("Arc de Triomphe")] as never,
      itinerary: [{ day: 1, title: "Day 1", items: [] }],
    }),
    classify("make it cheaper", { hasPlan: true, planHasItinerary: true }),
    shown
  );
  check("edit keeps the plan's cards", editReply.places.length === 2, String(editReply.places.length));
  check("edit keeps the plan's itinerary", editReply.itinerary.length === 1);

  check("place key normalises", normalizePlaceKey("  Le-Petit, Cler ") === "le petit cler");
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
