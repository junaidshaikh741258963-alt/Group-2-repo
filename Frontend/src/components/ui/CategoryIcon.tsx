import { memo } from "react";
import { categoryIconPaths } from "@/lib/categoryIcons";

export default memo(function CategoryIcon({
  kind,
  className = "w-5 h-5",
}: {
  kind: string;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {categoryIconPaths(kind).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
});
