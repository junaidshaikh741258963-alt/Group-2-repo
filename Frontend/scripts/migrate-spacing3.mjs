/**
 * Spacing codemod #3 — snap off-scale spacing steps to the token scale.
 *
 *   node scripts/migrate-spacing3.mjs
 *
 * The design scale allows 0·4·8·12·16·24·32·48·64 px, i.e. steps
 * 0,1,2,3,4,6,8,12,16. Values like 1.5 / 2.5 / 3.5 / 5 / 7 / 9 / 10 slipped
 * in while building chat cards and the live planner; this maps each to the
 * nearest allowed step (ties round down; below 1 step rounds up to 1 so chips
 * keep their breathing room). Idempotent — rerunning is a no-op.
 *
 * Only p/m/gap spacing utilities are touched; width/height utilities
 * (w-3.5, h-2.5 …) are a separate, budgeted dimension category.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED_PX = [0, 4, 8, 12, 16, 24, 32, 48, 64];
const ALLOWED_STEPS = new Set(ALLOWED_PX.map((px) => px / 4));

const RE =
  /(?<![\w-])(-?)((?:gap-x|gap-y|gap|px|py|pt|pr|pb|pl|p|mx|my|mt|mr|mb|ml|m)-)(\d+(?:\.\d+)?)(?![\w.%/-])/g;

function snap(step) {
  if (ALLOWED_STEPS.has(step)) return step;
  if (step < 1) return 1;
  const px = step * 4;
  let best = null;
  for (const allowed of ALLOWED_PX) {
    const d = Math.abs(allowed - px);
    if (best === null || d < best.d || (d === best.d && allowed < best.px)) {
      best = { px: allowed, d, step: allowed / 4 };
    }
  }
  return best.step;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

let files = 0;
let swaps = 0;
for (const file of walk("src")) {
  const text = readFileSync(file, "utf8");
  const next = text.replace(RE, (match, sign, prefix, raw) => {
    const step = parseFloat(raw);
    const snapped = snap(step);
    if (snapped === step) return match;
    swaps++;
    return `${sign}${prefix}${snapped}`;
  });
  if (next !== text) {
    writeFileSync(file, next);
    files++;
    console.log("updated", file);
  }
}

console.log(`migrate-spacing3: ${swaps} swaps across ${files} files`);
