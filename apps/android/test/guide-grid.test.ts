import { mount, ui } from "./guide-grid-fixture.ts";
import { act, createElement as h } from "react";
import { expect, it, vi } from "vitest";
import { setLanguage } from "@mrstreamer/core/i18n";
import { guideFixture } from "./guide-fixture.ts";
import { GuideGrid, t } from "../src/guide/grid.tsx";
import { createGuide, localDay } from "../src/guide/guide.ts";

it("reads at most 24 visible channels and two pages, and opens the channel Schedule", async () => {
  ui.schedule.mockImplementation(async (_key, _day, cursor) => ({
    programmes: [],
    cursor: cursor ? "more" : "second",
  }));
  const screen = await mount(h(GuideGrid));

  try {
    await screen.click("Show visible");
    const keys = new Set(ui.schedule.mock.calls.map((c) => c[0]));
    expect(keys.size).toBe(24);
    expect(ui.schedule.mock.calls.filter((c) => c[0] === "source:0")).toHaveLength(2);
    expect(screen.container.textContent).toContain("More in Schedule");
    await screen.click("Schedule for Channel 0");
    expect(ui.push).toHaveBeenLastCalledWith(
      expect.stringContaining("/guide/schedule?source=source&channel=0&day="),
    );
  } finally {
    await screen.close();
  }
});

it("keeps the local time window when changing day across DST, and Now resets it", async () => {
  setLanguage({ locale: "en-US", formats: "nl-NL" });
  vi.stubEnv("TZ", "Europe/Brussels");
  vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 24, 12).getTime());
  ui.schedule.mockClear().mockResolvedValue({ programmes: [], cursor: null });
  const screen = await mount(h(GuideGrid));

  try {
    expect(screen.container.textContent).not.toContain("13:00");
    await screen.click("Later");
    expect(screen.container.textContent).toContain("13:00");
    expect(screen.container.textContent).toContain("12:30");
    await act(async () => ui.swipe(-80, 5));
    expect(screen.container.textContent).toContain("13:30");
    await act(async () => ui.swipe(-5, 80));
    expect(screen.container.textContent).toContain("13:00");
    await screen.click("Next day");
    const day = ui.schedule.mock.calls.at(-1)?.[1];
    expect(day).toEqual(localDay(Date.now(), 1));
    expect(day.until - day.from).toBe(25 * 3600000);
    expect(screen.container.textContent).toContain("13:00");
    await screen.click("Now");
    expect(ui.schedule.mock.calls.at(-1)?.[1]).toEqual(localDay(Date.now()));
  } finally {
    await screen.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setLanguage({ locale: "en-US", formats: "en-US" });
  }
});

it("translates guide browsing and search copy into Dutch", () => {
  try {
    setLanguage({ locale: "nl-NL", formats: "nl-NL" });

    for (const key of [
      "Guide",
      "Earlier",
      "Now",
      "More in Schedule",
      "Nothing in this window",
      "No programme information",
      "Search programmes",
      "Searching.",
      "Some programmes not searched.",
      "Guides",
      "Retry",
    ] as const)
      expect(t(key)).not.toBe(key);
    expect(t("Schedule for {channel}", { channel: "News" })).toBe("Zendschema voor News");
    expect(t('Nothing named "{query}"', { query: "news" })).toBe('Niets met de naam "news"');
  } finally {
    setLanguage({ locale: "en-US", formats: "en-US" });
  }
});

it("keeps first-page programmes if the second read fails and offers Schedule and Retry", async () => {
  const now = Date.now();
  ui.schedule.mockImplementation(async (_key, _day, cursor) => {
    if (cursor) throw new Error("disk");

    return {
      programmes: [{ start: now - 60000, stop: now + 3600000, title: "News", detail: "token" }],
      cursor: "second",
    };
  });
  const screen = await mount(h(GuideGrid));

  try {
    expect(screen.container.textContent).toContain("News");
    expect(screen.container.textContent).toContain("Couldn't update schedule");
    expect(screen.container.textContent).toContain("More in Schedule");
    ui.schedule.mockResolvedValue({ programmes: [], cursor: null });
    const calls = ui.schedule.mock.calls.length;
    await screen.click("Retry");
    expect(ui.schedule.mock.calls.length).toBeGreaterThan(calls);
    expect(screen.container.textContent).toContain("News");
    expect(screen.container.textContent).toContain("Couldn't update schedule");
  } finally {
    await screen.close();
  }
});

it("browses programmes through the real guide fixture and passes its revocable detail token", async () => {
  const now = Date.now();
  const { native, control } = guideFixture();

  const owner = createGuide(
    () => native,
    () => now,
    () => undefined,
  );

  control.activations.set("source", {
    lease: "offline",
    generation: { id: "db", fetchedAt: now, until: now + 86400000 },
  });
  await owner.restore(["source"]);
  const channel = { id: "0", key: "source:0", title: "Channel 0" };
  owner.setPart({
    subscriptionId: "source",
    byId: new Map([["0", channel]]),
    guideIds: new Map([["0", ["news.tv"]]]),
  });

  const programme = {
    start: now - 60000,
    stop: now + 3600000,
    title: "Fixture News",
    description: "Details",
  };

  control.query = async () => ({
    kind: "ok",
    value: { guideId: "news.tv", rows: [programme], more: false },
  });
  ui.schedule.mockImplementation(owner.schedule);
  const screen = await mount(h(GuideGrid));

  try {
    const cell = [...screen.container.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.includes(", Fixture News, Now"),
    );

    expect(cell).toBeDefined();
    await act(async () => cell!.click());
    const href = ui.push.mock.calls.at(-1)?.[0] as string;
    const token = new URL(href, "https://fixture.test").searchParams.get("detail");
    expect(token).toBeTruthy();
    expect(await owner.programme(token!)).toEqual(programme);
  } finally {
    await screen.close();
    await owner.forget("source");
  }
});

it.each([
  ["none", [], null, "Guide unavailable"],
  ["available", [], null, "No programme information"],
  [
    "available",
    [{ start: 1, stop: 2, title: "Old", detail: "old" }],
    null,
    "Nothing in this window",
  ],
  ["available", [], "more", "More in Schedule"],
] as const)("maps %s rows to %s", async (availability, programmes, cursor, message) => {
  ui.status.availability = availability;
  ui.schedule.mockResolvedValue({ programmes, cursor });
  const screen = await mount(h(GuideGrid));

  try {
    expect(
      [...screen.container.querySelectorAll("section span")].some(
        (span) => span.textContent === message,
      ),
    ).toBe(true);
  } finally {
    await screen.close();
    ui.status.availability = "available";
  }
});

it.each(["stale", "unavailable"])("shows the %s guide banner", async (kind) => {
  ui.status.stale = kind === "stale";
  ui.status.availability = kind === "unavailable" ? "none" : "available";
  ui.schedule.mockResolvedValue({ programmes: [], cursor: null });
  const screen = await mount(h(GuideGrid));

  try {
    expect(screen.container.textContent).toContain(
      kind === "stale" ? "Guide may be out of date" : "Provider settings",
    );
  } finally {
    await screen.close();
    ui.status.stale = false;
    ui.status.availability = "available";
  }
});

it("uses an available external guide for an M3U row", async () => {
  const { guide } = await import("../src/guide/runtime.ts");

  const status = vi.spyOn(guide, "status").mockImplementation((id) => ({
    availability: id === "xml" ? "available" : "none",
    activity: "idle",
    fetchedAt: null,
    stale: false,
    error: null,
  }));

  ui.links = [{ id: "xml" }];
  ui.schedule.mockResolvedValue({ programmes: [], cursor: null });
  const screen = await mount(h(GuideGrid));

  try {
    expect(screen.container.textContent).toContain("No programme information");
    expect(screen.container.textContent).not.toContain("Guide unavailable");
  } finally {
    await screen.close();
    status.mockRestore();
    ui.links = [];
  }
});

it("keeps the page cursor on an empty refused second page", async () => {
  const now = Date.now();
  ui.schedule.mockImplementation(async (_key, _day, cursor) =>
    cursor
      ? { programmes: [], cursor: null }
      : {
          programmes: [{ start: now, stop: now + 3600000, title: "Retained", detail: "d" }],
          cursor: "next",
        },
  );
  const screen = await mount(h(GuideGrid));

  try {
    expect(screen.container.textContent).toContain("Retained");
    expect(screen.container.textContent).toContain("Couldn't update schedule");
    expect(screen.container.textContent).toContain("More in Schedule");
  } finally {
    await screen.close();
  }
});

it.each([
  { width: 900, fontScale: 1 },
  { width: 400, fontScale: 2 },
])("mounts accessible cells at $width dp and $fontScale text", async (dimensions) => {
  ui.dimensions = dimensions;
  const now = Date.now();
  ui.schedule.mockResolvedValue({
    programmes: [{ start: now, stop: now + 3600000, title: "Accessible", detail: "d" }],
    cursor: null,
  });
  const screen = await mount(h(GuideGrid));

  try {
    expect(screen.container.innerHTML).toContain(
      dimensions.fontScale === 2
        ? "&quot;flexDirection&quot;:&quot;column&quot;"
        : "&quot;width&quot;:168",
    );
    expect(
      [...screen.container.querySelectorAll("button")].some((b) =>
        b.getAttribute("aria-label")?.includes(", Accessible"),
      ),
    ).toBe(true);
  } finally {
    await screen.close();
    ui.dimensions = { width: 400, fontScale: 1 };
  }
});

it.each(["loading", "failed", "unknown"])(
  "distinguishes a %s catalogue from an empty day",
  async (kind) => {
    const { sources } = await import("../src/bootstrap/sources.ts");
    const { catalogueFailures } = await import("../src/guide/runtime.ts");

    if (kind !== "unknown")
      sources.state.set({
        kind: "ready",
        sources: [{ id: "pending", label: "Provider", kind: "m3u", channels: { kind: "loading" } }],
      });

    if (kind === "failed") catalogueFailures.set(new Set(["pending"]));
    ui.params.country = "Gone";
    const screen = await mount(h(GuideGrid));

    try {
      expect(screen.container.textContent).toContain(
        kind === "loading"
          ? "Some channels still loading…"
          : kind === "failed"
            ? "Couldn't load channels"
            : "Gone isn't listed any more.",
      );
      expect(screen.container.textContent).not.toContain("No programme information");

      if (kind === "failed") {
        await screen.click("Try again");
        expect(ui.retryChannels).toHaveBeenCalled();
      }
    } finally {
      await screen.close();
      ui.params.country = "";
      sources.state.set({ kind: "ready", sources: [] });
      catalogueFailures.set(new Set());
    }
  },
);

it("keeps an open tablet detail and its Back handler when folded to phone width", async () => {
  const { Beside } = await import("../src/guide/grid.tsx");
  const close = vi.fn();
  ui.dimensions = { width: 900, fontScale: 1 };

  const node = h(Beside, {
    detail: h("p", {}, "Selected programme"),
    onClose: close,
    children: h("p", {}, "Grid"),
  });

  const screen = await mount(node);

  try {
    expect(screen.container.textContent).toContain("Selected programme");
    ui.dimensions = { width: 400, fontScale: 1 };
    await screen.render(
      h(Beside, {
        detail: h("p", {}, "Selected programme"),
        onClose: close,
        children: h("p", {}, "Grid"),
      }),
    );
    expect(screen.container.textContent).toContain("Selected programme");
    expect(ui.accessibilityFocus).toHaveBeenCalledWith(expect.anything(), "focus");
    await screen.click("Back");
    expect(close).toHaveBeenCalledOnce();
    expect(ui.backHandler()).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    await screen.close();
    ui.dimensions = { width: 400, fontScale: 1 };
  }
});

it("retains a moved window on same-day remount but expires past pinned days", async () => {
  const at = new Date(2026, 9, 24, 12).getTime();
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  ui.schedule.mockResolvedValue({ programmes: [], cursor: null });
  const first = await mount(h(GuideGrid));
  await first.click("Later");
  await act(async () => ui.scroll(320));
  await first.close();
  const sameDay = await mount(h(GuideGrid), false);
  expect(sameDay.container.textContent).toContain("12:30");
  expect(ui.scrollToOffset).toHaveBeenLastCalledWith({ offset: 320, animated: false });
  await sameDay.close();
  clock.mockReturnValue(localDay(at, 1).from + 12 * 3600000);
  const second = await mount(h(GuideGrid), false);

  try {
    expect(ui.schedule.mock.calls.at(-1)?.[1]).toEqual(localDay(Date.now()));
  } finally {
    await second.click("Now");
    await second.close();
    clock.mockRestore();
  }
});

it("resets navigation context when the provider set changes", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  const at = new Date(2026, 9, 24, 12).getTime();
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  const screen = await mount(h(GuideGrid));

  try {
    await screen.click("Next day");
    await screen.click("Later");
    await act(async () => ui.scroll(480));
    await act(async () =>
      sources.state.set({
        kind: "ready",
        sources: [
          { id: "replacement", label: "Provider", kind: "m3u", channels: { kind: "loading" } },
        ],
      }),
    );
    await screen.click("Show visible");
    expect(ui.schedule.mock.calls.at(-1)?.[1]).toEqual(localDay(at));
    expect(screen.container.textContent).not.toContain("13:00");
    expect(ui.scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
  } finally {
    await screen.close();
    sources.state.set({ kind: "ready", sources: [] });
    clock.mockRestore();
  }
});

it("ignores a bound swipe while following now", async () => {
  vi.useFakeTimers();
  const at = new Date(2026, 9, 24, 0).getTime();
  vi.setSystemTime(at);
  const screen = await mount(h(GuideGrid));

  try {
    await act(async () => ui.swipe(80, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 3600000);
    });
    expect(screen.container.textContent).toContain("2:00");
  } finally {
    await screen.close();
    vi.useRealTimers();
  }
});
