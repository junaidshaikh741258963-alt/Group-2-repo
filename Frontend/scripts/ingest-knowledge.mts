/**
 * Knowledge ingestion — Wikivoyage → section-chunked corpus.
 *
 *   node scripts/ingest-knowledge.mts                  # all cities (full refresh)
 *   node scripts/ingest-knowledge.mts --only "Paris,Tokyo"   # refresh a subset
 *
 * For every city: fetch the plain-text article extract, split it on headings,
 * keep the travel-relevant sections, chunk them (~300 words with overlap) and
 * write `.data/rag-corpus.json`:
 *
 *   { generatedAt, docs: [{ id, title, category, text, tags,
 *                           city, url, fetchedAt, source: "wikivoyage" }] }
 *
 * The runtime store (src/lib/rag/knowledge/store.ts) loads this file next to
 * the curated corpus — zero network calls at chat time. Re-run any time to
 * refresh; the file is the versioned snapshot.
 *
 * Wikivoyage content is CC BY-SA 4.0 — attribution lives in the source chips.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CITIES = [
  "Paris",
  "Tokyo",
  "Rome",
  "Barcelona",
  "London",
  "New York City",
  "Bangkok",
  "Bali",
  "Istanbul",
  "Lisbon",
  "Amsterdam",
  "Prague",
  "Vienna",
  "Berlin",
  "Madrid",
  "Athens",
  "Dubai",
  "Singapore",
  "Seoul",
  "Hong Kong",
  "Mexico City",
  "Buenos Aires",
  "Marrakech",
  "Cairo",
  "Cape Town",
  "Sydney",
  "Reykjavík",
  "Santorini",
  "Kyoto",
  "Osaka",
];

/** Sections kept (lowercased match on the level-2 heading text). */
const KEEP_SECTIONS = new Set([
  "understand",
  "orientation",
  "districts",
  "climate",
  "talk",
  "get in",
  "get around",
  "see",
  "do",
  "activities",
  "eat",
  "drink",
  "buy",
  "money",
  "sleep",
  "stay safe",
  "stay healthy",
  "respect",
  "connect",
  "cope",
  "go next",
]);

const WORDS_PER_CHUNK = 300;
const OVERLAP_WORDS = 40;
const MIN_CHUNK_WORDS = 40;
const OUT = join(process.cwd(), ".data", "rag-corpus.json");

interface Doc {
  id: string;
  title: string;
  category: string;
  text: string;
  tags: string;
  city: string;
  url: string;
  fetchedAt: string;
  source: "wikivoyage";
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Split a Wikivoyage extract into level-2 sections (`== Heading ==`).
 * Level-3+ headings (`=== Roman Forum ===`) stay INSIDE their parent section —
 * they are inlined as text so their tokens ("Roman Forum") remain searchable
 * instead of being dropped as unrecognised sub-sections.
 */
function sections(extract: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  let name = "intro";
  let buf: string[] = [];
  for (const line of extract.split("\n")) {
    const m = /^==\s*([^=].*?)\s*==$/.exec(line.trim());
    if (m) {
      out.push({ name, body: buf.join("\n").trim() });
      name = m[1].toLowerCase();
      buf = [];
    } else {
      // Inline deeper headings as sentences: "=== By plane ===" → "By plane."
      buf.push(line.replace(/^={3,6}\s*(.+?)\s*={3,6}$/, "$1."));
    }
  }
  out.push({ name, body: buf.join("\n").trim() });
  return out;
}

/** Word-window chunking with overlap; never splits mid-word. */
function chunk(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_CHUNK - OVERLAP_WORDS) {
    chunks.push(words.slice(i, i + WORDS_PER_CHUNK).join(" "));
    if (i + WORDS_PER_CHUNK >= words.length) break;
  }
  return chunks.filter((c) => c.split(" ").length >= MIN_CHUNK_WORDS);
}

async function fetchExtract(city: string): Promise<string> {
  const url =
    "https://en.wikivoyage.org/w/api.php?" +
    new URLSearchParams({
      action: "query",
      prop: "extracts",
      explaintext: "1",
      redirects: "1",
      format: "json",
      titles: city,
    });
  // Wikimedia throttles bursts with 429 — back off and retry.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": "TripCraftAI/1.0 (personal project; low-volume ingestion)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 4_000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      query?: { pages?: Record<string, { extract?: string; missing?: unknown; title?: string }> };
    };
    const pages = data.query?.pages ?? {};
    for (const page of Object.values(pages)) {
      if (page.missing) throw new Error("page not found on Wikivoyage");
      if (page.extract) return page.extract;
    }
    throw new Error("empty extract");
  }
}

function docsForCity(city: string, extract: string, fetchedAt: string): Doc[] {
  const url = `https://en.wikivoyage.org/wiki/${encodeURIComponent(city.replace(/ /g, "_"))}`;
  const docs: Doc[] = [];
  for (const { name, body } of sections(extract)) {
    if (!KEEP_SECTIONS.has(name)) continue;
    const clean = body.replace(/\n{2,}/g, "\n").replace(/ {2,}/g, " ").trim();
    if (!clean) continue;
    chunk(clean).forEach((text, i) => {
      const part = i > 0 ? ` (part ${i + 1})` : "";
      docs.push({
        id: `wv-${slug(city)}-${slug(name)}-${i}`,
        title: `${city} — ${name.replace(/\b\w/g, (c) => c.toUpperCase())}${part}`,
        category: "city-guide",
        text,
        tags: `${name} travel guide`,
        city,
        url,
        fetchedAt,
        source: "wikivoyage",
      });
    });
  }
  return docs;
}

async function main() {
  const onlyArg = process.argv.indexOf("--only");
  const only = onlyArg !== -1 ? (process.argv[onlyArg + 1] ?? "").split(",").map((s) => s.trim()) : null;
  const target = only && only.length > 0 ? CITIES.filter((c) => only.includes(c)) : CITIES;

  // Merge mode: keep other cities' existing docs, replace the target set.
  let previous: Doc[] = [];
  if (existsSync(OUT)) {
    try {
      const parsed = JSON.parse(readFileSync(OUT, "utf8")) as { docs?: Doc[] };
      previous = Array.isArray(parsed.docs) ? parsed.docs : [];
    } catch {
      previous = [];
    }
  }
  const keep = previous.filter((d) => !target.includes(d.city));

  const fetchedAt = new Date().toISOString().slice(0, 10);
  const fresh: Doc[] = [];
  const failed: string[] = [];

  for (const city of target) {
    try {
      const extract = await fetchExtract(city);
      const docs = docsForCity(city, extract, fetchedAt);
      fresh.push(...docs);
      console.log(`  ok   ${city.padEnd(16)} ${docs.length} chunks`);
    } catch (err) {
      failed.push(city);
      console.log(`  FAIL ${city.padEnd(16)} ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 1_100));
  }

  const docs = [...keep, ...fresh];
  mkdirSync(join(process.cwd(), ".data"), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), docs }, null, 0) + "\n");

  console.log(
    `\n${docs.length} docs total (${fresh.length} fresh, ${keep.length} kept) · ${failed.length} failed` +
      `${failed.length ? ` (${failed.join(", ")})` : ""} · wrote ${OUT}`
  );
}

main().catch((err) => {
  console.error("ingest failed:", err);
  process.exit(1);
});
