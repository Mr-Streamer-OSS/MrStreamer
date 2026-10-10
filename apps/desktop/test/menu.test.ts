// The macOS menu bar in the interface language: the same items and shortcuts, in its words.
import type { MenuItemConstructorOptions } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "@mrstreamer/core/i18n";
import { macMenu } from "../src/main/menu.ts";

afterEach(() => setLanguage({ locale: "en-US", formats: "en-US" }));

/** Each item as its role and label, with the items of its menu. */
type Shape = readonly [role: string | null, label: string | undefined, items?: readonly Shape[]];

function shape(items: readonly MenuItemConstructorOptions[]): Shape[] {
  return items
    .filter((item) => item.type !== "separator")
    .map((item) =>
      Array.isArray(item.submenu)
        ? [item.role ?? null, item.label, shape(item.submenu)]
        : [item.role ?? null, item.label],
    );
}

/** What the items do, without what they say. */
function roles(menu: readonly Shape[]): unknown[] {
  return menu.map(([role, , items]) => [role, items && roles(items)]);
}

describe("the macOS menu bar", () => {
  it("names its items in the interface language and keeps what each does", () => {
    const english = shape(macMenu("Mr. Streamer", () => {}));
    setLanguage({ locale: "de-DE", formats: "de-DE" });
    const german = shape(macMenu("Mr. Streamer", () => {}));

    expect(roles(german)).toEqual(roles(english));
    expect(german).toContainEqual([
      "editMenu",
      "Bearbeiten",
      expect.arrayContaining([
        ["copy", "Kopieren"],
        ["paste", "Einsetzen"],
        ["selectAll", "Alles auswählen"],
      ]),
    ]);
    expect(german[0]).toEqual([
      "appMenu",
      "Mr. Streamer",
      expect.arrayContaining([
        ["about", "Über Mr. Streamer"],
        ["quit", "Mr. Streamer beenden"],
      ]),
    ]);
  });
});
