import type { GuideOrigin } from "./guide.ts";

/** Runtime-owned provider origins; removal deletes the origin before revoking native work. */
export const origins = new Map<string, GuideOrigin>();
export const currentSource = (id: string) => origins.get(id);
