import { mount, ui } from "./guide-grid-fixture.ts";
import { act, createElement as h } from "react";
import { expect, it, vi } from "vitest";
import { GuideGrid } from "../src/guide/grid.tsx";
import { setLanguage } from "@mrstreamer/core/i18n";
import { guideFixture } from "./guide-fixture.ts";
import { t } from "../src/guide/grid.tsx";
import { createGuide, localDay } from "../src/guide/guide.ts";

it("reads at most 24 visible channels and two pages, and opens Schedule without playing", async () => {
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
    await screen.click("Later");
    expect(screen.container.textContent).toContain("12:30");
    await act(async () => ui.swipe(-80, 5));
    expect(screen.container.textContent).toContain("13:00");
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

it("opens the detail token from a cell with a full channel, time and now label", async () => {
  const now = Date.now();
  ui.schedule.mockResolvedValue({
    programmes: [{ start: now - 60000, stop: now + 3600000, title: "News", detail: "token" }],
    cursor: null,
  });
  const screen = await mount(h(GuideGrid));

  try {
    const button = [...screen.container.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-label")?.includes(", News, Now"),
    );

    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(ui.push).toHaveBeenLastCalledWith(expect.stringContaining("detail=token"));
  } finally {
    await screen.close();
  }
});

it("shows guide browsing and search copy in Dutch and English", async () => {
  const keys = [
    "Guide",
    "Earlier",
    "Later",
    "Now",
    "More in Schedule",
    "Nothing in this window",
    "No programme information",
    "Search programmes",
    "Searching.",
    "Some programmes not searched.",
    "Guides",
    "Retry",
    "Couldn't update schedule",
  ] as const;

  try {
    setLanguage({ locale: "nl-NL", formats: "nl-NL" });

    for (const key of keys) expect(t(key)).not.toBe(key === "Later" ? "Eerder" : key);
    expect(t("Schedule for {channel}", { channel: "News" })).toBe("Uitzendschema voor News");
    expect(t('Nothing named "{query}"', { query: "news" })).toBe('Niets met de naam "news"');
    setLanguage({ locale: "en-US", formats: "en-US" });

    for (const key of keys) expect(t(key)).toBe(key);
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
    await screen.click("Retry");
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
