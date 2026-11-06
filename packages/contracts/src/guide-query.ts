import { type } from "arktype";
import { lazy, type Infer } from "./lazy.ts";

/** Dates overlap [from, until); absent dates search the entire retained horizon. */
export const GuideQuery = lazy(() =>
  type({
    query: "string <= 512",
    "from?": "number.safe",
    "until?": "number.safe",
    "channels?": type("string > 0").array().atMostLength(100),
  }),
);

export type GuideQuery = Infer<typeof GuideQuery>;

export const SavedGuideQuery = lazy(() =>
  GuideQuery().merge({
    name: "0 < string <= 80",
    "days?": '"any" | "before" | "today" | "tomorrow" | "week"',
  }),
);

export type SavedGuideQuery = Infer<typeof SavedGuideQuery>;

/** A page cursor is valid for the same query and subscription; refreshes may change results. */
export const GuideSearchPageInput = lazy(() =>
  GuideQuery().merge({
    subscriptionId: "string > 0",
    limit: "1 <= number.integer <= 100",
    "after?": { start: "number.safe", channel: "string > 0" },
  }),
);

export type GuideSearchPageInput = Infer<typeof GuideSearchPageInput>;
