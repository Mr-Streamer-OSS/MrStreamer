import { setLanguage } from "@mrstreamer/core/i18n";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("expo", () => {
  throw new Error("The label must not touch native code");
});

vi.mock("react-native", () => {
  throw new Error("The label must not touch native code");
});

import { fileSourceLabel } from "../src/downloads/index.ts";

it("labels only explicit file playback through a side-effect-free public import", () => {
  expect(fileSourceLabel({ kind: "file", path: "/private/copy", title: "Copy" })).toBe(
    "Downloaded",
  );
  expect(
    fileSourceLabel({ kind: "live", sourceId: "source", channelId: "1", title: "Live" }),
  ).toBeNull();
});

afterEach(() => setLanguage({ locale: "en-US", formats: "en-US" }));

it("uses the active Dutch catalogue", () => {
  setLanguage({ locale: "nl-NL", formats: "nl-NL" });
  expect(fileSourceLabel({ kind: "file", path: "/private/copy", title: "Copy" })).toBe(
    "Gedownload",
  );
});
