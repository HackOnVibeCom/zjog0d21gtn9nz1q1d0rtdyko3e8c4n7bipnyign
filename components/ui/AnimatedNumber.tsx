"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The live click counter is the moment the product proves itself, so a change
 * gets a brief, quiet emphasis — never confetti, and nothing that moves when
 * the number has not changed.
 */
export function AnimatedNumber({ value, className = "" }: { value: number; className?: string }) {
  const previous = useRef(value);
  const [bump, setBump] = useState(false);

  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setBump(true);
    const t = setTimeout(() => setBump(false), 620);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <span className={`${className} ${bump ? "metric-bump" : ""}`.trim()} style={{ display: "inline-block" }}>
      {value.toLocaleString()}
    </span>
  );
}
