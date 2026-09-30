import { useEffect, useState } from "react";

function measure(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** Pixels per rem. The root font size grows with the window (see styles.css). */
export function useRem(): number {
  const [rem, setRem] = useState(measure);
  useEffect(() => {
    const update = () => setRem(measure());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return rem;
}
