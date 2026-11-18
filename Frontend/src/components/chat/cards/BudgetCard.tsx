"use client";

import { memo } from "react";
import {
  BUDGET_CATEGORY_LABEL,
  categoryShare,
  formatMoney,
  type BudgetSummary,
} from "@/lib/itinerary/budget";

interface BudgetCardProps {
  summary: BudgetSummary;
  travelers: number;
}

/**
 * Trip budget from the plan's own cost lines. Kept as a quiet, collapsed
 * receipt under the reply: the total is always visible, the day/category
 * breakdown opens on demand. Bars are scaled against the largest day/category
 * so the shape is readable; amounts are the parsed numbers, and anything that
 * couldn't be parsed is listed instead of guessed.
 */
function BudgetCard({ summary, travelers }: BudgetCardProps) {
  if (summary.countedEntries === 0 && summary.unparsed.length === 0) return null;
  const maxDay = Math.max(1, ...summary.perDay.map((d) => d.total));
  const maxCat = Math.max(1, ...summary.perCategory.map((c) => c.total));
  const mixed = summary.currency === null;

  return (
    <details className="group mt-3 animate-card-in overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/[0.06] text-zinc-300"
          aria-hidden
        >
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 3h12a1 1 0 0 1 1 1v16l-3-2-2 2-2-2-2 2-2-2-3 2V4a1 1 0 0 1 1-1Z"
            />
            <path strokeLinecap="round" d="M9 8h6M9 12h6" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-ink">
            Trip budget · {formatMoney(summary.total, summary.currency)}
          </span>
          <span className="block truncate text-2xs text-zinc-500">
            {summary.countedEntries} cost{summary.countedEntries === 1 ? "" : "s"} parsed
            {travelers > 1
              ? ` · ${formatMoney(summary.perTraveler, summary.currency)} pp`
              : ""}
            {mixed ? " · mixed currencies" : ""}
          </span>
        </span>
        <svg
          className="h-4 w-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-180"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
        </svg>
      </summary>

      {mixed && (
        <p className="border-t border-white/[0.06] bg-amber-400/10 px-3 py-2 text-2xs leading-relaxed text-amber-200">
          Costs are in {summary.currencies.join(" and ")} — each amount is shown in its own
          currency.
        </p>
      )}

      <div className="grid gap-4 border-t border-white/[0.06] px-3 py-3 md:grid-cols-2">
        {summary.perDay.length > 0 && (
          <div>
            <h5 className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">
              Per day
            </h5>
            <ul className="mt-2 flex flex-col gap-1" role="list">
              {summary.perDay.map((d) => (
                <li key={d.day} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-xs text-ink-muted">Day {d.day}</span>
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/8">
                    <span
                      className="block h-full rounded-full bg-accent-strong/80"
                      style={{ width: `${Math.max(4, categoryShare(maxDay, d.total))}%` }}
                    />
                  </span>
                  <span className="min-w-16 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-ink">
                    {formatMoney(d.total, summary.currency)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {summary.perCategory.length > 0 && (
          <div>
            <h5 className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">
              By category
            </h5>
            <ul className="mt-2 flex flex-col gap-1" role="list">
              {summary.perCategory.map((c) => (
                <li key={c.category} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 truncate text-xs text-ink-muted">
                    {BUDGET_CATEGORY_LABEL[c.category]}
                  </span>
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/8">
                    <span
                      className="block h-full rounded-full bg-emerald-400/70"
                      style={{ width: `${Math.max(4, categoryShare(maxCat, c.total))}%` }}
                    />
                  </span>
                  <span className="min-w-16 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-ink">
                    {formatMoney(c.total, summary.currency)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {summary.unparsed.length > 0 && (
        <p className="border-t border-white/[0.06] px-3 py-2 text-2xs text-ink-faint">
          Not counted (no number to parse): {summary.unparsed.join(", ")}
        </p>
      )}
      <p className="border-t border-white/[0.06] px-3 py-2 text-2xs text-ink-faint">
        Estimates from the plan&apos;s stated costs — live prices are confirmed at booking.
      </p>
    </details>
  );
}

export default memo(BudgetCard);
