/**
 * Design-system linter — keeps the token debt visible and prevents regressions.
 *
 *   node scripts/design-lint.mjs            check against .design-budget.json
 *   node scripts/design-lint.mjs --update   set the budget to today's counts
 *
 * Categories:
 *   arbitrary_text       text-[…] or leading-[…]            → use the type scale
 *   arbitrary_spacing    p/m/gap-[…]                        → use 4·8·12·16·24·32·48·64
 *   off_scale_spacing    p-5, gap-7, mt-2.5 …               → scale steps only
 *   space_xy             space-x/y-*                        → prefer gap on flex/grid
 *   arbitrary_dim        w/h/min/max/size/basis-[…px]       → 4px multiples, budgeted
 *   legacy_breakpoint    2xl: 3xl: …                        → only sm/md/lg/xl
 *   oversized_files      .ts/.tsx/.css > 300 lines          → split when touched
 *
 * Exits non-zero when any count exceeds the recorded budget, so debt can only
 * shrink. Budgets live in .design-budget.json (updated deliberately).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUDGET_FILE = ".design-budget.json";
const UPDATE = process.argv.includes("--update");
const MAX_LINES = 300;

const PATTERNS = {
  arbitrary_text: /(?:text|leading)-\[[^\]]+\]/g,
  arbitrary_spacing:
    /(?<![\w-])-?(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y)-\[[^\]]+\]/g,
  space_xy: /(?<![\w-])space-[xy]-/g,
  arbitrary_dim:
    /(?<![\w-])(?:w|h|min-w|min-h|max-w|max-h|size|basis|top|left|right|bottom|inset)-\[[^\]]+\]/g,
  legacy_breakpoint: /(?<![\w-])(?:2xl|3xl|4xl|5xl):/g,
};

const OFF_SCALE = /(?<![\w-])-?(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y)-(\d+(?:\.\d+)?)(?![\w.%/\-])/g;
const ALLOWED_PX = new Set([0, 4, 8, 12, 16, 24, 32, 48, 64]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const counts = { ...Object.fromEntries(Object.keys(PATTERNS).map((k) => [k, 0])), off_scale_spacing: 0, oversized_files: 0 };
const offenders = { off_scale_spacing: [], oversized_files: [] };

for (const file of walk("src")) {
  const text = readFileSync(file, "utf8");

  for (const [name, re] of Object.entries(PATTERNS)) {
    counts[name] += (text.match(re) ?? []).length;
  }

  for (const m of text.matchAll(OFF_SCALE)) {
    if (!ALLOWED_PX.has(parseFloat(m[1]) * 4)) {
      counts.off_scale_spacing++;
      if (offenders.off_scale_spacing.length < 12) offenders.off_scale_spacing.push(`${file}: ${m[0]}`);
    }
  }

  if (/\.(ts|tsx|css)$/.test(file) && text.split("\n").length > MAX_LINES) {
    counts.oversized_files++;
    offenders.oversized_files.push(`${file} (${text.split("\n").length})`);
  }
}

const budget = existsSync(BUDGET_FILE) ? JSON.parse(readFileSync(BUDGET_FILE, "utf8")) : null;

let failed = false;
console.log("design-lint — token debt vs budget\n");
for (const [name, n] of Object.entries(counts)) {
  const cap = budget ? (budget[name] ?? Infinity) : Infinity;
  const ok = n <= cap;
  if (!ok) failed = true;
  console.log(`  ${ok ? "ok " : "FAIL"}  ${name.padEnd(18)} ${String(n).padStart(4)}${budget ? ` / ${cap}` : ""}`);
}

if (failed) {
  console.log("\nOffenders (first few):");
  for (const list of Object.values(offenders)) for (const o of list) console.log(`  · ${o}`);
  console.log("\nFix or (deliberately) raise the budget with --update.");
}

if (!budget || UPDATE) {
  writeFileSync(BUDGET_FILE, JSON.stringify(counts, null, 2) + "\n");
  console.log(`\nbudget written to ${BUDGET_FILE}`);
}

process.exit(failed ? 1 : 0);
