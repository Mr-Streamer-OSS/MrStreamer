// @vitest-environment happy-dom
import { ipc, SAVED } from "./support.ts";
import { browseResult } from "./browse-support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { t } from "@mrstreamer/core/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActiveProfile, LocalProfile } from "@mrstreamer/contracts/profiles";
import type { InterfaceLanguage } from "@mrstreamer/contracts/language";
import type { OutputStatus } from "@mrstreamer/contracts/output";
import type { DownloadList } from "@mrstreamer/contracts/downloads";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import {
  call,
  callForProfile,
  selectProfileOwner,
  profileOwner,
} from "../../src/renderer/src/lib/ipc.ts";
import {
  acceptPreferences,
  currentPreferences,
  syncPreferences,
} from "../../src/renderer/src/lib/preferences.ts";
import { keepViewing, queries, rosterOf } from "../../src/renderer/src/lib/queries.ts";
import { downloadsQuery, syncDownloads } from "../../src/renderer/src/lib/downloads.ts";
import { outputs } from "../../src/renderer/src/player/output.ts";
import {
  applyLanguage,
  changeLanguage,
  loadLanguage,
} from "../../src/renderer/src/app/language.ts";
import {
  createProfile,
  removeProfile,
  profileListQuery,
  profileStatus,
  switchProfile,
  syncProfiles,
} from "../../src/renderer/src/features/profiles/profiles.ts";
import { ProfileMenu } from "../../src/renderer/src/features/profiles/ProfileMenu.tsx";
import { App } from "../../src/renderer/src/app/App.tsx";
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip.tsx";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";

const A: ActiveProfile = { id: "default", revision: 1 };
const B: ActiveProfile = { id: "b", revision: 2 };
const AGAIN: ActiveProfile = { id: "default", revision: 3 };

const english: InterfaceLanguage = {
  choice: "system",
  system: "en-US",
  locale: "en-US",
  formats: "en-US",
};

const dutch: InterfaceLanguage = {
  choice: "nl-NL",
  system: "en-US",
  locale: "nl-NL",
  formats: "nl-NL",
};

const german: InterfaceLanguage = {
  choice: "de-DE",
  system: "en-US",
  locale: "de-DE",
  formats: "de-DE",
};

const local = (owner: ActiveProfile): OutputStatus => ({
  owner,
  offers: [],
  airplayRoutes: null,
  scanning: false,
  receivers: [],
  output: { kind: "local" },
});

const viewing = (sequence: number) => ({
  sequence,
  favourites: [],
  recent: [],
  continueWatching: [],
  marked: [],
});

let client: QueryClient;
let stop = () => {};

beforeEach(() => {
  ipc.reset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  applyLanguage(english);
});

afterEach(() => {
  stop();
  stop = () => {};

  titlePlayer.close();
  player.reset();
  client.clear();
  vi.restoreAllMocks();
  applyLanguage(english);
});

it("refuses an old read and a deferred command after switching away and back to the same source IDs", async () => {
  selectProfileOwner(A);
  const held = ipc.hold("viewing.get");
  const pending = call("viewing.get");

  const refused = expect(pending).rejects.toMatchObject({
    error: { kind: "unexpected", detail: "Viewing profile changed. Try again." },
  });

  selectProfileOwner(B);
  selectProfileOwner(AGAIN);
  held.resolve(viewing(999));
  await refused;
  await expect(
    callForProfile(A, "viewing.setFavourite", {
      commandId: "same-command",
      channel: { subscriptionId: SAVED.id, id: "same" },
      favourite: true,
    }),
  ).rejects.toMatchObject({
    error: { kind: "unexpected", detail: "Viewing profile changed. Try again." },
  });
  expect(ipc.argsOf("viewing.setFavourite")).toEqual([]);
  ipc.always("viewing.get", viewing(3));
  expect(await call("viewing.get")).toEqual(viewing(3));
});

it("keeps settled old viewing and preferences replies out of the new viewer's cache", async () => {
  selectProfileOwner(A);
  ipc.always("viewing.get", viewing(999));
  const oldViewing = await call("viewing.get");
  const oldPreferences = await call("preferences.get");
  selectProfileOwner(B);
  selectProfileOwner(AGAIN);
  client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
  const latest = viewing(3);
  client.setQueryData(queries.viewing().queryKey, latest);
  keepViewing(client, oldViewing, rosterOf(client));
  expect(client.getQueryData(queries.viewing().queryKey)).toEqual(latest);
  expect(() => acceptPreferences(client, oldPreferences)).toThrow("Viewing profile changed");
  stop = syncPreferences(client, () => {});
  ipc.emit("profiles.preferencesChanged", {
    owner: A,
    snapshot: { revision: 999, preferences: { ...defaultPreferences, volume: 0.1 } },
  });
  expect(currentPreferences(client)).toBeUndefined();
  ipc.emit("preferences.changed", { revision: 999, preferences: defaultPreferences });
  expect(currentPreferences(client)).toBeUndefined();
  ipc.emit("profiles.preferencesChanged", {
    owner: AGAIN,
    snapshot: { revision: 1, preferences: { ...defaultPreferences, volume: 0.7 } },
  });
  expect(currentPreferences(client)?.volume).toBe(0.7);
});

it("accepts download progress and output events only from the current revision, including away and back", () => {
  selectProfileOwner(A);
  selectProfileOwner(B);
  selectProfileOwner(AGAIN);
  stop = syncDownloads(client);

  const current: DownloadList = {
    profile: AGAIN,
    items: [],
    series: {},
    bytes: 30,
    free: 70,
    ended: 0,
  };

  ipc.emit("downloads.changed", current);
  ipc.emit("downloads.changed", { ...current, profile: A, bytes: 999 });
  ipc.emit("downloads.changed", { items: [], series: {}, bytes: 888, free: 70, ended: 0 });
  expect(client.getQueryData(downloadsQuery().queryKey)).toEqual(current);
  outputs.clearForProfile(AGAIN);
  ipc.emit("output.changed", { ...local(A), scanning: true });
  ipc.emit("output.changed", {
    offers: [],
    airplayRoutes: null,
    scanning: true,
    receivers: [],
    output: { kind: "local" },
  });
  expect(outputs.status().scanning).toBe(false);
  ipc.emit("output.changed", { ...local(AGAIN), scanning: true });
  expect(outputs.status().scanning).toBe(true);
});

it.each(["read", "save"] as const)(
  "discards an old language %s in the promise-to-application window",
  async (operation) => {
    selectProfileOwner(A);
    const held = operation === "read" ? ipc.hold("language.get") : ipc.hold("language.set");
    const task = operation === "read" ? loadLanguage(client) : changeLanguage(client, "de-DE");
    const result = Promise.allSettled([task]);
    // IPC receives its valid answer first; ownership changes before its caller applies that answer.
    held.resolve(german);
    queueMicrotask(() => {
      selectProfileOwner(B);
      selectProfileOwner(AGAIN);
      client.setQueryData(queries.language().queryKey, dutch);
      applyLanguage(dutch);
    });
    await result;
    expect(document.documentElement.lang).toBe("nl-NL");
    expect(client.getQueryData(queries.language().queryKey)).toEqual(dutch);
    ipc.always("language.get", german);
    ipc.always("language.set", german);

    if (operation === "read") await loadLanguage(client);
    else await changeLanguage(client, "de-DE");
    expect(document.documentElement.lang).toBe("de-DE");
  },
);

it("leaves the background-Quit view intact and reports a refused switch reload until retry succeeds", async () => {
  useUi.setState({ ...useUi.getInitialState(), view: "downloads" }, true);
  ipc.always("output.status", local(A));
  stop = syncProfiles(client);
  await vi.waitFor(() =>
    expect(profileStatus()).toMatchObject({ owner: A, pending: false, error: null }),
  );
  expect(useUi.getState().view).toBe("downloads");
  ipc.always("profiles.switch", B);
  ipc.always("output.status", local(B));
  ipc.refuse("language.get", { kind: "unexpected", detail: "Profile language read refused." });
  await expect(switchProfile(client, B.id)).rejects.toMatchObject({
    error: { kind: "unexpected", detail: "Profile language read refused." },
  });
  expect(profileOwner()).toEqual(B);
  expect(profileStatus()).toMatchObject({ owner: B, pending: false });
  expect(profileStatus().error).not.toBeNull();
  ipc.always("language.get", dutch);
  ipc.emit("profiles.activeChanged", B);
  await vi.waitFor(() =>
    expect(profileStatus()).toMatchObject({ owner: B, pending: false, error: null }),
  );
  expect(document.documentElement.lang).toBe("nl-NL");
});

it("keeps profile lifecycle mutations at the public owner-bearing contract", async () => {
  selectProfileOwner(A);
  ipc.always("profiles.list", [{ ...A, name: "Default", deleting: false }]);
  expect(await client.fetchQuery(profileListQuery())).toHaveLength(1);
  ipc.always("profiles.create", { id: B.id, name: "B", deleting: false });
  await createProfile(client, "B");
  expect(ipc.argsOf("profiles.create")).toEqual([{ name: "B", current: A }]);
  ipc.always("profiles.remove", null);
  await removeProfile(client, B.id);
  expect(ipc.argsOf("profiles.remove")).toEqual([{ id: B.id, current: A }]);
});

it("refuses a profile switch when the current copy's progress cannot be saved", async () => {
  selectProfileOwner(A);
  outputs.clearForProfile(A);
  ipc.always("playback.openCopy", {
    owner: A,
    sessionId: "copy-session",
    copy: "same-copy",
    url: "http://127.0.0.1/title/copy.mp4",
    duration: 100,
    audio: [],
    subtitles: [],
    progress: { position: 35, duration: 100 },
  });
  void titlePlayer.open(
    {
      kind: "copy",
      copy: "same-copy",
      title: { kind: "movie", id: "same-movie" },
      name: "Copy",
      detail: null,
      artworkUrl: null,
      originalLanguage: null,
    },
    0,
  );
  await vi.waitFor(() =>
    expect(titlePlayer.state()).toMatchObject({ position: 30, duration: 100 }),
  );
  ipc.refuse("downloads.recordProgress", { kind: "unexpected", detail: "Save refused." });
  ipc.always("profiles.switch", B);
  ipc.always("output.status", local(B));
  await expect(switchProfile(client, B.id)).rejects.toMatchObject({
    error: { kind: "unexpected", detail: "Playback could not be saved. Try again." },
  });
  expect(ipc.argsOf("profiles.switch")).toEqual([]);
  expect(profileOwner()).toEqual(A);
  expect(titlePlayer.state().now).toMatchObject({ kind: "copy", copy: "same-copy" });
  expect(ipc.argsOf("downloads.recordProgress")).toEqual([
    { owner: A, id: "same-copy", position: 30, duration: 100 },
  ]);
  ipc.always("downloads.recordProgress", null);
  titlePlayer.close();
  await titlePlayer.saved();
});

/** The profile menu's controls, found as a person finds them: by name, in the open popup. */
function menu() {
  const named = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name,
    );

  const press = (name: string) =>
    act(async () => {
      const button = named(name);

      if (!button) throw new Error(`Missing button: ${name}`);
      button.click();
    });

  return {
    named,
    press,
    rows: () =>
      [...document.querySelectorAll<HTMLLIElement>("[role=dialog] li")].map((row) => ({
        text: row.textContent,
        current: row.getAttribute("aria-current") === "true",
      })),
    alert: () => document.querySelector("[role=dialog] [role=alert]")?.textContent ?? null,
    type: (text: string) =>
      act(async () => {
        const field = document.querySelector<HTMLInputElement>("[role=dialog] input")!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          field,
          text,
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }),
  };
}

async function openMenu() {
  ipc.always("output.status", local(A));
  stop = syncProfiles(client);
  await vi.waitFor(() =>
    expect(profileStatus()).toMatchObject({ owner: A, pending: false, error: null }),
  );
  const view = queryView(client);
  unmount = view.unmount;
  await view.render(createElement(ProfileMenu));
  await vi.waitFor(() =>
    expect(menu().named(t("Profile: {name}", { name: t("Default") }))).toBeDefined(),
  );
  await menu().press(t("Profile: {name}", { name: t("Default") }));
}

let unmount = () => {};

afterEach(() => {
  unmount();
  unmount = () => {};
});

it("creates a profile and keeps a refused deletion listed with Retry until it succeeds", async () => {
  let rows: LocalProfile[] = [
    { id: A.id, name: "Default", deleting: false },
    { id: "sam", name: "Sam", deleting: false },
  ];

  ipc.answer("profiles.list", () => rows);
  await openMenu();
  const ui = menu();
  // A row's text is its avatar's initial, then its name and state.
  await vi.waitFor(() =>
    expect(ui.rows()).toEqual([
      { text: "D" + "Default", current: true },
      { text: "S" + "Sam", current: false },
    ]),
  );
  // Default and the active profile can't be deleted.
  expect(ui.named("Delete Default")).toBeUndefined();

  ipc.answer("profiles.create", ({ name }) => {
    const made = { id: "mila", name, deleting: false };
    rows = [...rows, made];

    return made;
  });
  await ui.press("New profile");
  await ui.type("  Mila ");
  await ui.press("Add");
  await vi.waitFor(() => expect(ui.rows().map((row) => row.text)).toContain("MMila"));
  expect(ipc.argsOf("profiles.create")).toEqual([{ name: "Mila", current: A }]);
  expect(document.querySelector("[role=dialog] input")).toBeNull();

  const held = ipc.hold("profiles.remove");
  await ui.press("Delete Sam");
  expect(ui.rows()[1]?.text).toContain("Recordings and downloads stay.");
  expect(document.activeElement?.textContent).toBe("Cancel");
  await ui.press("Delete");
  await vi.waitFor(() => expect(ui.named("Deleting…")).toBeDefined());
  // Main keeps the tombstone when it can't finish removing the profile's files.
  rows = rows.map((row) => (row.id === "sam" ? { ...row, deleting: true } : row));
  held.reject({ kind: "unexpected", detail: "Disk busy." });
  await vi.waitFor(() => expect(ui.alert()).toContain("Disk busy."));
  await vi.waitFor(() =>
    expect(ui.rows()[1]?.text).toBe("S" + "Sam" + "Deleting didn't finish" + "Retry"),
  );

  ipc.always("profiles.remove", null);
  rows = rows.filter((row) => row.id !== "sam");
  await ui.press("Retry deleting Sam");
  await vi.waitFor(() => expect(ui.rows().map((row) => row.text)).toEqual(["DDefault", "MMila"]));
  expect(ui.alert()).toBeNull();
  expect(ipc.argsOf("profiles.remove")).toEqual([
    { id: "sam", current: A },
    { id: "sam", current: A },
  ]);
});

it("shows a refused switch in the viewer's language with Retry, which switches once main accepts", async () => {
  ipc.always("language.get", dutch);
  ipc.always("profiles.list", [
    { id: A.id, name: "Default", deleting: false },
    { id: B.id, name: "Sam", deleting: false },
  ]);
  await openMenu();
  const ui = menu();
  expect(ui.named("Profiel: Standaard")).toBeDefined();
  await vi.waitFor(() =>
    expect(document.querySelector("[role=dialog]")?.textContent).toContain(
      "Lijsten, voortgang en favorieten blijven bij elk profiel.",
    ),
  );

  const held = ipc.hold("profiles.switch");
  await ui.press("SSam");
  await vi.waitFor(() => expect(ui.named("SSamWisselen…")).toBeDefined());
  held.reject({ kind: "unexpected", detail: "TMDB configuration refused." });
  await vi.waitFor(() => expect(ui.alert()).toContain("TMDB configuration refused."));
  expect(profileOwner()).toEqual(A);

  ipc.always("profiles.switch", B);
  ipc.always("output.status", local(B));
  await ui.press(t("Retry"));
  await vi.waitFor(() =>
    expect(profileStatus()).toMatchObject({ owner: B, pending: false, error: null }),
  );
  expect(ipc.argsOf("profiles.switch")).toEqual([
    { id: B.id, current: A },
    { id: B.id, current: A },
  ]);
});

it("retries a durably selected owner without saving obsolete playback again", async () => {
  selectProfileOwner(A);
  ipc.always("profiles.active", A);
  ipc.always("output.status", local(A));
  stop = syncProfiles(client);
  await vi.waitFor(() => expect(profileStatus().pending).toBe(false));
  const save = vi.spyOn(titlePlayer, "prepareProfileSwitch").mockResolvedValue(true);
  ipc.always("profiles.active", B);
  ipc.refuse("profiles.switch", { kind: "unexpected", detail: "Configuration refused." });
  await expect(switchProfile(client, B.id)).rejects.toBeDefined();
  expect(profileOwner()).toEqual(B);
  save.mockResolvedValue(false);
  ipc.always("profiles.switch", B);
  ipc.always("output.status", local(B));
  await switchProfile(client, B.id);
  expect(save).toHaveBeenCalledTimes(1);
  expect(ipc.argsOf("profiles.switch").at(-1)).toEqual({ id: B.id, current: B });
  expect(profileStatus()).toMatchObject({ owner: B, pending: false, error: null });
});

it("still requires playback to save after an uncommitted switch and refused recovery read", async () => {
  ipc.always("profiles.active", A);
  ipc.always("output.status", local(A));
  stop = syncProfiles(client);
  await vi.waitFor(() =>
    expect(profileStatus()).toMatchObject({ owner: A, pending: false, error: null }),
  );
  const save = vi.spyOn(titlePlayer, "prepareProfileSwitch").mockResolvedValue(true);
  ipc.refuse("profiles.switch", { kind: "unexpected", detail: "Selection refused." });
  ipc.refuse("profiles.active", { kind: "unexpected", detail: "Owner read refused." });
  await expect(switchProfile(client, B.id)).rejects.toBeDefined();
  expect(profileOwner()).toEqual(A);
  expect(profileStatus().error).not.toBeNull();
  save.mockResolvedValue(false);
  ipc.always("profiles.switch", B);
  await expect(switchProfile(client, B.id)).rejects.toMatchObject({
    error: { kind: "unexpected", detail: "Playback could not be saved. Try again." },
  });
  expect(ipc.argsOf("profiles.switch")).toHaveLength(1);
});

it("startup Retry configures the exact restored owner before loading private state", async () => {
  ipc.always("profiles.active", B);
  ipc.always("output.status", local(B));
  ipc.refuse("language.get", { kind: "unexpected", detail: "Configuration unfinished." });
  stop = syncProfiles(client);
  await vi.waitFor(() => expect(profileStatus()).toMatchObject({ owner: B, pending: false }));
  expect(profileStatus().error).not.toBeNull();
  stop();
  ipc.always("language.get", dutch);
  ipc.always("profiles.switch", B);
  stop = syncProfiles(client);
  await vi.waitFor(() =>
    expect(profileStatus()).toMatchObject({ owner: B, pending: false, error: null }),
  );
  expect(ipc.argsOf("profiles.switch")).toEqual([{ id: B.id, current: B }]);
});

it.each([AGAIN, B])(
  "keeps a superseding successful selection %j when recovery finishes late",
  async (next) => {
    ipc.always("profiles.active", A);
    ipc.always("output.status", local(A));
    stop = syncProfiles(client);
    await vi.waitFor(() =>
      expect(profileStatus()).toMatchObject({ owner: A, pending: false, error: null }),
    );
    vi.spyOn(titlePlayer, "prepareProfileSwitch").mockResolvedValue(true);
    ipc.always("profiles.active", B);
    ipc.always("output.status", local(B));
    ipc.refuse("profiles.switch", { kind: "unexpected", detail: "Configuration refused." });
    const language = ipc.hold("language.get");
    const pending = switchProfile(client, B.id);
    const refused = expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(profileOwner()).toEqual(B));
    await vi.waitFor(() => expect(ipc.argsOf("language.get")).toHaveLength(2));
    ipc.always("language.get", english);
    ipc.always("output.status", local(next));
    ipc.emit("profiles.activeChanged", next);

    if (next !== B)
      await vi.waitFor(() =>
        expect(profileStatus()).toMatchObject({ owner: next, pending: false, error: null }),
      );

    language.resolve(dutch);
    await refused;
    expect(profileStatus()).toMatchObject({ owner: next, pending: false, error: null });
  },
);

it.each([
  { recovery: "Retry", empty: false },
  { recovery: "another profile", empty: false },
  { recovery: "Retry", empty: true },
  { recovery: "another profile", empty: true },
])(
  "keeps recovery controls available and restores navigation through %j",
  async ({ recovery, empty }) => {
    useUi.setState(useUi.getInitialState(), true);
    ipc.always("profiles.active", B);
    ipc.always("profiles.list", [
      { id: A.id, name: "Default", deleting: false },
      { id: B.id, name: "Sam", deleting: false },
    ]);
    ipc.always("output.status", local(B));
    ipc.always("subscription.list", empty ? [] : [SAVED]);
    ipc.always("liveBrowse.get", { kind: "all" });
    ipc.always("library.categories", []);
    ipc.always("library.browse", browseResult([]));
    ipc.always("viewing.get", viewing(0));
    ipc.always("ondemand.status", { lists: [], metadata: null });
    ipc.refuse("language.get", { kind: "unexpected", detail: "Configuration unfinished." });

    const named = () =>
      [...document.querySelectorAll("button")].map(
        (button) => button.getAttribute("aria-label") ?? button.textContent?.trim(),
      );

    const view = queryView(client);
    unmount = view.unmount;
    await view.render(createElement(TooltipProvider, null, createElement(App)));
    await vi.waitFor(() => expect(document.querySelector("[role=alert]")).not.toBeNull());

    // The bar stays the window's drag area, with nothing that opens a page no one can show.
    const bar = document.querySelector("header");
    expect(bar?.classList.contains("drag")).toBe(true);
    await vi.waitFor(() =>
      expect(named()).toEqual([t("Profile: {name}", { name: "Sam" }), t("Retry")]),
    );
    expect(bar?.textContent).toBe("mr. streamerS");

    ipc.always("language.get", english);

    if (recovery === "Retry") {
      ipc.always("profiles.switch", B);
      await menu().press(t("Retry"));
    } else {
      ipc.always("profiles.switch", AGAIN);
      ipc.always("profiles.active", AGAIN);
      ipc.always("output.status", local(AGAIN));
      await menu().press(t("Profile: {name}", { name: "Sam" }));
      await menu().press("DDefault");
      expect(ipc.argsOf("profiles.switch").at(-1)).toEqual({ id: A.id, current: B });
    }

    if (empty) {
      await vi.waitFor(() => expect(profileStatus().error).toBeNull());
      expect(named()).not.toContain(t("Search"));
      expect(named()).not.toContain(t("Settings"));
      expect(profileOwner()).toEqual(recovery === "Retry" ? B : AGAIN);
    } else {
      await vi.waitFor(() =>
        expect(named()).toEqual(expect.arrayContaining([t("Home"), t("Search"), t("Settings")])),
      );
    }

    expect(document.querySelector("[role=alert]")).toBeNull();
  },
);

it("switches profiles from Connect and from standalone Downloads, and offers them on standalone Recordings", async () => {
  useUi.setState(useUi.getInitialState(), true);
  ipc.always("profiles.active", A);
  ipc.always("profiles.list", [
    { id: A.id, name: "Default", deleting: false },
    { id: B.id, name: "Sam", deleting: false },
  ]);
  ipc.always("output.status", local(A));
  ipc.always("language.get", english);
  ipc.always("subscription.list", []);
  ipc.always("downloads.list", {
    items: [
      {
        id: "kept",
        title: { kind: "movie", id: "m1" },
        subscription: null,
        name: "Past Lives",
        episodeName: null,
        year: 2023,
        duration: 6360,
        originalLanguage: "ko",
        posterUrl: null,
        wideUrl: null,
        size: 2_300_000_000,
        status: { kind: "complete" },
        progress: null,
        series: null,
      },
    ],
    series: {},
    bytes: 2_300_000_000,
    free: 212_000_000_000,
    ended: 0,
  });
  ipc.always("recordings.list", [
    {
      id: "r1",
      channel: { subscriptionId: "gone", id: "11" },
      channelName: "Estuary Max",
      title: "Weather Watch",
      start: Date.now() - 2 * 60 * 60_000,
      stop: Date.now() - 60 * 60_000,
      ended: Date.now() - 60 * 60_000,
      bytes: 900_000_000,
      status: { kind: "complete" },
    },
  ]);
  ipc.always("recordings.schedules", []);
  ipc.always("recordings.storage", {
    folder: "/home/viewer/Videos",
    used: 900_000_000,
    free: 312_000_000_000,
    keepFree: 5 * 1024 ** 3,
    space: null,
  });

  const view = queryView(client);
  unmount = view.unmount;
  await view.render(createElement(TooltipProvider, null, createElement(App)));
  await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());

  // Connect, before any subscription: the avatar switches the owner.
  const ui = menu();
  await vi.waitFor(() => expect(ui.named(t("Downloads"))).toBeDefined());
  await vi.waitFor(() =>
    expect(ui.named(t("Profile: {name}", { name: t("Default") }))).toBeDefined(),
  );
  ipc.always("profiles.switch", B);
  ipc.always("profiles.active", B);
  ipc.always("output.status", local(B));
  await ui.press(t("Profile: {name}", { name: t("Default") }));
  await ui.press("SSam");
  await vi.waitFor(() =>
    expect(profileStatus()).toMatchObject({ owner: B, pending: false, error: null }),
  );
  expect(ipc.argsOf("profiles.switch")).toEqual([{ id: B.id, current: A }]);
  await vi.waitFor(() => expect(ui.named(t("Profile: {name}", { name: "Sam" }))).toBeDefined());

  // Downloads opened from Connect stands alone, its bar ending in the same avatar.
  await ui.press(t("Downloads"));
  await vi.waitFor(() => expect(document.querySelector("form")).toBeNull());
  await vi.waitFor(() =>
    expect(document.querySelector("header")?.textContent).toContain(t("Add subscription")),
  );
  expect(ui.named(t("Profile: {name}", { name: "Sam" }))?.closest("header")).toBeTruthy();
  ipc.always("profiles.switch", AGAIN);
  ipc.always("profiles.active", AGAIN);
  ipc.always("output.status", local(AGAIN));
  await ui.press(t("Profile: {name}", { name: "Sam" }));
  await ui.press("DDefault");
  await vi.waitFor(() =>
    expect(profileStatus()).toMatchObject({ owner: AGAIN, pending: false, error: null }),
  );
  expect(ipc.argsOf("profiles.switch").at(-1)).toEqual({ id: A.id, current: B });

  // The switch went back to Connect; Recordings from there stands alone with the avatar too.
  await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
  await vi.waitFor(() => expect(ui.named(t("Recordings"))).toBeDefined());
  await ui.press(t("Recordings"));
  await vi.waitFor(() => expect(document.body.textContent).toContain("Weather Watch"));
  expect(ui.named(t("Profile: {name}", { name: t("Default") }))?.closest("header")).toBeTruthy();
});
