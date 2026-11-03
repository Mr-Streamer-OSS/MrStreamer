import type { Day } from "./guide.ts";

/** Calendar arithmetic preserves local midnight through 23 and 25 hour days. */
export function localDay(at: number, offset = 0): Day {
  const date = new Date(at);

  return {
    from: new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset).getTime(),
    until: new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset + 1).getTime(),
  };
}
