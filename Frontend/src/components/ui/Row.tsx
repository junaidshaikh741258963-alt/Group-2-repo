import type { ReactNode } from "react";
import { SPACE, type SpaceKey } from "./tokens";

const ALIGN = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  baseline: "items-baseline",
  stretch: "items-stretch",
} as const;

const JUSTIFY = {
  start: "justify-start",
  center: "justify-center",
  between: "justify-between",
  end: "justify-end",
} as const;

/** Horizontal row. Wrap explicitly; rhythm comes from `gap`. */
export default function Row({
  gap = 2,
  wrap = false,
  align = "center",
  justify = "start",
  className = "",
  children,
}: {
  gap?: SpaceKey;
  wrap?: boolean;
  align?: keyof typeof ALIGN;
  justify?: keyof typeof JUSTIFY;
  className?: string;
  children?: ReactNode;
}) {
  const cls = ["flex flex-row", SPACE[gap], ALIGN[align], JUSTIFY[justify], wrap ? "flex-wrap" : "", className]
    .filter(Boolean)
    .join(" ");
  return <div className={cls}>{children}</div>;
}
