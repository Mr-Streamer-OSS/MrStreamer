import { mount, ui } from "./guide-grid-fixture.ts";
import { act, createElement as h } from "react";
import { expect, it, vi } from "vitest";
import { GuideSearchScreen } from "../src/guide/search.tsx";

it("caps current and future results at twenty, shows partial failure, and opens the detail token", async () => {
  ui.play.mockClear();
  const now = Date.now();
  ui.search.mockResolvedValue({
    unsearched: true,
    found: [
      {
        key: "source:0",
        programme: { start: now - 120000, stop: now - 1, title: "Ended", detail: "ended" },
      },
      ...Array.from({ length: 25 }, (_, i) => ({
        key: "source:0",
        programme: {
          start: now + (i - 1) * 60000,
          stop: now + 3600000,
          title: `News ${i}`,
          detail: `token${i}`,
        },
      })),
    ],
  });
  const screen = await mount(h(GuideSearchScreen));

  try {
    expect(screen.container.textContent).toContain("Some programmes not searched.");

    const results = [...screen.container.querySelectorAll("button")].filter((b) =>
      b.getAttribute("aria-label")?.startsWith("News"),
    );

    expect(results).toHaveLength(20);
    expect(screen.container.textContent).not.toContain("Ended");
    await screen.click(results[0]!.getAttribute("aria-label")!);
    expect(ui.push).toHaveBeenLastCalledWith(expect.stringContaining("detail=token0"));
    expect(ui.play).not.toHaveBeenCalled();
    await screen.click("Guides");
    expect(ui.push).toHaveBeenLastCalledWith("/guide/guides");
    expect(screen.container.querySelector("input")?.value).toBe("news");
    ui.search.mockResolvedValue({ unsearched: false, found: [] });
    await screen.click("Retry");
    expect(screen.container.textContent).toContain('Nothing named "news"');
  } finally {
    await screen.close();
  }
});

it("retains same-query results after an incomplete replacement, and never claims no matches", async () => {
  const now = Date.now();
  ui.search.mockResolvedValue({
    unsearched: true,
    found: [
      {
        key: "source:0",
        programme: { start: now, stop: now + 3600000, title: "Keep", detail: "d" },
      },
    ],
  });
  const screen = await mount(h(GuideSearchScreen));

  try {
    ui.search.mockResolvedValue({ unsearched: true, found: [] });
    await screen.click("Retry");
    expect(screen.container.textContent).toContain("Keep");
    expect(screen.container.textContent).not.toContain("Nothing named");
  } finally {
    await screen.close();
  }
});

it("keeps fast edits locally and returns from tablet details to the changed query", async () => {
  ui.dimensions = { width: 900, fontScale: 1 };
  const now = Date.now();
  ui.search.mockImplementation(async (query) => ({
    unsearched: true,
    found: [
      {
        key: "source:0",
        programme: { start: now, stop: now + 3600000, title: query, detail: "d" },
      },
    ],
  }));
  const screen = await mount(h(GuideSearchScreen));

  try {
    await act(async () => {
      ui.input("sport");
      ui.input("sports");
    });
    expect(ui.params.query).toBe("sports");
    expect(screen.container.querySelector("input")?.value).toBe("sports");
    await screen.click(
      [...screen.container.querySelectorAll("button")]
        .find((b) => b.getAttribute("aria-label")?.startsWith("sports,"))!
        .getAttribute("aria-label")!,
    );
    expect(screen.container.textContent).toContain("Programme unavailable");
    await screen.click("Retry");
    expect(
      screen.container.querySelector('[aria-selected="true"]')?.getAttribute("aria-label"),
    ).toContain("sports,");
    await screen.click("Back");
    expect(screen.container.textContent).not.toContain("Programme unavailable");
    expect(screen.container.querySelector("input")?.value).toBe("sports");
    expect(screen.container.textContent).toContain("sports");
    expect(ui.back).not.toHaveBeenCalled();
    await screen.click("Back");
    expect(ui.back).toHaveBeenCalledOnce();
  } finally {
    await screen.close();
    ui.params.query = "news";
    ui.dimensions = { width: 400, fontScale: 1 };
  }
});

it("refills the search when a shown programme ends", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  ui.search.mockResolvedValue({
    unsearched: false,
    found: [
      {
        key: "source:0",
        programme: { start: now, stop: now + 1000, title: "Ending", detail: "e" },
      },
    ],
  });
  const screen = await mount(h(GuideSearchScreen));

  try {
    const calls = ui.search.mock.calls.length;
    ui.search.mockResolvedValue({ unsearched: false, found: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(ui.search.mock.calls.length).toBeGreaterThan(calls);
    expect(screen.container.textContent).not.toContain("Ending");
  } finally {
    await screen.close();
    vi.useRealTimers();
  }
});

it("merges fresh partial results, replaces matching identities and drops ended or removed channels", async () => {
  vi.useFakeTimers();
  const now = Date.now();

  const old = {
    key: "source:0",
    programme: { start: now, stop: now + 1000, title: "Old", detail: "d" },
  };

  const removed = {
    key: "source:1",
    programme: { start: now, stop: now + 10000, title: "Removed", detail: "r" },
  };

  ui.search.mockResolvedValue({ unsearched: true, found: [old, removed] });
  const screen = await mount(h(GuideSearchScreen));
  const { guide } = await import("../src/guide/runtime.ts");
  const channels = guide.channels();

  const available = vi
    .spyOn(guide, "channels")
    .mockReturnValue(new Map([["source", channels.get("source")!.filter((c) => c.id !== "1")]]));

  try {
    ui.search.mockResolvedValue({
      unsearched: true,
      found: [
        { ...old, programme: { ...old.programme, title: "Updated" } },
        {
          key: "source:0",
          programme: { start: now + 1000, stop: now + 10000, title: "Fresh", detail: "f" },
        },
      ],
    });
    await screen.click("Retry");
    expect(screen.container.textContent).toContain("Updated");
    expect(screen.container.textContent).toContain("Fresh");
    expect(screen.container.textContent).not.toContain("Old");
    expect(screen.container.textContent).not.toContain("Removed");
    ui.search.mockResolvedValue({
      unsearched: true,
      found: [
        {
          key: "source:0",
          programme: { start: now + 2000, stop: now + 20000, title: "Refill", detail: "n" },
        },
      ],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(screen.container.textContent).not.toContain("Updated");
    expect(screen.container.textContent).toContain("Fresh");
    expect(screen.container.textContent).toContain("Refill");
  } finally {
    await screen.close();
    available.mockRestore();
    vi.useRealTimers();
  }
});

it("searches ready channels while another provider is pending without claiming no matches", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  sources.state.set({
    kind: "ready",
    sources: [
      { id: "source", label: "Ready", kind: "m3u", channels: { kind: "loading" } },
      { id: "pending", label: "Pending", kind: "m3u", channels: { kind: "loading" } },
    ],
  });
  ui.search.mockClear().mockResolvedValue({ unsearched: false, found: [] });
  const screen = await mount(h(GuideSearchScreen));

  try {
    expect(ui.search).toHaveBeenCalledWith(
      "news",
      expect.arrayContaining(["source:0"]),
      expect.anything(),
    );
    expect(screen.container.textContent).toContain("Some channels still loading…");
    expect(screen.container.textContent).not.toContain("Nothing named");
    const { GuideGrid } = await import("../src/guide/grid.tsx");
    const grid = await mount(h(GuideGrid));

    try {
      expect(grid.container.textContent).toContain("Channel 0");
      expect(grid.container.textContent).toContain("Some channels still loading…");
      expect(grid.container.textContent).not.toContain("Loading channels…");
    } finally {
      await grid.close();
    }
  } finally {
    await screen.close();
    sources.state.set({ kind: "ready", sources: [] });
  }
});

it("pauses timed refills under a pushed screen and refills on return", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  ui.search.mockResolvedValue({
    unsearched: false,
    found: [
      {
        key: "source:0",
        programme: { start: now, stop: now + 1000, title: "Ending", detail: "e" },
      },
    ],
  });
  const screen = await mount(h(GuideSearchScreen));

  try {
    ui.focused = false;
    await screen.render(h(GuideSearchScreen));
    const calls = ui.search.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(ui.search).toHaveBeenCalledTimes(calls);
    ui.search.mockResolvedValue({ unsearched: false, found: [] });
    ui.focused = true;
    await screen.render(h(GuideSearchScreen));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(ui.search.mock.calls.length).toBeGreaterThan(calls);
  } finally {
    await screen.close();
    ui.focused = true;
    vi.useRealTimers();
  }
});

it("orders unsorted results now first and labels a future day", async () => {
  const now = Date.now();

  const found = [
    {
      key: "source:0",
      programme: {
        start: now + 86400000,
        stop: now + 90000000,
        title: "Future show",
        detail: "t",
      },
    },
    {
      key: "source:0",
      programme: { start: now + 60000, stop: now + 3600000, title: "Soon", detail: "s" },
    },
    {
      key: "source:0",
      programme: { start: now - 60000, stop: now + 60000, title: "Current", detail: "c" },
    },
  ];

  ui.search.mockResolvedValue({ unsearched: false, found });
  const screen = await mount(h(GuideSearchScreen));

  try {
    const labels = [...screen.container.querySelectorAll("button")].flatMap((b) => {
      const label = b.getAttribute("aria-label");

      return label?.includes(",") ? [label] : [];
    });

    expect(labels.map((l) => l?.split(",")[0])).toEqual(["Current", "Soon", "Future show"]);
    expect(labels[2]).toContain("Tomorrow");
  } finally {
    await screen.close();
  }
});

it("ignores an older response after a newer query", async () => {
  const now = Date.now();

  type Result = {
    unsearched: boolean;
    found: {
      key: string;
      programme: { start: number; stop: number; title: string; detail: string };
    }[];
  };

  let finish!: (result: Result) => void;
  ui.search.mockImplementationOnce(
    () =>
      new Promise<Result>((resolve) => {
        finish = resolve;
      }),
  );
  const screen = await mount(h(GuideSearchScreen));

  try {
    ui.search.mockResolvedValue({
      unsearched: false,
      found: [
        {
          key: "source:0",
          programme: { start: now, stop: now + 3600000, title: "New result", detail: "new" },
        },
      ],
    });
    await act(async () => ui.input("new"));
    expect(screen.container.textContent).toContain("New result");
    await act(async () => finish({ unsearched: false, found: [] }));
    expect(screen.container.textContent).toContain("New result");
  } finally {
    await screen.close();
    ui.params.query = "news";
  }
});
