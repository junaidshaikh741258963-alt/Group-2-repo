/**
 * Phase 2b — line-height outliers + `space-x/y` → `gap` compaction.
 *
 *   node scripts/migrate-spacing2.mjs --apply
 *
 * Rule A: remaining arbitrary leading values map to semantic tokens.
 * Rule B: `space-x-N` / `space-y-N` inside a string that also carries
 *         `flex`/`grid` is exactly equivalent to `gap-x-N` / `gap-y-N`
 *         (gap is the primitive-friendly form). Strings without flex/grid
 *         are left untouched — margins there are load-bearing.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const APPLY = process.argv.includes("--apply");

const LEADING = [
  ["leading-[18px]", "leading-ui"],
  ["leading-[15px]", "leading-tight"],
  ["leading-[1.1]", "leading-display"],
  ["leading-[1.55]", "leading-body"],
  ["leading-[1.6]", "leading-body"],
  ["leading-[1.65]", "leading-body"],
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

let leadingFixes = 0;
let spaceFixes = 0;
const skipped = [];
let changed = 0;

for (const file of walk("src")) {
  let text = readFileSync(file, "utf8");
  const before = text;

  for (const [from, to] of LEADING) {
    const n = text.split(from).length - 1;
    if (n > 0) {
      text = text.split(from).join(to);
      leadingFixes += n;
    }
  }

  // Rule B — only inside quoted string literals that mention flex/grid.
  text = text.replace(/(["'`])((?:[^"'`\\]|\\.)*)\1/g, (m, quote, body) => {
    if (!/space-[xy]-/.test(body)) return m;
    if (!/\b(flex|grid)\b/.test(body)) {
      skipped.push(`${file}`);
      return m;
    }
    const replaced = body
      .replace(/(?<![\w-])space-x-([a-z0-9.]+)/g, "gap-x-$1")
      .replace(/(?<![\w-])space-y-([a-z0-9.]+)/g, "gap-y-$1");
    if (replaced !== body) spaceFixes++;
    return quote + replaced + quote;
  });

  if (text !== before) {
    changed++;
    if (APPLY) writeFileSync(file, text, "utf8");
    else console.log(`~ ${relative(process.cwd(), file)}`);
  }
}

console.log(
  `${APPLY ? "APPLIED" : "DRY RUN"} — ${changed} file(s) · ${leadingFixes} leading · ${spaceFixes} space→gap`
);
if (skipped.length) {
  console.log(`left for review (no flex/grid in string): ${[...new Set(skipped)].length} file(s)`);
  for (const f of [...new Set(skipped)].slice(0, 10)) console.log(`  · ${f}`);
}
