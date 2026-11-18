import type { ReactNode } from "react";

const SIZE = {
  page: "max-w-300",
  list: "max-w-224",
  prose: "max-w-190",
  wide: "max-w-360",
  full: "max-w-none",
} as const;

/** Centered content band with the canonical page gutters (16px → 24px @768). */
export default function Container({
  size = "page",
  className = "",
  children,
}: {
  size?: keyof typeof SIZE;
  className?: string;
  children?: ReactNode;
}) {
  return <div className={`mx-auto w-full px-4 md:px-6 ${SIZE[size]} ${className}`.trim()}>{children}</div>;
}
