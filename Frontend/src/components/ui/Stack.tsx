import type { ReactNode } from "react";
import { SPACE, type SpaceKey } from "./tokens";

/**
 * Vertical stack. All rhythm comes from `gap` — never margin.
 * `<Stack gap={4}>` == 16px between children.
 */
export default function Stack({
  gap = 2,
  className = "",
  children,
}: {
  gap?: SpaceKey;
  className?: string;
  children?: ReactNode;
}) {
  return <div className={`flex flex-col ${SPACE[gap]} ${className}`.trim()}>{children}</div>;
}
