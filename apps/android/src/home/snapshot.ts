import { type } from "arktype";
import { RawTitleRef } from "@mrstreamer/contracts/ondemand";

const episode = type({
  kind: "'episode'",
  id: "string",
  seriesId: "string",
  season: "number",
  episode: "number",
});

const mark = type({
  season: "number",
  episode: "number",
  watched: "boolean",
  at: "number",
  revision: "number",
  series: "string",
  title: episode,
});

const series = type({
  marks: mark.array(),
  versions: "string[]",
  listing: type({ number: "number", episodes: "number[]", "files?": "string[]" }).array(),
  hidden: "boolean",
  leftAt: "number | null",
  changed: "number",
  undo: type({ revision: "number", prior: mark.or("null"), hidden: "boolean" }).or("null"),
});

const numbers = type({ "[string]": "number" });

const account = type({
  state: { favourites: "string[]", recent: "string[]" },
  sequence: "number",
  placed: { favourites: numbers, recent: numbers },
  removals: numbers,
  rows: type({
    title: RawTitleRef(),
    position: "number",
    duration: "number",
    finished: "boolean",
    at: "number",
    since: "number",
    hidden: "boolean",
    removedAt: "number | null",
  }).array(),
  series: type({ "[string]": series }),
});

/** Reject malformed persisted records before core can publish or replace them. */
export const Snapshot = type({
  version: "1",
  sequence: "number",
  receipts: "string[]",
  imported: "boolean",
  accounts: type({ "[string]": account }),
});
