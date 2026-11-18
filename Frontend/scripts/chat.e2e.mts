/**
 * Consecutive-questions test against a running server:
 *   npx next start -p 3100
 *   node scripts/chat.e2e.mts [baseUrl]
 *
 * Reproduces the chat client's request body (messages, profile, plan,
 * shownPlaces, tripItems) for five follow-ups in the SAME conversation and
 * checks that each answer is scoped to the latest question, does not repeat
 * cards already shown, and respects the turn's length/shape budget.
 */

/** `node scripts/chat.e2e.mts [baseUrl] [plan]` — `plan` runs only turns 6-7. */
const PLAN_ONLY = process.argv.includes("plan");
const BASE = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:3100";

interface Place {
  name: string;
  category: string;
  city?: string;
}
interface Reply {
  intro: string;
  places: Place[];
  itinerary: { day: number; title: string; items?: unknown[] }[];
  followUpQuestion: string;
  suggestions: string[];
}

type Role = "user" | "assistant";
interface Turn {
  role: Role;
  content: string;
  structured?: Reply;
}

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, detail = "") {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}
const key = (n: string) =>
  n
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const clip = (s: string, n = 260) => (s.length > n ? `${s.slice(0, n)}…` : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ask(history: Turn[], profile: Record<string, string | null>, plan: Reply | null) {
  const shownPlaces: Place[] = history.flatMap((m) =>
    (m.structured?.places ?? []).map((p) => ({ name: p.name, category: p.category, city: p.city }))
  );
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      profile,
      conversationId: "e2e-test",
      plan,
      shownPlaces,
      tripItems: [],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let reply: Reply | null = null;
  let error = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: { type: string; reply?: Reply; message?: string };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "done") reply = ev.reply ?? null;
      if (ev.type === "error") error = ev.message ?? "error";
    }
  }
  if (!reply) throw new Error(error || "no reply");
  return reply;
}

const EMPTY_PROFILE: Record<string, string | null> = {
  destination: null,
  days: null,
  startDate: null,
  budget: null,
  travelers: null,
  pace: null,
  interests: null,
  itinerary: null,
};

async function main() {
  const history: Turn[] = [];
  const profile: Record<string, string | null> = { ...EMPTY_PROFILE };
  let plan: Reply | null = null;

  const turn = async (label: string, text: string, extraWait = 0) => {
    // Pace like a real conversation — the free Groq tier is TPM-limited.
    await sleep(30_000 + extraWait);
    console.log(`\n── ${label}: "${text}"`);
    history.push({ role: "user", content: text });
    const reply = await ask(history, profile, plan);
    history.push({ role: "assistant", content: reply.intro, structured: reply });
    plan = reply;
    // Mirror the client's stage machine: the first answer fills "destination".
    if (!profile.destination && text.toLowerCase().includes("tokyo")) profile.destination = "Tokyo";
    console.log(`  intro (${reply.intro.length}c): ${clip(reply.intro, 320)}`);
    console.log(
      `  cards (${reply.places.length}): ${reply.places.map((p) => `${p.name} [${p.category}]`).join(" · ") || "—"}`
    );
    console.log(`  itinerary days: ${reply.itinerary.length}`);
    return reply;
  };

  if (!PLAN_ONLY) {
    // ── 1. trip opener → short intro + destination cards
    const t1 = await turn("T1", "I want to visit Tokyo.");
    check("T1 shows destination cards", t1.places.length > 0, String(t1.places.length));
    check("T1 ships no itinerary", t1.itinerary.length === 0);
    check("T1 intro stays short", t1.intro.length <= 500, `${t1.intro.length}c`);
    const seen = new Set(t1.places.map((p) => key(p.name)));

  // ── 2. follow-up: budget → answer the budget question, no re-dump
  const t2 = await turn("T2", "What about the budget?");
  check(
    "T2 ships at most 3 cards (text-first answer)",
    t2.places.length <= 3,
    String(t2.places.length)
  );
  check("T2 ships no itinerary", t2.itinerary.length === 0);
  check("T2 intro stays short", t2.intro.length <= 420, `${t2.intro.length}c`);
  const dupT2 = t2.places.filter((p) => seen.has(key(p.name)));
  check("T2 repeats none of T1's cards", dupT2.length === 0, dupT2.map((p) => p.name).join(", "));
  check("T2 mentions budget/price", /budget|cost|price|\$|¥|per day|per person/i.test(t2.intro));

  // ── 3. show me hotels → hotels only, no attractions re-dump
  const t3 = await turn("T3", "Show me hotels.");
  check("T3 shows cards", t3.places.length > 0, String(t3.places.length));
  check("T3 ships no itinerary", t3.itinerary.length === 0);
  const dupT3 = t3.places.filter((p) => seen.has(key(p.name)));
  check("T3 repeats none of the earlier cards", dupT3.length === 0, dupT3.map((p) => p.name).join(", "));
  check(
    "T3 answers with hotels (no attraction re-dump)",
    t3.places.every((p) => p.category === "hotel" || p.category === "destination") ||
      new Set(t3.places.map((p) => p.category)).size === 1,
    t3.places.map((p) => p.category).join(",")
  );
  t3.places.forEach((p) => seen.add(key(p.name)));

  // ── 4. recall → answer from history, no new cards
  const t4 = await turn("T4", "What did you recommend earlier?");
  check("T4 ships no new cards", t4.places.length === 0, String(t4.places.length));
  check("T4 ships no itinerary", t4.itinerary.length === 0);
  check("T4 intro stays short", t4.intro.length <= 500, `${t4.intro.length}c`);
  const earlier = [...seen].filter((k) => k.includes(" "));
  check(
    "T4 recalls something already shown",
    earlier.some((k) => t4.intro.toLowerCase().includes(k.split(" ")[0])),
    clip(t4.intro, 200)
  );

  // ── 5. place explainer → focus, no full-trip regeneration
  const t5 = await turn("T5", "Tell me about Senso-ji.");
  check("T5 stays focused (≤3 cards)", t5.places.length <= 3, String(t5.places.length));
  check("T5 ships no itinerary", t5.itinerary.length === 0);
  check("T5 intro stays short", t5.intro.length <= 420, `${t5.intro.length}c`);
  check("T5 actually answers about Senso-ji", /senso|asakusa|tokyo/i.test(t5.intro), clip(t5.intro, 200));
    const dupT5 = t5.places.filter((p) => seen.has(key(p.name)));
    check(
      "T5 repeats none of the earlier cards",
      dupT5.length === 0,
      dupT5.map((p) => p.name).join(", ")
    );
  }

  // ── 6. explicit planning request → day-by-day itinerary is allowed again
  const t6 = await turn("T6", "Plan a 3-day trip to Tokyo.", PLAN_ONLY ? 30_000 : 45_000);
  check("T6 builds a day-by-day itinerary", t6.itinerary.length >= 3, String(t6.itinerary.length));
  check("T6 ships cards for the plan", t6.places.length > 0, String(t6.places.length));

  // ── 7. edit the plan on the table → keeps its itinerary, only changes the ask
  const t7 = await turn("T7", "Make it cheaper.");
  check("T7 keeps the plan's itinerary", t7.itinerary.length === t6.itinerary.length, `${t7.itinerary.length} vs ${t6.itinerary.length}`);
  check("T7 intro stays short", t7.intro.length <= 460, `${t7.intro.length}c`);
  check("T7 answers the edit (cheaper/budget)", /cheaper|budget|cost|save|\$|free|less/i.test(t7.intro), clip(t7.intro, 200));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nE2E failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
