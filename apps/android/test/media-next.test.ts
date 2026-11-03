import { expect, it } from "vitest";
import { fixture } from "./library-fixture.ts";
import { nextEpisode } from "../src/player/next-episode.ts";

it("follows Library version order across seasons, with Specials last, and requires an exact container", async () => {
  const f = fixture();
  await f.model.refresh();
  const title = f.model.made("series").list("all")[0]!;
  const details = await f.model.details(title);
  expect(details.value?.kind).toBe("series");

  const current = {
    kind: "title",
    media: "episode",
    sourceId: "source",
    id: "first",
    container: "mp4",
    title: "First",
  } as const;

  expect(nextEpisode(details, current)).toEqual({
    intent: { ...current, id: "second", title: "Episode 1" },
    label: "S2 E1 · Episode 1",
  });
  expect(nextEpisode(details, { ...current, id: "second" })?.intent.id).toBe("special");
  expect(nextEpisode(details, { ...current, id: "special" })).toBeUndefined();

  if (details.value?.kind !== "series") throw new Error("Expected series");
  expect(
    nextEpisode(
      {
        ...details,
        value: { ...details.value, seasons: details.value.seasons.filter((s) => s.number !== 0) },
      },
      { ...current, id: "second" },
    ),
  ).toBeUndefined();
  expect(nextEpisode({ ...details, containers: new Map() }, current)).toBeUndefined();
  expect(nextEpisode(details, { ...current, sourceId: "other" })).toBeUndefined();
});
