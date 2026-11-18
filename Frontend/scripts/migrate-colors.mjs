/**
 * Phase 2c — colour utility → design-token codemod.
 *
 *   node scripts/migrate-colors.mjs --apply
 *
 * Exact-match only (same computed colour, or the deliberate AA bump for
 * zinc-500 → ink-faint). Variant prefixes (hover:, md:, group-hover:…) are
 * preserved automatically because only the utility token is swapped.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const APPLY = process.argv.includes("--apply");

/** [from, to] — exact computed colour unless noted. */
const PAIRS = [
  // Ink ladder (500 first: "text-zinc-50" is a prefix of "text-zinc-500")
  ["text-zinc-500", "text-ink-faint"], // #71717a → #8b8b94 (AA bump)
  ["text-zinc-50", "text-ink"],
  ["text-zinc-100", "text-ink"],
  ["text-zinc-400", "text-ink-muted"], // #a1a1aa exact
  // Surfaces (white alpha ladder)
  ["bg-white/[0.03]", "bg-surface-1"],
  ["bg-white/[0.035]", "bg-surface-1"],
  ["bg-white/[0.04]", "bg-surface-1"],
  ["bg-white/[0.05]", "bg-surface-2"],
  ["bg-white/[0.06]", "bg-surface-2"],
  ["bg-white/[0.07]", "bg-surface-3"],
  ["bg-white/[0.08]", "bg-surface-3"],
  ["bg-white/[0.1]", "bg-surface-3"],
  // Hairlines
  ["border-white/[0.07]", "border-hairline"],
  ["border-white/[0.08]", "border-hairline"],
  ["border-white/[0.15]", "border-hairline-strong"],
  ["border-white/[0.16]", "border-hairline-strong"],
  // Accent (exact: blue-500 #3b82f6, blue-600 #2563eb)
  ["text-blue-500", "text-accent"],
  ["text-blue-600", "text-accent-strong"],
  ["bg-blue-500", "bg-accent"],
  ["bg-blue-600", "bg-accent-strong"],
  ["border-blue-500", "border-accent"],
  ["border-blue-600", "border-accent-strong"],
  // Status (exact 400s)
  ["text-emerald-400", "text-ok"],
  ["bg-emerald-400", "bg-ok"],
  ["text-red-400", "text-danger"],
  ["bg-red-400", "bg-danger"],
  ["text-amber-400", "text-warn"],
  ["bg-amber-400", "bg-warn"],
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const counts = new Map(PAIRS.map(([f]) => [f, 0]));
let changed = 0;

/** Word-boundary safe: "text-zinc-50" must never eat "text-zinc-500". */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const file of walk("src")) {
  let text = readFileSync(file, "utf8");
  const before = text;
  for (const [from, to] of PAIRS) {
    const re = new RegExp(`(?<![\\w-])${escapeRe(from)}(?![\\w-])`, "g");
    const hits = text.match(re);
    if (hits && hits.length > 0) {
      text = text.replace(re, to);
      counts.set(from, counts.get(from) + hits.length);
    }
  }
  if (text !== before) {
    changed++;
    if (APPLY) writeFileSync(file, text, "utf8");
    else console.log(`~ ${relative(process.cwd(), file)}`);
  }
}

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"} — ${changed} file(s)`);
for (const [from, n] of counts) if (n > 0) console.log(`  ${String(n).padStart(4)}  ${from}`);
