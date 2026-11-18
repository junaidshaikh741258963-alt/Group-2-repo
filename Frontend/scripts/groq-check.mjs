// Quick probe: is the Groq API usable right now? Usage: node scripts/groq-check.mjs
import https from "node:https";
import fs from "node:fs";

const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const key = env.match(/^\s*GROQ_API_KEY\s*=\s*(.+)\s*$/m)?.[1]?.trim();
const model = env.match(/^\s*GROQ_MODEL\s*=\s*(.+)\s*$/m)?.[1]?.trim() || "openai/gpt-oss-120b";
if (!key) {
  console.log("no GROQ_API_KEY in .env.local");
  process.exit(1);
}

function post(stream) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "Say OK." }],
      max_tokens: 20,
      temperature: 0.2,
      stream,
    });
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
        timeout: 45000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text: text.slice(0, 600) }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, text: "timeout" });
    });
    req.on("error", (e) => resolve({ status: 0, text: String(e.message) }));
    req.write(body);
    req.end();
  });
}

const plain = await post(false);
console.log("[non-stream]", plain.status, plain.text);
const streamed = await post(true);
console.log("[stream]", streamed.status, streamed.text.replace(/\n/g, " | "));
