import { createRoot, document, Event } from "./dom.ts";
import { formatDate } from "@mrstreamer/core/i18n";
import type { HTMLInputElement } from "happy-dom";
import * as React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GuideLink, GuideRefusal } from "../src/guide-sources.ts";
import type { GuideStatus } from "../src/guide.ts";

// Settings > Guides and Map channels, with React DOM on a happy-dom window over stand-ins for the
// guide owners: what each guide's row says, the add form's refusals, Remove's confirmation, and a
// channel's mapping with its preview. No saved link is ever on screen.

const scenario = vi.hoisted(() => ({
  sheet: null as { options: readonly string[]; pick: (index: number) => void } | null,
  alert: null as {
    title: string;
    buttons: readonly { text: string; onPress?: () => void }[];
  } | null,
  calls: [] as string[],
  refusal: null as GuideRefusal | null,
  statuses: new Map<string, Partial<GuideStatus>>(),
  ownIds: [] as string[],
  previews: new Map<string, unknown>(),
}));

const stores = await vi.hoisted(async () => {
  const { store } = await import("../src/store.ts");
  return {
    links: store<readonly GuideLink[]>([]),
    mappings: store<ReadonlyMap<string, string>>(new Map()),
  };
});

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-router", () => ({
  router: {
    push: (to: unknown) => scenario.calls.push(`push ${JSON.stringify(to)}`),
    back: () => scenario.calls.push("back"),
  },
}));
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { options }: { options: readonly string[] },
      pick: (index: number) => void,
    ) => {
      scenario.sheet = { options, pick };
    },
  },
  Alert: {
    alert: (title: string, _: string, buttons: { text: string; onPress?: () => void }[]) => {
      scenario.alert = { title, buttons };
    },
  },
}));
vi.mock("../src/header.tsx", () => ({ useTabs: () => null }));
vi.mock("../src/account.ts", () => ({
  useCatalogue: () => ({
    kind: "ready",
    failing: [],
    library: {
      channels: [{ key: "home:7", title: "BBC Two HD" }],
      byKey: new Map([
        ["home:7", { key: "home:7", title: "BBC Two HD" }],
        ["home:1", { key: "home:1", title: "BBC One HD" }],
      ]),
      placeOf: new Map([["home:7", "United Kingdom · Entertainment"]]),
      labels: new Map([["home", "Living room"]]),
      regions: [],
    },
  }),
}));
vi.mock("../src/guide-sources.ts", async () => {
  const { useStore } = await import("../src/store.ts");
  const { links, mappings } = stores;
  const log = (call: string) => scenario.calls.push(call);
  return {
    GUIDE_LIMIT: 8,
    MAPPING_MAX: 512,
    guides: {
      useLinks: () => useStore(links),
      useMappings: () => useStore(mappings),
      async add(link: string, name: string) {
        log(`add ${name}`);
        if (scenario.refusal) return scenario.refusal;
        const url = new URL(link);
        links.set((now) => [
          ...now,
          { id: "xmltv-new", origin: url.origin, name: name || null, locked: false },
        ]);
        return null;
      },
      async replace(id: string, link: string) {
        // The link's host, so the log holds no secret.
        log(`replace ${id} ${URL.parse(link)?.host ?? "?"}`);
        return scenario.refusal;
      },
      async remove(id: string) {
        log(`remove ${id}`);
      },
      async refresh(id: string) {
        log(`refresh ${id}`);
      },
      async map(key: string, id: string | null) {
        log(`map ${key} ${id}`);
        return scenario.refusal;
      },
    },
  };
});
vi.mock("../src/guide.ts", () => ({
  guide: {
    subscribe: () => () => undefined,
    getSnapshot: () => scenario.statuses,
    status: (id: string): GuideStatus => ({
      availability: "unknown",
      activity: "idle",
      fetchedAt: null,
      stale: false,
      error: null,
      ...scenario.statuses.get(id),
    }),
    guideIdsOf: () => scenario.ownIds,
    preview: async (_: string, id: string) => scenario.previews.get(id) ?? null,
  },
}));

const { GuidesScreen, GuideMapEditor, GuideMapScreen } = await import("../src/guides-screen.tsx");

const SECRET = "https://epg.example.com/guide.xml?token=s3cret";
const AT = new Date(2026, 9, 29, 10, 12).getTime();

let unmount = () => {};
beforeEach(() => {
  stores.links.set([]);
  stores.mappings.set(new Map());
});
afterEach(() => {
  unmount();
  scenario.sheet = null;
  scenario.alert = null;
  scenario.calls.length = 0;
  scenario.refusal = null;
  scenario.statuses.clear();
  scenario.ownIds = [];
  scenario.previews.clear();
});

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await React.act(async () => root.render(element));
  unmount = () => React.act(() => root.unmount());
  const find = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  return {
    container,
    text: (id: string) => find(id)?.textContent ?? null,
    label: (id: string) => find(id)?.getAttribute("aria-label") ?? null,
    press: (id: string) =>
      React.act(async () => {
        find(id)!.dispatchEvent(new Event("click", { bubbles: true }));
      }),
    type: (id: string, value: string) =>
      React.act(async () => {
        // React tracks the value it last rendered; setting it through the prototype lets the
        // input event read as a change.
        const input = find(id) as unknown as HTMLInputElement;
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }),
  };
}

it("shows a refusal inline, then adds the guide by its host, never its link", async () => {
  const screen = await render(React.createElement(GuidesScreen));
  await screen.type("guides-xmltv-link", SECRET);
  scenario.refusal = "duplicate";
  await screen.press("guides-submit");
  expect(screen.text("guides-refusal")).toBe("That guide is added already");

  scenario.refusal = null;
  await screen.type("guides-xmltv-link", `${SECRET}&again`);
  expect(screen.text("guides-refusal")).toBeNull();
  await screen.press("guides-submit");
  expect(scenario.calls).toEqual(["add ", "add "]);
  expect(screen.label("guides-xmltv-new")).toBe("epg.example.com, Not downloaded yet");
  expect(screen.container.innerHTML).not.toContain("s3cret");
});

it("says why a guide failed and that its last good guide stays; a locked one asks for its link", async () => {
  stores.links.set([
    { id: "xmltv-a", origin: "https://a.example", name: "Sport", locked: false },
    { id: "xmltv-b", origin: "https://b.example", name: null, locked: true },
    { id: "xmltv-c", origin: "https://c.example", name: "News", locked: false },
  ]);
  scenario.statuses.set("xmltv-a", {
    availability: "available",
    fetchedAt: AT,
    error: "network",
  });
  scenario.statuses.set("xmltv-c", { activity: "loading" });
  const screen = await render(React.createElement(GuidesScreen));
  expect(screen.label("guides-xmltv-a")).toBe(
    `Sport, The guide's server didn't answer, Showing the guide from ${formatDate(AT, "day")} ${formatDate(AT, "time")}`,
  );
  expect(screen.label("guides-xmltv-b")).toBe("b.example, Enter the link again");
  expect(screen.label("guides-xmltv-c")).toBe("News, Downloading");

  await screen.press("guides-xmltv-b");
  const sheet = scenario.sheet!;
  expect(sheet.options).toEqual(["Enter link", "Remove", "Cancel"]);
  await React.act(async () => sheet.pick(0));
  expect(screen.container.textContent).toContain("New link for b.example");
  await screen.type("guides-xmltv-link", SECRET);
  await screen.press("guides-submit");
  expect(scenario.calls).toEqual(["replace xmltv-b epg.example.com"]);
});

it("removes a guide only once Remove is confirmed", async () => {
  stores.links.set([{ id: "xmltv-a", origin: "https://a.example", name: "Sport", locked: false }]);
  const screen = await render(React.createElement(GuidesScreen));
  await screen.press("guides-xmltv-a");
  const sheet = scenario.sheet!;
  expect(sheet.options).toEqual(["Refresh", "Replace link", "Remove", "Cancel"]);
  React.act(() => sheet.pick(sheet.options.indexOf("Remove")));
  expect(scenario.alert!.title).toBe("Remove Sport?");
  expect(scenario.calls).toEqual([]);
  React.act(() => scenario.alert!.buttons.find((each) => each.text === "Remove")!.onPress!());
  expect(scenario.calls).toEqual(["remove xmltv-a"]);
});

it("refreshes a guide, and gives it a new link through the same form, refusals inline", async () => {
  stores.links.set([{ id: "xmltv-a", origin: "https://a.example", name: "Sport", locked: false }]);
  const screen = await render(React.createElement(GuidesScreen));
  const pick = async (action: string) => {
    await screen.press("guides-xmltv-a");
    const sheet = scenario.sheet!;
    await React.act(async () => sheet.pick(sheet.options.indexOf(action)));
  };
  await pick("Refresh");
  expect(scenario.calls).toEqual(["refresh xmltv-a"]);

  await pick("Replace link");
  expect(screen.container.textContent).toContain("New link for Sport");
  expect(screen.text("guides-name")).toBeNull();
  await screen.press("guides-cancel");
  expect(screen.container.textContent).toContain("Add guide");

  await pick("Replace link");
  await screen.type("guides-xmltv-link", SECRET);
  scenario.refusal = "address";
  await screen.press("guides-submit");
  expect(screen.text("guides-refusal")).toBe("That isn't a web link");
  scenario.refusal = null;
  await screen.press("guides-submit");
  expect(scenario.calls.slice(1)).toEqual([
    "replace xmltv-a epg.example.com",
    "replace xmltv-a epg.example.com",
  ]);
  expect(screen.container.textContent).toContain("Add guide");
  expect(screen.container.innerHTML).not.toContain("s3cret");
});

it("finds channels by name or mapped guide id", async () => {
  stores.mappings.set(new Map([["home:1", "BBC1.uk"]]));
  const screen = await render(React.createElement(GuideMapScreen));
  await screen.type("guide-map-search", "two");
  expect(screen.label("guide-map-home:7")).not.toBeNull();
  expect(screen.label("guide-map-home:1")).toBeNull();
  await screen.type("guide-map-search", "bbc1.uk");
  expect(screen.label("guide-map-home:1")).not.toBeNull();
  expect(screen.label("guide-map-home:7")).toBeNull();
});

it("keeps the editor open with the refusal when a mapping isn't saved", async () => {
  const screen = await render(React.createElement(GuideMapEditor, { channelKey: "home:7" }));
  await screen.type("guide-map-id", "bbc2.uk");
  scenario.refusal = "saving";
  await screen.press("guide-map-save");
  expect(screen.text("guide-map-refusal")).toBe("Couldn't save. Nothing changed.");
  expect(scenario.calls).toEqual(["map home:7 bbc2.uk"]);
  scenario.refusal = null;
  await screen.press("guide-map-save");
  expect(scenario.calls).toEqual(["map home:7 bbc2.uk", "map home:7 bbc2.uk", "back"]);
});

it("lists mapped channels first, those no longer listed too, then Automatic ones", async () => {
  stores.mappings.set(
    new Map([
      ["home:1", "BBC1.uk"],
      ["home:99", "SVT1.se"],
    ]),
  );
  const screen = await render(React.createElement(GuideMapScreen));
  expect(screen.label("guide-map-home:1")).toBe("BBC One HD, BBC1.uk");
  expect(screen.label("guide-map-home:99")).toBe(
    "Channel 99, Living room · No longer listed, SVT1.se",
  );
  expect(screen.label("guide-map-home:7")).toBe(
    "BBC Two HD, United Kingdom · Entertainment, Automatic",
  );
});

it("previews which guide answers a guide id, saves it, and clears back to Automatic", async () => {
  stores.links.set([
    { id: "xmltv-a", origin: "https://a.example", name: "UK Freeview", locked: false },
  ]);
  stores.mappings.set(new Map([["home:1", "BBC1.uk"]]));
  scenario.ownIds = ["bbc1.uk.hd"];
  scenario.previews.set("BBC1.uk", {
    guide: "xmltv-a",
    listing: {
      now: { start: AT, stop: 0, title: "EastEnders" },
      next: null,
    },
  });
  const screen = await render(React.createElement(GuideMapEditor, { channelKey: "home:1" }));
  expect(screen.text("guide-map-own")).toBe("Its guide idsbbc1.uk.hd");
  expect(screen.text("guide-map-preview")).toBe(
    `From UK FreeviewNow  ${formatDate(AT, "time")}  EastEnders`,
  );

  await screen.type("guide-map-id", "nobody.tv");
  expect(screen.text("guide-map-preview")).toBe("No guide has programmes for this id now");
  await screen.press("guide-map-save");
  expect(scenario.calls).toEqual(["map home:1 nobody.tv", "back"]);

  scenario.calls.length = 0;
  await screen.press("guide-map-clear");
  expect(scenario.calls).toEqual(["map home:1 null", "back"]);
});
