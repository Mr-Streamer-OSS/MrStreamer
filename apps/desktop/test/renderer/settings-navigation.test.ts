// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultPreferences,
  defaultSubscriptionPreferences,
} from "@mrstreamer/contracts/preferences";
import { setLanguage } from "@mrstreamer/core/i18n";
import { acceptPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { openOnlineSubtitleSettings, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { SettingsPage } from "../../src/renderer/src/features/settings/SettingsPage.tsx";
import { LiveSettingsSection } from "../../src/renderer/src/features/settings/GeneralSection.tsx";
import { findSettings } from "../../src/renderer/src/features/settings/catalogue.ts";

let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  useUi.setState({ settings: "general", settingsTarget: null, onlineSubtitles: false });
  vi.stubGlobal("__BUILD_COMMIT__", "abcdef");
  ipc.always("language.get", {
    choice: "system",
    locale: "en-US",
    system: "en-US",
    formats: "en-US",
  });
});
afterEach(() => {
  cleanup();
  setLanguage({ locale: "en-US", formats: "en-US" });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));
async function render(component = createElement(SettingsPage)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = document.createElement("div");
  document.body.append(view);
  const root = createRoot(view);
  await act(async () => root.render(createElement(QueryClientProvider, { client }, component)));
  await settle();
  cleanup = () => {
    act(() => root.unmount());
    client.clear();
    view.remove();
  };
  return { view, client };
}
async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function nav(view: HTMLElement, label: string) {
  await act(async () =>
    [...view.querySelectorAll<HTMLButtonElement>("nav button")]
      .find((b) => b.textContent === label)!
      .click(),
  );
  await settle();
}

it.each([
  ["en-US", "countdown"],
  ["nl-NL", "aftellen"],
  ["fr-FR", "compte à rebours"],
  ["de-DE", "Sekunden"],
  ["es-ES", "cuenta atras"],
] as const)("finds the delay through a translated synonym in %s", (locale, word) => {
  setLanguage({ locale, formats: locale });
  expect(findSettings(word).some((control) => control.id === "delay")).toBe(true);
});

it("search focuses the real control, preserves an independent draft and recovers from no results", async () => {
  const { view, client } = await render();
  const search = view.querySelector<HTMLInputElement>('[aria-label="Find a setting"]')!;
  await type(search, "countdown");
  await act(async () =>
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  await settle();
  const delay = view.querySelector<HTMLInputElement>('[aria-label="Next episode delay"]')!;
  expect(document.activeElement).toBe(delay);
  await type(delay, "43");
  await act(async () =>
    acceptPreferences(client, ipc.snapshot({ ...defaultPreferences, audioLanguage: "fr" })),
  );
  await settle();
  expect(delay.value).toBe("43");
  await nav(view, "Movies and series");
  const ownKey = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Own key…",
  )!;
  await act(async () => ownKey.click());
  const key = view.querySelector<HTMLInputElement>('[aria-label="Your own TMDB key"]')!;
  await type(key, "draft-key");
  await nav(view, "Playback");
  await nav(view, "Movies and series");
  expect(key.value).toBe("draft-key");
  await type(search, "zzzz-no-setting");
  expect(view.textContent).toContain("No settings found");
  await act(async () =>
    [...view.querySelectorAll<HTMLButtonElement>("nav button")]
      .find((b) => b.textContent === "Clear search")!
      .click(),
  );
  expect(search.value).toBe("");
  expect(document.activeElement).toBe(search);
});

it("keeps the online subtitles opener as a focused destination", async () => {
  ipc.always("subtitles.settings", {
    enabled: false,
    service: "both",
    languages: ["en"],
    configured: { subdl: false, opensubtitles: false },
  });
  openOnlineSubtitleSettings();
  const { view } = await render();
  expect(useUi.getState().settings).toBe("subtitles");
  expect(document.activeElement).toBe(view.querySelector('[aria-label="Online subtitle search"]'));
  expect(useUi.getState().onlineSubtitles).toBe(false);
});

it("keeps acknowledged quality after a failed reset and retries only at that row", async () => {
  ipc.always("subscription.list", [SAVED]);
  ipc.always("subscription.preferences", {
    ...defaultSubscriptionPreferences,
    channelVariants: { a: "hd" },
  });
  const failed = ipc.hold("subscription.updatePreferences");
  const { view } = await render(createElement(LiveSettingsSection));
  const reset = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Reset",
  )!;
  await act(async () => reset.click());
  await settle();
  await act(async () => failed.reject({ kind: "unexpected", detail: "reset failed" }));
  await settle();
  expect(view.textContent).toContain("reset failed");
  expect(view.querySelector('[data-setting="own-quality"]')?.textContent).toContain("1");
  ipc.always("subscription.updatePreferences", defaultSubscriptionPreferences);
  await act(async () =>
    [...view.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Try again")!
      .click(),
  );
  await settle();
  expect(ipc.argsOf("subscription.updatePreferences")).toEqual(
    Array.from({ length: 2 }, () => ({
      subscriptionId: SUBSCRIPTION,
      patch: { channelVariants: {} },
    })),
  );
  expect(view.textContent).not.toContain("reset failed");
});

it("shows a preference read failure and recovers through Retry", async () => {
  ipc.refuse("preferences.get", { kind: "unexpected", detail: "read failed" });
  const { view } = await render();
  expect(view.textContent).toContain("Settings could not be read.");
  ipc.always("preferences.get", ipc.snapshot(defaultPreferences));
  await act(async () =>
    [...view.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Try again")!
      .click(),
  );
  await settle();
  expect(view.textContent).not.toContain("Settings could not be read.");
});

it("keeps delay editing keys inside the field and clamps typed whole seconds", async () => {
  const { view } = await render();
  await nav(view, "Playback");
  const delay = view.querySelector<HTMLInputElement>('[aria-label="Next episode delay"]')!;
  const press = async (key: string, shiftKey = false) => {
    await act(async () =>
      delay.dispatchEvent(
        new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }),
      ),
    );
  };
  await type(delay, "10");
  await press("ArrowUp", true);
  expect(delay.value).toBe("15");
  await press("ArrowDown");
  expect(delay.value).toBe("14");
  await press("End");
  expect(delay.value).toBe("60");
  await press("Home");
  expect(delay.value).toBe("0");
  await press("Escape");
  expect(delay.value).toBe("10");
  expect(useUi.getState().settings).toBe("playback");
  expect(ipc.argsOf("preferences.update")).toHaveLength(0);
  const save = ipc.hold("preferences.update");
  await type(delay, "999");
  await press("Enter");
  expect(ipc.argsOf("preferences.update")).toEqual([{ nextEpisodeDelaySeconds: 60 }]);
  await act(async () =>
    save.resolve(ipc.snapshot({ ...defaultPreferences, nextEpisodeDelaySeconds: 60 })),
  );
  await settle();
  expect(delay.value).toBe("60");
});

it("the metadata progress opener focuses the TMDB control", async () => {
  ipc.always("ondemand.status", {
    lists: [],
    metadata: { known: 2, wanted: 10, refused: false, fetching: true },
  });
  const { view } = await render();
  await act(async () =>
    view.querySelector<HTMLButtonElement>('button[aria-label^="TMDB ·"]')!.click(),
  );
  await settle();
  expect(useUi.getState().settings).toBe("movies");
  expect(document.activeElement?.closest("[data-setting]")?.getAttribute("data-setting")).toBe(
    "tmdb",
  );
});

it("returns focus to the visible player when the original opener has gone", async () => {
  const opener = document.createElement("button");
  const player = document.createElement("div");
  player.dataset["view"] = "title";
  player.tabIndex = -1;
  document.body.append(opener, player);
  opener.focus();
  await render();
  opener.remove();
  await act(async () => useUi.setState({ settings: null }));
  await settle();
  expect(document.activeElement).toBe(player);
  player.remove();
});
