import type { FakeProvider } from "../../../../apps/desktop/test/fake-provider.ts";
import { addBackup } from "./custom-lists.ts";
import type { Driver } from "./language.ts";

const named = (text: string, selector = "header button") =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const posters = "document.querySelectorAll('[role=listitem][data-index] button[title]')";

/** A cold page must finish before the held provider, whose existing fetch must still land later. */
export async function slowCatalogueScenario(
  d: Driver,
  slow: FakeProvider,
  healthy: FakeProvider,
  releaseSlow: () => void,
) {
  const held = healthy.hold("titles");
  try {
    await addBackup(d, healthy.url);
    await held.arrived;
    await d.click("Open cold Movies while both providers wait", named("Movies"));
    await d.wait(() =>
      d.evaluate<boolean>(`${named("Movies")}.getAttribute('aria-current') === 'page'`),
    );
    held.release();
    await d.click("Open All movies", named("All movies", "nav button"));
    await d.wait(() => d.evaluate<boolean>(`${posters}.length > 0`));
    d.observed["moviesBeforeSlowRelease"] = true;
    for (const width of [1280, 960]) {
      await d.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const tab of ["Movies", "Series"]) {
        await d.click(`Open ${tab} at ${width}`, named(tab));
        await d.click(
          `Open All ${tab.toLowerCase()}`,
          named(`All ${tab.toLowerCase()}`, "nav button"),
        );
        await d.wait(() => d.evaluate<boolean>(`${posters}.length > 0`));
        await d.wait(() =>
          d.evaluate<boolean>(`${named(tab)}.getAttribute('aria-current') === 'page'`),
        );
        await d.capture(`held-${tab.toLowerCase()}-${width}`);
        if (tab === "Movies") {
          await d.click(
            "Search healthy titles while the other provider waits",
            "document.querySelector('input[aria-label=\"Search movies\"]')",
          );
          await d.send("Input.insertText", { text: "Story" });
          await d.wait(() =>
            d.evaluate<boolean>(
              "[...document.querySelectorAll('[role=listitem][data-index] button[title]')].some(b => b.getAttribute('title')?.includes('Story'))",
            ),
          );
          await d.key("ArrowDown", 40);
          await d.wait(() =>
            d.evaluate<boolean>(
              "!!document.activeElement?.closest('[role=listitem][data-index]') && document.activeElement.getAttribute('title')?.toLowerCase().includes('story')",
            ),
          );
          d.observed[`localSearch-${width}`] = await d.evaluate(
            `({query: document.querySelector('input[aria-label="Search movies"]').value, focused: document.activeElement.getAttribute('title'), rendered: ${posters}.length})`,
          );
          await d.capture(`held-search-keyboard-${width}`);
          await d.click(
            "Clear the query",
            "document.querySelector('input[aria-label=\"Search movies\"]')",
          );
          await d.key("Escape", 27);
        }
      }
      await d.click(`Open Home at ${width}`, named("Home"));
      await d.wait(() =>
        d.evaluate<boolean>("document.querySelectorAll('[data-home-row] button').length > 0"),
      );
      await d.capture(`held-home-${width}`);
      await d.click(
        "Open global Search while the slow provider waits",
        "document.querySelector('button[aria-label=Search]')",
      );
      await d.send("Input.insertText", { text: "Other Story" });
      await d.wait(() =>
        d.evaluate<boolean>(
          `document.querySelectorAll('[aria-label="Search results"] button[role=treeitem]').length > 1 && document.querySelector('[aria-label="Search results"]')?.getAttribute('aria-disabled') === 'false'`,
        ),
      );
      await d.key("ArrowDown", 40);
      await d.wait(() =>
        d.evaluate<boolean>(
          `document.querySelector('[aria-label="Search results"] [data-index="1"]')?.getAttribute('aria-selected') === 'true'`,
        ),
      );
      d.observed[`globalSearch-${width}`] = await d.evaluate(
        `({query: document.querySelector('input[role=combobox]').value, selected: document.querySelector('[aria-label="Search results"] [aria-selected=true]')?.textContent, rendered: document.querySelectorAll('[aria-label="Search results"] button[role=treeitem]').length})`,
      );
      await d.capture(`held-global-search-${width}`);
      await d.key("Escape", 27);
    }
    d.observed["heldRequests"] = {
      slow: slow.titleListRequests(),
      healthy: healthy.titleListRequests(),
    };
    releaseSlow();
    const loaded = () =>
      d.evaluate<boolean>(`(async () => {
      const result = await window.mrStreamer.invoke('ondemand.status');
      return result.ok && result.value.lists.length === 2 && result.value.lists.every(row => row.fetchedAt !== null);
    })()`);
    await d.wait(loaded);
    if (slow.titleListRequests() !== 4 || healthy.titleListRequests() !== 4)
      throw new Error("A catalogue requested its lists more than once.");
    d.observed["lateProviderJoined"] = true;
    await d.quit();
    slow.failTitles(503);
    healthy.failTitles(503);
    await d.launch();
    await d.wait(loaded);
    await d.click("Open warm Movies with both providers failing", named("Movies"));
    await d.click("Open cached All movies", named("All movies", "nav button"));
    await d.wait(() => d.evaluate<boolean>(`${posters}.length > 0`));
    await d.capture("warm-offline-movies");
    d.observed["warmRequests"] = {
      slow: slow.titleListRequests(),
      healthy: healthy.titleListRequests(),
    };
    if (slow.titleListRequests() !== 4 || healthy.titleListRequests() !== 4)
      throw new Error("Warm catalogue unexpectedly fetched fresh lists.");
  } finally {
    held.release();
    releaseSlow();
  }
}
