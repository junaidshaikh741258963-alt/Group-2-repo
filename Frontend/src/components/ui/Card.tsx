import type { CSSProperties, ReactNode } from "react";
import { PAD } from "./tokens";

const VARIANT = {
  raised: "border-hairline bg-surface-1 shadow-md",
  quiet: "border-hairline bg-surface-1",
  flush: "border-hairline bg-canvas",
} as const;

/** Surface card: 16px radius, hairline border, padding from the spacing scale. */
export default function Card({
  variant = "quiet",
  pad = 4,
  className = "",
  style,
  children,
}: {
  variant?: keyof typeof VARIANT;
  pad?: keyof typeof PAD;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div style={style} className={`rounded-2xl border ${VARIANT[variant]} ${PAD[pad]} ${className}`.trim()}>
      {children}
    </div>
  );
}
