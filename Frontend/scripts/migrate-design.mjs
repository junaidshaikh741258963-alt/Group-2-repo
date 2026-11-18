/**
 * Phase 2 design codemod — one-shot, idempotent, safe to re-run.
 *
 *   node scripts/migrate-design.mjs --dry     (report only)
 *   node scripts/migrate-design.mjs --apply   (write changes)
 *
 * Rules:
 *   1. `sm:` → `md:`  — the breakpoint set is now 375/768/1024/1440, so every
 *      class that used to mean "≥640px" moves to the 768px step. Phones keep
 *      their (cleaner) base styling; tablets/desktop are visually unchanged.
 *   2. Arbitrary text sizes (`text-[12.5px]`) → nearest canonical scale step.
 *   3. Off-scale spacing utilities (`p-5`, `gap-7`, `mt-2.5`) and arbitrary
 *      spacing values (`p-[18px]`) → nearest step of 4/8/12/16/24/32/48/64.
 *   4. Tap targets & viewport: `min-h-[44px]`→`min-h-touch`,
 *      `min-h-[40px]`→`min-h-touch-sm`, `h-[100dvh]`→`h-dvh`.
 *   5. Intrinsic dimensions ending in whole/half 4px multiples (`h-[400px]`
 *      →`h-100`, `min-w-[20px]`→`min-w-5`) become numeric utilities.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const APPLY = process.argv.includes("--apply");
const ROOT = "src";

const TEXT_PX = [10, 11, 12, 13, 14, 15, 17, 19, 24, 30, 36];
const TEXT_NAME = ["3xs", "2xs", "xs", "sm", "base", "md", "lg", "xl", "2xl", "3xl", "4xl"];
const SPACE_PX = [0, 4, 8, 12, 16, 24, 32, 48, 64];
const SPACE_NUM = [0, 1, 2, 3, 4, 6, 8, 12, 16];

/** Nearest step; ties prefer the larger step (rooms to breathe). */
function nearest(value, steps) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const d = Math.abs(steps[i] - value);
    if (d <= bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

const SPACING_FAMILY = "p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y";

const RULES = [
  {
    name: "breakpoint sm→md",
    regex: /(?<![\w-])sm:/g,
    replace: () => "md:",
  },
  {
    name: "arbitrary text px",
    regex: /text-\[(\d+(?:\.\d+)?)px\]/g,
    replace: (_m, px) => `text-${TEXT_NAME[nearest(parseFloat(px), TEXT_PX)]}`,
  },
  {
    name: "arbitrary text rem",
    regex: /text-\[(\d*\.?\d+)rem\]/g,
    replace: (_m, rem) => `text-${TEXT_NAME[nearest(parseFloat(rem) * 16, TEXT_PX)]}`,
  },
  {
    name: "tap/viewport tokens",
    regex: /(?<![\w-])(min-h-\[44px\]|min-h-\[40px\]|h-\[100dvh\])/g,
    replace: (m) =>
      m === "min-h-[44px]" ? "min-h-touch" : m === "min-h-[40px]" ? "min-h-touch-sm" : "h-dvh",
  },
  {
    name: "off-scale spacing utility",
    regex: new RegExp(`(?<![\\w-])(-?)(${SPACING_FAMILY})-(\\d+(?:\\.\\d+)?)(?![\\w.%/\\-])`, "g"),
    replace: (m, sign, fam, num) => {
      const px = parseFloat(num) * 4;
      if (SPACE_PX.includes(px)) return m;
      const mapped = SPACE_NUM[nearest(px, SPACE_PX)];
      return `${sign}${fam}-${mapped}`;
    },
  },
  {
    name: "arbitrary spacing px",
    regex: new RegExp(`(?<![\\w-])(-?)(${SPACING_FAMILY})-\\[(\\d+(?:\\.\\d+)?)px\\]`, "g"),
    replace: (_m, sign, fam, px) => `${sign}${fam}-${SPACE_NUM[nearest(parseFloat(px), SPACE_PX)]}`,
  },
  {
    name: "numeric intrinsic dims",
    regex: /(?<![\w-])(w|h|min-w|min-h|max-w|max-h|size|basis)-\[(\d+(?:\.\d+)?)px\]/g,
    replace: (m, fam, px) => {
      const n = parseFloat(px) / 4;
      if (!Number.isInteger(n * 2)) return m; // keep odd values for the budget
      return `${fam}-${n % 1 === 0 ? n : n.toFixed(1)}`;
    },
  },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const counts = new Map(RULES.map((r) => [r.name, 0]));
let changed = 0;

for (const file of walk(ROOT)) {
  let text = readFileSync(file, "utf8");
  const before = text;

  for (const rule of RULES) {
    text = text.replace(rule.regex, (...args) => {
      const out = rule.replace(...args);
      if (out !== args[0]) counts.set(rule.name, counts.get(rule.name) + 1);
      return out;
    });
  }

  if (text !== before) {
    changed++;
    if (APPLY) writeFileSync(file, text, "utf8");
    else console.log(`~ ${relative(process.cwd(), file)}`);
  }
}

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"} — ${changed} file(s) touched`);
for (const [name, n] of counts) console.log(`  ${String(n).padStart(4)}  ${name}`);
if (!APPLY) console.log("\nRe-run with --apply to write.");
