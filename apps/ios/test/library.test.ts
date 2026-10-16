import type { ProviderChannel } from "@mrstreamer/core/provider";
import { describe, expect, it } from "vitest";
import { buildLibrary } from "../src/library.ts";

// What Live can show of a provider's channel list: every channel it may show is in some region,
// whatever categories the provider lists, and channels for adults stay out.

const channel = (
  id: string,
  name: string,
  categoryIds: string[],
  adult = false,
): ProviderChannel => ({
  id,
  name,
  number: null,
  logoUrl: null,
  categoryIds,
  guideId: null,
  adult,
  catchupDays: null,
});

const shown = (regions: ReturnType<typeof buildLibrary>["regions"]) =>
  regions.map((region) => [region.name, region.channels.map((each) => each.title)]);

describe("the channels Live shows", () => {
  it("shows every channel when the provider lists no categories", () => {
    const library = buildLibrary({
      categories: [],
      channels: [channel("1", "Alpha", ["10"]), channel("2", "Bravo", [])],
    });
    expect(shown(library.regions)).toEqual([["All channels", ["Alpha", "Bravo"]]]);
  });

  it("shows channels outside the listed categories after them, once", () => {
    const library = buildLibrary({
      categories: [{ id: "10", name: "News" }],
      channels: [
        channel("1", "Alpha", ["10"]),
        channel("2", "Bravo", ["99"]),
        channel("3", "Charlie", []),
        channel("4", "Delta", ["10", "99"]),
      ],
    });
    expect(shown(library.regions)).toEqual([
      ["News", ["Alpha", "Delta"]],
      ["Other channels", ["Bravo", "Charlie"]],
    ]);
    expect(library.placeOf.get(library.byId.get("2")!.id)).toBe("Other channels");
  });

  it("adds them to a provider category of the same name, which Live finds by that name", () => {
    const library = buildLibrary({
      categories: [
        { id: "10", name: "News" },
        { id: "20", name: "Other channels" },
      ],
      channels: [
        channel("1", "Alpha", ["10"]),
        channel("2", "Bravo", ["20"]),
        channel("3", "Charlie", []),
      ],
    });
    expect(shown(library.regions)).toEqual([
      ["News", ["Alpha"]],
      ["Other channels", ["Bravo", "Charlie"]],
    ]);
    const chosen = library.regions.find((region) => region.name === "Other channels");
    expect(chosen?.shelves.map((shelf) => shelf.title)).toEqual(["Other channels"]);
  });

  it("leaves channels for adults out, and nothing to show when that is all there is", () => {
    const library = buildLibrary({
      categories: [],
      channels: [channel("1", "Late", [], true)],
    });
    expect(library.regions).toEqual([]);
  });
});
