import { keychain } from "./keychain.ts";
import { memoryFiles } from "./memory-files.ts";
import { nativePlayer } from "./native-player.ts";
// Installs the native guide stand-in a removal and a mapping forget through.
import { guideFixture } from "./native-guide.ts";
import { kindOf } from "@mrstreamer/core/ondemand/catalogue";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// M3U playlists as subscriptions: added by their link beside Xtream accounts, mapped group by
// group into Live, Movies and Series, and kept so builds before playlists still read the file.
// The app's own owners run over Documents and a Keychain kept in memory across launches; a
// playlist host and one of the desktop tests' fake Xtream panels answer over HTTP.

const memory = vi.hoisted(() => ({
  files: new Map<string, string>(),
  keychain: new Map<string, string>(),
  full: new Set<string>(),
}));

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.2.0" } } }));
vi.mock("expo-video", () => ({ createVideoPlayer: () => nativePlayer(() => {}) }));
vi.mock("expo-file-system", () => memoryFiles(memory));
vi.mock("expo-secure-store", () => keychain(() => memory.keychain));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => {} }));

/** The token every playlist link carries, which must reach no file. */
const TOKEN = "s3cr3t-t0k3n";

interface Host {
  /** The link to add, with its token. */
  readonly link: (path?: string) => string;
  readonly origin: string;
  /** What the playlist lists from now on, as lines after #EXTM3U. */
  serve(lines: readonly string[]): void;
  /** Answers every request with this status from now on, or as it should with null. */
  fail(status: number | null): void;
  close(): Promise<void>;
}

async function startHost(): Promise<Host> {
  let lines: readonly string[] = [];
  let failing: number | null = null;
  const server: Server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://host");
    if (failing !== null) return response.writeHead(failing).end();
    if (pathname === "/page.html") return response.writeHead(200).end("<!doctype html><p>Hi</p>");
    if (!pathname.endsWith(".m3u")) return response.writeHead(404).end();
    response.writeHead(200).end(["#EXTM3U", ...lines, ""].join("\n"));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    link: (path = "/list.m3u") => `${origin}${path}?token=${TOKEN}`,
    origin,
    serve(next) {
      lines = next;
    },
    fail(status) {
      failing = status;
    },
    close: () => new Promise((closed) => server.close(() => closed())),
  };
}

/** A playlist with Live channels, films, a DASH film no player here plays, and episodes. */
const MIXED = (origin: string) => [
  '#EXTINF:-1 tvg-id="one.news" group-title="News",News One',
  `${origin}/live/one.ts?token=${TOKEN}`,
  '#EXTINF:-1 tvg-id="two.news" group-title="News",News Two',
  `${origin}/live/two.ts?token=${TOKEN}`,
  '#EXTINF:-1 group-title="Films",Harbour Lights (2019)',
  `${origin}/films/harbour.mp4?token=${TOKEN}`,
  '#EXTINF:-1 group-title="Films",Only In Dash',
  `${origin}/films/dash.mpd?token=${TOKEN}`,
  '#EXTINF:-1 group-title="Shows",Tidewater S01E01',
  `${origin}/shows/t101.mkv?token=${TOKEN}`,
  '#EXTINF:-1 group-title="Shows",Tidewater S01E02',
  `${origin}/shows/t102.mkv?token=${TOKEN}`,
  '#EXTINF:-1 group-title="Shows",Tidewater Behind the Scenes',
  `${origin}/shows/extra.mkv?token=${TOKEN}`,
];

interface FakeProvider {
  readonly url: string;
  close(): Promise<void>;
}
/** The panel is typed by Node's own lib, which the app's tsconfig leaves out: imported by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const { startFakeProvider } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    readonly username: string;
    readonly password: string;
    readonly channels: number;
    readonly titles: number;
  }): Promise<FakeProvider>;
};

let host: Host;
let panel: FakeProvider;
beforeAll(async () => {
  [host, panel] = await Promise.all([
    startHost(),
    startFakeProvider({ username: "one", password: "one+Pw@1", channels: 4, titles: 2 }),
  ]);
});
afterAll(async () => {
  await Promise.all([host.close(), panel.close()]);
});
beforeEach(() => {
  memory.files.clear();
  memory.keychain.clear();
  memory.full.clear();
  host.fail(null);
  host.serve(MIXED(host.origin));
});

/** Resolves once `ready` holds; fails the test when it doesn't within a few seconds. */
async function until(ready: () => boolean, what: string) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 8_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** The app as a launch starts it: fresh modules over the same Documents and Keychain. */
async function launch() {
  vi.resetModules();
  const titles = await import("../src/titles.ts");
  const account = await import("../src/account.ts");
  await account.restore();
  return { ...titles, ...account };
}
type App = Awaited<ReturnType<typeof launch>>;

const PLAYLIST = { username: "", password: "" };
const ids = (app: App) => app.members().map((member) => member.entry.id);
const member = (app: App, id: string) => app.members().find((each) => each.entry.id === id);
const channelNames = (app: App) => {
  const now = app.currentCatalogue();
  return now.kind === "ready"
    ? [...new Set(now.library.byKey.values())].map((each) => each.title)
    : [];
};
const titleNames = (app: App, kind: "movie" | "series") => {
  const lists = app.titleLists();
  return lists.kind === "ready" ? kindOf(lists.index, kind).titles.map((each) => each.name) : [];
};
const signedIn = (app: App) =>
  app.members().every((each) => each.account?.state === "active" && each.live.kind === "ready");
const registry = () => JSON.parse(memory.files.get("/documents/subscriptions.json") ?? "null");
const modes = (report: Awaited<ReturnType<App["playlistReport"]>>) =>
  Object.fromEntries(report.groups.map((group) => [group.name, group.mode]));

describe("a playlist subscription", () => {
  it("is added by its link, which only the Keychain keeps, and shows its channels after a relaunch", async () => {
    const app = await launch();
    const id = await app.add({ server: host.link(), ...PLAYLIST });
    if (!id) throw new Error("Not added");
    await until(() => channelNames(app).length === 6, "the playlist's channels");
    expect(member(app, id)).toMatchObject({ label: "127.0.0.1", account: { state: "active" } });
    expect(memory.keychain.get(`s.${id}`)).toBe(host.link());
    // Builds before playlists read `subscriptions`, which holds Xtream accounts only.
    expect(registry()).toMatchObject({
      subscriptions: [],
      playlists: [{ id, kind: "m3u", server: host.origin, name: null, position: 0 }],
    });
    await until(
      () => [...memory.files.keys()].some((path) => path.includes(`${id}.live`)),
      "the saved channels",
    );
    for (const [path, text] of memory.files) expect(text, path).not.toContain(TOKEN);

    const again = await launch();
    expect(ids(again)).toEqual([id]);
    await until(() => channelNames(again).includes("News One"), "the channels after a relaunch");
  });

  it("refuses an address that answers with something else, saving nothing", async () => {
    const app = await launch();
    await expect(app.add({ server: host.link("/page.html"), ...PLAYLIST })).rejects.toMatchObject({
      error: { kind: "incomplete-login" },
    });
    expect(registry()).toMatchObject({ subscriptions: [] });
    expect(registry().playlists).toBeUndefined();
    expect(memory.keychain.has("index") ? JSON.parse(memory.keychain.get("index")!) : []).toEqual(
      [],
    );
  });

  it("says when the host no longer serves the link, saving nothing", async () => {
    const app = await launch();
    host.fail(403);
    await expect(app.add({ server: host.link(), ...PLAYLIST })).rejects.toMatchObject({
      error: {
        kind: "incomplete-login",
        detail: expect.stringContaining("refused this playlist link"),
      },
    });
    expect(registry().playlists).toBeUndefined();
  });

  it("keeps its place among Xtream accounts through a relaunch", async () => {
    const app = await launch();
    const playlist = await app.add({ server: host.link(), ...PLAYLIST, name: "Shared list" });
    const xtream = await app.add({ server: panel.url, username: "one", password: "one+Pw@1" });
    expect(ids(await launch())).toEqual([playlist, xtream]);
    expect(registry().subscriptions.map((each: { id: string }) => each.id)).toEqual([xtream]);
  });

  it("reads a file an older build rewrote, keeping what a later build wrote", async () => {
    const app = await launch();
    const playlist = await app.add({ server: host.link(), ...PLAYLIST });
    const xtream = await app.add({ server: panel.url, username: "one", password: "one+Pw@1" });
    // An older build removed the Xtream account, carrying the fields it doesn't know as they
    // were; a later build saved a playlist this one can't read.
    const later = { id: "m3u-later", kind: "m3u", server: host.origin, key: "m3u:0", position: 9 };
    const file = registry();
    memory.files.set(
      "/documents/subscriptions.json",
      JSON.stringify({
        ...file,
        subscriptions: [],
        retired: [file.subscriptions[0]],
        playlists: [...file.playlists, { ...later, mapping: { version: 2, groups: [] } }],
      }),
    );
    const again = await launch();
    expect(ids(again)).toEqual([playlist]);
    // Adding the Xtream account again takes its id back, and the later entry is written back.
    await again.add({ server: panel.url, username: "one", password: "one+Pw@1" });
    expect(ids(again)).toEqual([playlist, xtream]);
    expect(registry().playlists).toContainEqual(expect.objectContaining({ id: "m3u-later" }));
  });

  it("keeps every secret of its link out of the saved lists", async () => {
    const link = `${host.origin}/list.m3u?user=viewer-7&pass=${TOKEN}&token=second-0ne`;
    host.serve([
      `#EXTINF:-1 tvg-logo="${host.origin}/logo.png?pass=${TOKEN}" group-title="News",News One`,
      `${host.origin}/live/one.ts`,
      `#EXTINF:-1 tvg-logo="${host.origin}/logo.png?k=second-0ne" group-title="News",News Two`,
      `${host.origin}/live/two.ts`,
      // A stream address where its name goes shows and saves as none.
      `#EXTINF:-1 group-title="News",${host.origin}/live/three.ts?pass=${TOKEN}`,
      `${host.origin}/live/three.ts`,
    ]);
    const app = await launch();
    const id = await app.add({ server: link, ...PLAYLIST });
    await until(() => channelNames(app).length === 3, "the channels");
    expect(channelNames(app)[2]).toBe("[address]");
    await until(
      () => [...memory.files.keys()].some((path) => path.includes(`${id}.live`)),
      "the saved channels",
    );
    for (const [path, text] of memory.files) {
      if (path.startsWith("/documents/subscriptions") || path.includes(".live"))
        for (const secret of [TOKEN, "second-0ne", "viewer-7"])
          expect(text, path).not.toContain(secret);
    }
  });

  it("saves lists that name its user within a longer text, but no address that holds it", async () => {
    host.serve([
      `#EXTINF:-1 tvg-logo="${host.origin}/logo.png?u=tv" group-title="News",tv news`,
      `${host.origin}/live/one.ts`,
    ]);
    const app = await launch();
    const id = (await app.add({ server: `${host.link()}&user=tv`, ...PLAYLIST }))!;
    await until(
      () => memory.files.get(`/cache/catalogues/${id}.live.json`) !== undefined,
      "the saved channels",
    );
    const live = memory.files.get(`/cache/catalogues/${id}.live.json`)!;
    expect(live).toContain("tv news");
    expect(live).not.toContain("u=tv");
  });

  it("keeps a user long enough to be a token out of saved artwork, within a longer text too", async () => {
    const user = "a8f3c0d2e7b14a6c55aa99";
    host.serve([
      `#EXTINF:-1 tvg-logo="${host.origin}/p/x${user}y.png" group-title="News",News One`,
      `${host.origin}/live/one.ts`,
    ]);
    const app = await launch();
    const id = (await app.add({ server: `${host.origin}/list.m3u?user=${user}`, ...PLAYLIST }))!;
    await until(
      () => memory.files.get(`/cache/catalogues/${id}.live.json`) !== undefined,
      "the saved channels",
    );
    expect(memory.files.get(`/cache/catalogues/${id}.live.json`)).not.toContain(user);
  });

  it("keeps a token under a name of its own, and a secret encoded as the link has it, out of saved lists", async () => {
    // A long value under a name the app doesn't know is taken for a token; `output=ts` is a setting.
    const signature = "f3a9c0d2e7b14a6c55";
    const link = `${host.origin}/list.m3u?signature=${signature}&output=ts&token=Ab%2F12-canary`;
    host.serve([
      `#EXTINF:-1 tvg-logo="${host.origin}/logo.png?sig=${signature}" group-title="News",News One`,
      `${host.origin}/live/one.ts`,
      `#EXTINF:-1 tvg-logo="${host.origin}/ts/logo.png" group-title="News",News Two`,
      `${host.origin}/live/two.ts`,
      '#EXTINF:-1 group-title="Films",Harbour Lights',
      `${host.origin}/films/harbour.mp4`,
    ]);
    const app = await launch();
    const id = (await app.add({ server: link, ...PLAYLIST }))!;
    await until(
      () => memory.files.get(`/cache/catalogues/${id}.live.json`) !== undefined,
      "the saved channels",
    );
    const live = memory.files.get(`/cache/catalogues/${id}.live.json`)!;
    expect(live).toContain(`${host.origin}/ts/logo.png`);
    expect(live).not.toContain(signature);

    // A channel whose id is the token as the link encodes it leaves Live unsaved.
    host.serve([
      '#EXTINF:-1 tvg-id="Ab%2F12-canary" group-title="News",News One',
      `${host.origin}/live/one.ts`,
      '#EXTINF:-1 group-title="Films",Harbour Lights',
      `${host.origin}/films/harbour.mp4`,
    ]);
    await app.mapPlaylist(id, groupId(await app.playlistReport(id), "Films"), "movie");
    await until(
      () => memory.files.get(`/cache/catalogues/${id}.titles.json`)?.includes("Harbour") === true,
      "the saved films",
    );
    await new Promise((settled) => setTimeout(settled, 200));
    expect(channelNames(app)).toEqual(["News One"]);
    for (const [path, text] of memory.files)
      for (const secret of [signature, "Ab%2F12", "Ab/12"])
        expect(text, path).not.toContain(secret);
  });

  it("stays the same subscription with a new link, added again, or removed and added back", async () => {
    const app = await launch();
    const id = await app.add({ server: host.link(), ...PLAYLIST });
    const moved = host.link("/moved.m3u");
    await app.update(id!, { password: moved });
    expect(memory.keychain.get(`s.${id}`)).toBe(moved);
    // It goes by its new link now: adding that link again finds it, the old one is another.
    await expect(app.add({ server: moved, ...PLAYLIST, name: "Again" })).resolves.toBe(id);
    expect(ids(app)).toEqual([id]);
    const other = await app.add({ server: host.link(), ...PLAYLIST });
    expect(other).not.toBe(id);
    await expect(app.update(other!, { password: moved })).rejects.toMatchObject({
      error: { kind: "incomplete-login" },
    });
    await app.remove(other!, { keepHistory: false });
    // A login in the link makes it an Xtream panel's: another subscription, not this one's link.
    await expect(
      app.update(id!, { password: `${host.origin}/get.php?username=a&password=b` }),
    ).rejects.toMatchObject({ error: { kind: "incomplete-login" } });

    // A new link the registry can't take leaves the link it had, under the fingerprint it had.
    memory.full.add("subscriptions.json");
    await expect(app.update(id!, { password: host.link("/third.m3u") })).rejects.toThrow();
    memory.full.clear();
    expect(memory.keychain.get(`s.${id}`)).toBe(moved);

    await app.remove(id!, { keepHistory: true });
    expect(ids(app)).toEqual([]);
    await expect(app.add({ server: moved, ...PLAYLIST })).resolves.toBe(id);
  });

  it("goes by the link the Keychain holds when the app stopped while saving a new one", async () => {
    const app = await launch();
    const id = (await app.add({ server: host.link(), ...PLAYLIST }))!;
    // Stopped after the Keychain took the new link, before the registry did.
    const moved = host.link("/moved.m3u");
    memory.keychain.set(`s.${id}`, moved);
    const again = await launch();
    await until(() => channelNames(again).length === 6, "the channels after a relaunch");
    await expect(again.add({ server: moved, ...PLAYLIST })).resolves.toBe(id);
    expect(ids(again)).toEqual([id]);
    const other = await again.add({ server: host.link(), ...PLAYLIST });
    expect(other).not.toBe(id);
  });

  it("keeps the link it went by at launch when another playlist has the Keychain's, or the registry refuses it", async () => {
    const app = await launch();
    const id = (await app.add({ server: host.link(), ...PLAYLIST }))!;
    const other = (await app.add({ server: host.link("/other.m3u"), ...PLAYLIST }))!;
    const saved = registry().playlists;
    // Stopped after the Keychain took a new link another playlist goes by.
    memory.keychain.set(`s.${id}`, host.link("/other.m3u"));
    let again = await launch();
    await until(() => signedIn(again), "both signed in after a relaunch");
    expect(registry().playlists).toEqual(saved);
    // Stopped after the Keychain took a new link the registry can't take at launch.
    memory.keychain.set(`s.${id}`, host.link());
    memory.keychain.set(`s.${other}`, host.link("/third.m3u"));
    memory.full.add("subscriptions.json");
    again = await launch();
    await until(() => signedIn(again), "both signed in after a relaunch");
    memory.full.clear();
    expect(registry().playlists).toEqual(saved);
    expect(ids(again)).toEqual([id, other]);
  });

  it("keeps the channels it showed when a reload fails, and loads them on Try again", async () => {
    const app = await launch();
    const id = await app.add({ server: host.link(), ...PLAYLIST });
    await until(() => channelNames(app).length === 6, "the channels");
    host.fail(503);
    app.reloadChannels(id!);
    await until(() => member(app, id!)?.live.kind === "failed", "the failed reload");
    expect(member(app, id!)?.live).toMatchObject({
      error: { kind: "provider-error", status: 503 },
    });
    expect(channelNames(app)).toHaveLength(6);
    host.fail(null);
    app.retryChannels();
    await until(() => member(app, id!)?.live.kind === "ready", "the channels again");
  });
});

describe("mapping a playlist's groups", () => {
  it("imports the groups picked as movies and series, and says what stays out and why", async () => {
    const app = await launch();
    const id = (await app.add({ server: host.link(), ...PLAYLIST }))!;
    await until(() => channelNames(app).length === 6, "the channels");
    // Until a first pick everything is Live.
    expect(modes(await app.playlistReport(id))).toEqual({
      News: "live",
      Films: "live",
      Shows: "live",
    });

    await app.mapPlaylist(id, groupId(await app.playlistReport(id), "Films"), "movie");
    await app.mapPlaylist(id, groupId(await app.playlistReport(id), "Shows"), "series");
    await until(() => titleNames(app, "series").length === 1, "the mapped series");
    expect(titleNames(app, "movie")).toEqual(["Harbour Lights (2019)"]);
    expect(titleNames(app, "series")).toEqual(["Tidewater"]);
    await until(() => channelNames(app).length === 2, "Live without the mapped groups");

    const report = await app.playlistReport(id);
    expect(modes(report)).toEqual({ News: "live", Films: "movie", Shows: "series" });
    expect(report.status).toMatchObject({ live: 2, movies: 1, series: 1, episodes: 2, omitted: 2 });
    expect(report.omissions).toEqual([
      { name: "Only In Dash", groups: ["Films"], reason: "unsupported-address" },
      { name: "Tidewater Behind the Scenes", groups: ["Shows"], reason: "invalid-episode" },
    ]);
    expect(JSON.stringify(report)).not.toContain(host.origin);

    // The mapping stays; a group added since waits for a pick, its entries out meanwhile.
    host.serve([
      ...MIXED(host.origin),
      '#EXTINF:-1 group-title="Kids",Paper Boats',
      `${host.origin}/kids/boats.mp4`,
    ]);
    const again = await launch();
    await until(() => titleNames(again, "movie").length === 1, "the films after a relaunch");
    const later = await again.playlistReport(id);
    expect(modes(later)).toEqual({ News: "live", Films: "movie", Shows: "series", Kids: null });
    expect(later.omissions).toContainEqual({
      name: "Paper Boats",
      groups: ["Kids"],
      reason: "unmapped",
    });
  });

  it("keeps its picks when removed with its history and added back", async () => {
    const app = await launch();
    const id = (await app.add({ server: host.link(), ...PLAYLIST }))!;
    await app.mapPlaylist(id, groupId(await app.playlistReport(id), "Films"), "movie");
    await until(() => titleNames(app, "movie").length === 1, "the mapped films");
    await app.remove(id, { keepHistory: true });

    const again = await launch();
    await expect(again.add({ server: host.link(), ...PLAYLIST })).resolves.toBe(id);
    await until(() => titleNames(again, "movie").length === 1, "the films without a new pick");
    expect(modes(await again.playlistReport(id))).toMatchObject({ Films: "movie" });
  });

  it("skips a group, and gives it back to Live", async () => {
    const app = await launch();
    const id = (await app.add({ server: host.link(), ...PLAYLIST }))!;
    await until(() => channelNames(app).length === 6, "the channels");
    await app.mapPlaylist(id, groupId(await app.playlistReport(id), "Shows"), "skip");
    await until(() => channelNames(app).length === 3, "Live without the skipped group");
    expect((await app.playlistReport(id)).omissions).toContainEqual({
      name: "Tidewater S01E01",
      groups: ["Shows"],
      reason: "skip",
    });
    await app.mapPlaylist(id, groupId(await app.playlistReport(id), "Shows"), "live");
    await until(() => channelNames(app).includes("Tidewater S01E01"), "the group back in Live");
    expect(titleNames(app, "series")).toEqual([]);
  });

  it("keeps every secret of its link out of the saved movie lists", async () => {
    const link = `${host.origin}/list.m3u?user=viewer-7&pass=${TOKEN}&token=second-0ne`;
    host.serve([
      `#EXTINF:-1 tvg-logo="${host.origin}/second-0ne/poster.jpg" group-title="Films",Harbour Lights`,
      `${host.origin}/films/harbour.mp4?pass=${TOKEN}`,
      `#EXTINF:-1 tvg-logo="${host.origin}/art/${encodeURIComponent(TOKEN)}.jpg" group-title="Films",Night Ferry`,
      `${host.origin}/films/ferry.mp4`,
    ]);
    const app = await launch();
    const id = (await app.add({ server: link, ...PLAYLIST }))!;
    await app.mapPlaylist(id, groupId(await app.playlistReport(id), "Films"), "movie");
    await until(() => titleNames(app, "movie").length === 2, "the films");
    await until(
      () => [...memory.files.keys()].some((path) => path.includes(`${id}.titles`)),
      "the saved films",
    );
    for (const [path, text] of memory.files)
      for (const secret of [TOKEN, "second-0ne", "viewer-7"])
        expect(text, path).not.toContain(secret);
  });

  it("refuses a group the playlist no longer lists, changing nothing", async () => {
    const app = await launch();
    const id = (await app.add({ server: host.link(), ...PLAYLIST }))!;
    await expect(app.mapPlaylist(id, "0".repeat(64), "movie")).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    expect(registry().playlists[0].mapping).toBeUndefined();
  });
});

describe("a playlist's guide", () => {
  /**
   * The adapter over `link` whose playlist names `guide`, which redirects to `moved` when given,
   * and every address it asked.
   */
  async function guideOf(link: string, guide: string, moved?: string) {
    const asked: string[] = [];
    const { playlistProvider } = await import("../src/playlist.ts");
    const provider = playlistProvider(
      { link },
      {
        userAgent: "test",
        fetch: async (input) => {
          const url = String(input);
          asked.push(url);
          return moved && url === guide
            ? new Response(null, { status: 302, headers: { location: moved } })
            : new Response(`#EXTM3U x-tvg-url="${guide}"\n`);
        },
      },
    );
    return { provider, asked };
  }

  it("is not asked over http with the login of an https link", async () => {
    const guide = `http://guide.example/guide.xml?token=${TOKEN}`;
    const { provider, asked } = await guideOf(`https://tv.example/list.m3u?token=${TOKEN}`, guide);
    await expect(provider.liveGuideRequest!()).rejects.toMatchObject({
      error: { kind: "unreachable", server: "https://tv.example" },
    });
    await expect(provider.liveGuide!()).rejects.toMatchObject({ error: { kind: "unreachable" } });
    expect(asked.some((each) => each.startsWith("http://guide.example"))).toBe(false);
  });

  it("is not followed over http with the login of an https link it redirects to", async () => {
    const guide = "http://guide.example/start.xml";
    const moved = `http://guide.example/guide.xml?token=${TOKEN}`;
    const link = `https://tv.example/list.m3u?token=${TOKEN}`;
    const { provider, asked } = await guideOf(link, guide, moved);
    await expect(provider.liveGuide!()).rejects.toThrow();

    // The native reader closes each redirect for the app to check before it asks the next.
    const request = await provider.liveGuideRequest!();
    if (request.kind !== "request") throw new Error("No guide");
    const { native } = guideFixture();
    native.prepare = async (_lease, _job, url) => {
      asked.push(url);
      return { kind: "ok", value: { kind: "redirect", location: moved } };
    };
    const { ingest } = await import("../src/guide-native.ts");
    const { playlistSecrets } = await import("../src/playlist.ts");
    await expect(
      ingest(native, "lease", "job", request, [...playlistSecrets(link), link], 0, () => true),
    ).resolves.toEqual({ kind: "failed", error: "redirect" });
    expect(asked).toContain(guide);
    expect(asked).not.toContain(moved);
  });

  it("is asked where it is when it holds no login, or the link is http too", async () => {
    for (const [link, guide] of [
      [`https://tv.example/list.m3u?token=${TOKEN}`, "http://guide.example/guide.xml"],
      [
        `http://tv.example/list.m3u?token=${TOKEN}`,
        `http://guide.example/guide.xml?token=${TOKEN}`,
      ],
    ] as const) {
      const { provider } = await guideOf(link, guide);
      await expect(provider.liveGuideRequest!()).resolves.toMatchObject({
        kind: "request",
        url: guide,
      });
    }
  });
});

function groupId(report: Awaited<ReturnType<App["playlistReport"]>>, name: string): string {
  const found = report.groups.find((group) => group.name === name);
  if (!found) throw new Error(`No group ${name}`);
  return found.group;
}
