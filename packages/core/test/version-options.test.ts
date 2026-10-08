import { describe, expect, it } from "vitest";
import type { TitleVersion } from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { versionOptions } from "../src/ondemand/version-options.ts";

const version = (
  id: string,
  tags: readonly string[],
  subscriptionId = "blue",
  listedOrder = 0,
): TitleVersion => ({ id, subscriptionId, tags, name: `Provider file ${id}`, listedOrder });

describe("the version menu choices", () => {
  it("leads with quality, puts named languages before Standard and unknown words, then uses saved provider order", () => {
    const groups = versionOptions(
      [
        version("plain", []),
        version("hd", ["HD", "NL"]),
        version("uhd-unknown", ["UHD", "HQ"]),
        version("uhd-plain", ["UHD"]),
        version("uhd-green", ["4K", "NL"], "green"),
        version("uhd-blue", ["4K", "EN"]),
        version("fhd", ["FHD"]),
        version("sd", ["SD"]),
      ],
      "en",
      ["blue", "green"],
    );
    expect(groups.map((group) => group.versions[0]?.id)).toEqual([
      "uhd-blue",
      "uhd-green",
      "uhd-plain",
      "uhd-unknown",
      "fhd",
      "hd",
      "sd",
      "plain",
    ]);
    expect(groups.map((group) => group.quality)).toEqual([
      "4K",
      "4K",
      "4K",
      "4K",
      "FHD",
      "HD",
      "SD",
      null,
    ]);
    expect(groups.find((group) => group.asListed)?.label).toBe("HQ");
  });

  it("keeps equal hints in one provider's disclosure with every distinct exact file reachable", () => {
    const choices = [
      version("later", ["4K"], "blue", 8),
      version("first", ["UHD"], "blue", 1),
      version("green", ["4K"], "green"),
    ];
    const groups = versionOptions(choices, "en", ["blue", "green"]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.versions.map((file) => file.id)).toEqual(["first", "later"]);
    expect(groups[1]?.versions.map((file) => file.id)).toEqual(["green"]);
    expect(groups.flatMap((group) => group.versions.map(ownedKey)).toSorted()).toEqual(
      choices.map(ownedKey).toSorted(),
    );
    expect(groups[0]?.versions.map((file) => file.name)).toEqual([
      "Provider file first",
      "Provider file later",
    ]);
  });

  it("collapses only the same exact owned id, never matching labels or ids at different providers", () => {
    const file = version("same", ["HD"]);
    const groups = versionOptions(
      [file, file, version("different", ["HD"]), version("same", ["HD"], "green")],
      null,
      ["blue", "green"],
    );
    expect(groups.flatMap((group) => group.versions.map(ownedKey))).toEqual([
      "blue:same",
      "blue:different",
      "green:same",
    ]);
  });

  it("keeps observed tracks on their actual file without inferring tracks for its grouped companion", () => {
    const read = {
      ...version("read", ["4K"]),
      observed: { files: 1, audio: ["en"], subtitles: [] },
    };
    const unread = version("unread", ["4K"]);
    const group = versionOptions([read, unread], null, ["blue"])[0];
    expect(group?.versions[0]?.observed).toEqual({ files: 1, audio: ["en"], subtitles: [] });
    expect(group?.versions[1]?.observed).toBeUndefined();
  });

  it("recognizes original and multi-subtitle marks without treating unfamiliar words as verified languages", () => {
    const groups = versionOptions(
      [
        version("dub", ["HD", "DUB"]),
        version("subs", ["HD", "MULTISUB"]),
        version("original", ["HD", "VO"]),
      ],
      "en",
      ["blue"],
    );
    expect(groups.map(({ label, asListed }) => ({ label, asListed }))).toEqual([
      { label: "Several subtitle languages", asListed: false },
      { label: "Original sound", asListed: false },
      { label: "DUB", asListed: true },
    ]);
  });
});
