import { mount, ui } from "./guide-grid-fixture.ts";
import { act, createElement as h } from "react";
import { expect, it, vi } from "vitest";
import { GuideSearchScreen } from "../src/guide/search.tsx";

it("caps current and future results at twenty, shows partial failure, and opens the detail token", async () => {
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
    unsearched: false,
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
    ui.dimensions = { width: 400, fontScale: 1 };
    await screen.render(h(GuideSearchScreen));
    await act(async () => {
      expect(ui.backHandler()).toBe(true);
    });
    expect(screen.container.querySelector("input")?.value).toBe("sports");
    expect(screen.container.textContent).toContain("sports");
    expect(ui.back).not.toHaveBeenCalled();
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
