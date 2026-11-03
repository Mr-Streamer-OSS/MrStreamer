import { mount, ui } from "./guide-grid-fixture.ts";
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { GuideSearchScreen } from "../src/guide/search.tsx";

it("caps current and future results at twenty, shows partial failure, and opens the detail token", async () => {
  const now = Date.now();
  ui.search.mockResolvedValue({
    unsearched: true,
    found: Array.from({ length: 25 }, (_, i) => ({
      key: "source:0",
      programme: {
        start: now + (i - 1) * 60000,
        stop: now + 3600000,
        title: `News ${i}`,
        detail: `token${i}`,
      },
    })),
  });
  const screen = await mount(h(GuideSearchScreen));

  try {
    expect(screen.container.textContent).toContain("Some programmes not searched.");

    const results = [...screen.container.querySelectorAll("button")].filter((b) =>
      b.getAttribute("aria-label")?.startsWith("News"),
    );

    expect(results).toHaveLength(20);
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
