/**
 * Prompt ablation: which section makes the model refuse a travel question?
 *
 *   node scripts/prompt.ablate.mts "Show me hotels in Tokyo"
 *
 * Runs the same question against several system-prompt variants and prints the
 * intro, so the offending instruction can be deleted instead of guessed at.
 */

import fs from "node:fs";
import https from "node:https";
import { SYSTEM_PROMPT } from "../src/lib/aiPrompt.ts";

const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const key = env.match(/^\s*GROQ_API_KEY\s*=\s*(.+)\s*$/m)?.[1]?.trim();
const model = env.match(/^\s*GROQ_MODEL\s*=\s*(.+)\s*$/m)?.[1]?.trim() || "openai/gpt-oss-120b";
if (!key) {
  console.error("no GROQ_API_KEY");
  process.exit(1);
}

const question =
  process.argv.slice(2).filter((a) => !a.startsWith("--"))[0] ?? "Show me hotels in Tokyo";

const between = (text: string, start: string, end: string) => {
  const i = text.indexOf(start);
  const j = text.indexOf(end, i + start.length);
  return i === -1 || j === -1 ? null : text.slice(i, j + end.length);
};

const VARIANTS: Array<{ name: string; system: string }> = [
  { name: "control (full prompt)", system: SYSTEM_PROMPT },
  {
    name: "minus the off-topic redirect bullet",
    system: SYSTEM_PROMPT.replace(/- Off-topic means only things[\s\S]*?trip or a date\.\n/, ""),
  },
  {
    name: "minus the whole Untrusted input section",
    system: SYSTEM_PROMPT.replace(/## Untrusted input[\s\S]*?(?=## The app)/, ""),
  },
  {
    name: "minus redirect + Untrusted input",
    system: SYSTEM_PROMPT.replace(/- Off-topic means only things[\s\S]*?trip or a date\.\n/, "").replace(
      /## Untrusted input[\s\S]*?(?=## The app)/,
      ""
    ),
  },
  {
    name: "role + output format only",
    system: between(SYSTEM_PROMPT, "You are TripCraft", "## intro") ?? SYSTEM_PROMPT,
  },
];

async function ask(system: string): Promise<string> {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: question },
      { role: "user", content: "Respond now with the JSON object only." },
    ],
    max_tokens: 4096,
    temperature: 0.3,
    stream: false,
  });
  return new Promise<string>((resolve) => {
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
          if (res.statusCode !== 200) return resolve(`HTTP ${res.statusCode} ${text.slice(0, 200)}`);
          try {
            const j = JSON.parse(text);
            const c = j.choices?.[0];
            return resolve(
              `content=${JSON.stringify(c?.message?.content ?? "").slice(0, 240)} | finish=${
                c?.finish_reason
              } | usage=${j.usage?.completion_tokens}`
            );
          } catch {
            return resolve(`unparsable: ${text.slice(0, 200)}`);
          }
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
}

console.log(`question: ${question}\n`);
for (const v of VARIANTS) {
  const t0 = Date.now();
  const out = await ask(v.system);
  console.log(`— ${v.name} (${Date.now() - t0}ms, prompt ${v.system.length}c)`);
  console.log(`  ${out}\n`);
}
