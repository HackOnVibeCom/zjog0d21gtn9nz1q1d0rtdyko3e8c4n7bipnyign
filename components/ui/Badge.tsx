import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

/** Small status pill. Tone carries meaning, so keep the mapping deliberate. */
export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return <span className={`badge badge-${tone} ${className}`.trim()}>{children}</span>;
}

/** A plain, lower-emphasis token — used for facts rather than status. */
export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}
