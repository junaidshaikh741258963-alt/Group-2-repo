// Does `reasoning_effort` help on the configured Groq model?
//   node scripts/reasoning.check.mjs
// Prints latency + token usage for each effort level so we can pick one that
// fits inside the free tier's 8,000 TPM instead of blowing the budget.
import fs from "node:fs";

const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const key = env.match(/^\s*GROQ_API_KEY\s*=\s*(.+)\s*$/m)?.[1]?.trim();
const model = env.match(/^\s*GROQ_MODEL\s*=\s*(.+)\s*$/m)?.[1]?.trim() || "openai/gpt-oss-120b";
if (!key) {
  console.error("no GROQ_API_KEY");
  process.exit(1);
}

const PROMPT =
  "You are TripCraft, an expert travel planner. Reply with exactly one JSON object: " +
  '{"intro":"...","places":[],"itinerary":[],"followUpQuestion":"...","suggestions":[]}';

async function run(label, extra) {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: "Show me hotels in Tokyo" },
    ],
    max_tokens: 2048,
    temperature: 0.3,
    ...extra,
  });
  const t = Date.now();
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
    });
    const j = await r.json();
    const ms = Date.now() - t;
    if (r.status !== 200) {
      console.log(`  ${label.padEnd(26)} HTTP ${r.status} ${String(j.error?.message).slice(0, 90)}`);
      return;
    }
    const c = j.choices?.[0];
    const u = j.usage ?? {};
    console.log(
      `  ${label.padEnd(26)} ${String(ms).padStart(5)}ms  prompt=${u.prompt_tokens} ` +
        `completion=${u.completion_tokens} finish=${c?.finish_reason} content=${
          String(c?.message?.content ?? "").length
        }c`
    );
  } catch (e) {
    console.log(`  ${label.padEnd(26)} ERROR ${e.message}`);
  }
}

console.log(`model: ${model}`);
await run("default effort", {});
for (const level of ["low", "medium", "high"]) {
  await run(`reasoning_effort: ${level}`, { reasoning_effort: level });
}
