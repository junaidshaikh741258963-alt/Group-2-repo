/**
 * Raw-output probe: what does the model ACTUALLY emit for a turn?
 *
 *   node scripts/chat.probe.mts "Show me hotels in Tokyo"
 *
 * Reproduces the route's prompt (system + trip context + turn context + the
 * trailing USER_MESSAGE), streams the completion, and reports the raw text,
 * the zod verdict and the card count. Use it when the chat shows no cards to
 * find out whether the failure is in generation or in validation.
 */

import fs from "node:fs";
import https from "node:https";
import { SYSTEM_PROMPT, buildTripContext, buildTurnContext } from "../src/lib/aiPrompt.ts";
import { classifyIntent } from "../src/lib/aiIntent.ts";
import { parseAiReply } from "../src/lib/aiSchema.ts";

/** Inline EMPTY_PROFILE — avoids pulling the whole recommendations graph in. */
const EMPTY_PROFILE = {
  destination: null,
  dates: null,
  people: null,
  budget: null,
  interests: null,
  duration: null,
  accommodation: null,
  hotel: null,
  restaurants: null,
  attractions: null,
  itinerary: null,
};

const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const key = env.match(/^\s*GROQ_API_KEY\s*=\s*(.+)\s*$/m)?.[1]?.trim();
const model = env.match(/^\s*GROQ_MODEL\s*=\s*(.+)\s*$/m)?.[1]?.trim() || "openai/gpt-oss-120b";
if (!key) {
  console.error("no GROQ_API_KEY in .env.local");
  process.exit(1);
}

const question =
  process.argv.slice(2).filter((a) => !a.startsWith("--"))[0] ?? "Show me hotels in Tokyo";

const intent = classifyIntent({
  question,
  stagePending: false,
  itineraryRequested: false,
  hasPlan: false,
  planHasItinerary: false,
});

const system = [
  SYSTEM_PROMPT,
  buildTripContext(EMPTY_PROFILE, ""),
  buildTurnContext(intent, question, []),
].join("\n\n");

const body = JSON.stringify({
  model,
  messages: [
    { role: "system", content: system },
    { role: "user", content: question },
    { role: "user", content: "Respond now with the JSON object only." },
  ],
  max_tokens: intent.maxTokens,
  temperature: intent.temperature,
  stream: true,
});

const raw = await new Promise<string>((resolve) => {
  const req = https.request(
    {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 60_000,
    },
    (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`);
        let acc = "";
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") break;
          try {
            const j = JSON.parse(payload);
            acc += j.choices?.[0]?.delta?.content ?? "";
          } catch {
            /* ignore partial */
          }
        }
        resolve(acc);
      });
    }
  );
  req.on("timeout", () => {
    req.destroy();
    resolve("TIMEOUT");
  });
  req.on("error", (e) => resolve(`ERROR ${e.message}`));
  req.write(body);
  req.end();
});

console.log("=== intent ===");
console.log(JSON.stringify(intent));
console.log("=== raw (first 400) ===");
console.log(raw.slice(0, 400));
console.log("=== raw (last 200) ===");
console.log(raw.slice(-200));
console.log("=== parse ===");
const parsed = parseAiReply(raw);
if (parsed.ok) {
  console.log("ok — places:", parsed.reply.places.length, "days:", parsed.reply.itinerary.length);
  console.log(
    "cards:",
    parsed.reply.places.map((p) => `${p.name} [${p.category}] src=${p.source || "-"}`).join(" | ")
  );
} else {
  console.log("FAILED:", parsed.errors.slice(0, 6).join(" | "));
}
