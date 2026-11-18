import type { ReactNode } from "react";
import { COLS, MD_COLS, SPACE, type SpaceKey } from "./tokens";

/** CSS grid with a canonical column count (optionally overridden from md up). */
export default function Grid({
  cols = 1,
  mdCols,
  gap = 3,
  className = "",
  children,
}: {
  cols?: keyof typeof COLS;
  mdCols?: keyof typeof MD_COLS;
  gap?: SpaceKey;
  className?: string;
  children?: ReactNode;
}) {
  const cls = ["grid", COLS[cols], mdCols ? MD_COLS[mdCols] : "", SPACE[gap], className]
    .filter(Boolean)
    .join(" ");
  return <div className={cls}>{children}</div>;
}
