import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakePlaylist, type FakePlaylist } from "../../desktop/test/fake-playlist.ts";
import { startFakeProvider, type FakeProvider } from "../../desktop/test/fake-provider.ts";
import { sourcesOwner, type ConnectedSource, type SourcesOwner } from "../src/connect/sources.ts";
import type { Authority, Credentials } from "../src/platform/credentials.ts";

// The Android app's saved sources, through their owner: connecting Xtream and M3U providers,
// listing their channels, launching again, and removing one, against the desktop tests' fake
// panel and playlist host. The phone's protected credentials and files folder are kept in memory,
// shared by every "launch" of one phone, as the device keeps them between launches.

interface Phone {
  readonly sealed: Map<string, Authority>;
  readonly files: Map<string, string>;
  /** Set to make the credentials refuse every operation, as an unusable Keystore key does. */
  refuse: boolean;
}

const newPhone = (): Phone => ({ sealed: new Map(), files: new Map(), refuse: false });

function launch(phone: Phone, fetchImpl: typeof fetch = fetch): SourcesOwner {
  const guard = () => {
    if (phone.refuse) throw new Error("refused");
  };
  const credentials: Credentials = {
    read: async (id) => (guard(), phone.sealed.get(id) ?? null),
    write: async (id, authority) => void (guard(), phone.sealed.set(id, authority)),
    remove: async (id) => void (guard(), phone.sealed.delete(id)),
  };
  return sourcesOwner({
    credentials,
    readJson: (name) => {
      const text = phone.files.get(name);
      return text === undefined ? null : (JSON.parse(text) as unknown);
    },
    writeJson: (name, value) => void phone.files.set(name, JSON.stringify(value)),
    fetch: fetchImpl,
    userAgent: "MrStreamer-Android/test",
  });
}

const listed = (owner: SourcesOwner): readonly ConnectedSource[] => {
  const state = owner.state.get();
  return state.kind === "ready" ? state.sources : [];
};

/** Resolves once every listed source's channels have settled. */
async function settled(owner: SourcesOwner): Promise<readonly ConnectedSource[]> {
  await expect
    .poll(() => listed(owner).every((source) => source.channels.kind !== "loading"), {
      timeout: 10_000,
    })
    .toBe(true);
  return listed(owner);
}

const rowCount = (source: ConnectedSource | undefined) =>
  source?.channels.kind === "ready" ? source.channels.rows.length : -1;

let panel: FakeProvider;
let playlist: FakePlaylist;
const PASSWORD = "android-secret-pass";

beforeAll(async () => {
  panel = await startFakeProvider({ username: "viewer", password: PASSWORD, channels: 40 });
  playlist = await startFakePlaylist();
});

afterAll(async () => {
  await Promise.all([panel.close(), playlist.close()]);
});

const xtream = () => ({ server: panel.url, username: "viewer", password: PASSWORD });
const m3u = () => ({ server: playlist.link, username: "", password: "" });

describe("Android sources", () => {
  it("connects an Xtream panel and an M3U link and lists both sources' channels together", async () => {
    const owner = launch(newPhone());
    await owner.restore();

    expect(await owner.connect(xtream())).toMatchObject({ kind: "connected" });
    expect(await owner.connect(m3u())).toMatchObject({ kind: "connected" });

    const [panelSource, playlistSource] = await settled(owner);
    expect(panelSource?.kind).toBe("xtream");
    expect(rowCount(panelSource)).toBeGreaterThan(0);
    expect(playlistSource?.kind).toBe("m3u");
    expect(playlistSource?.channels).toMatchObject({
      kind: "ready",
      rows: expect.arrayContaining([
        expect.objectContaining({ title: "TEST | Two sounds and subtitles" }),
      ]),
    });
  });

  it("keeps logins in the protected credentials only, never in the files or the screens' state", async () => {
    const phone = newPhone();
    const owner = launch(phone);
    await owner.restore();
    await owner.connect(xtream());
    await owner.connect(m3u());
    await settled(owner);

    const token = new URL(playlist.link).searchParams.values().next().value ?? "";
    const written = [...phone.files.values()].join("\n") + JSON.stringify(owner.state.get());
    for (const secret of [PASSWORD, "viewer", token]) expect(written).not.toContain(secret);
    expect([...phone.sealed.values()]).toEqual(
      expect.arrayContaining([
        { kind: "xtream", server: panel.url, username: "viewer", password: PASSWORD },
        { kind: "m3u", link: playlist.link },
      ]),
    );
  });

  it("saves nothing when the provider refuses the login", async () => {
    const phone = newPhone();
    const owner = launch(phone);
    await owner.restore();

    const refused = await owner.connect({ ...xtream(), password: "wrong" });

    expect(refused).toMatchObject({ kind: "failed", error: { kind: "invalid-login" }, http: null });
    expect(listed(owner)).toEqual([]);
    expect(phone.sealed.size).toBe(0);
    expect(phone.files.size).toBe(0);
  });

  it("offers plain http only for an address typed without a scheme whose https failed", async () => {
    const owner = launch(newPhone());
    await owner.restore();
    const typed = { ...xtream(), server: panel.url.replace(/^http:\/\//, "") };

    const first = await owner.connect(typed);
    expect(first).toMatchObject({ kind: "failed", error: { kind: "unreachable" } });
    if (first.kind !== "failed" || !first.http) throw new Error("no http offered");
    expect(first.http.server).toBe(`http://${typed.server}`);

    expect(await owner.connect(first.http)).toMatchObject({ kind: "connected" });
  });

  it("shows a source's failed channel list with its reason, and lists it on Try again", async () => {
    let failing = true;
    const flaky: typeof fetch = (input, init) =>
      failing && String(input).includes("get_live_streams")
        ? Promise.reject(new TypeError("Network request failed"))
        : fetch(input, init);
    const owner = launch(newPhone(), flaky);
    await owner.restore();
    await owner.connect(xtream());

    const [failed] = await settled(owner);
    expect(failed?.channels).toMatchObject({ kind: "failed", error: { kind: "unreachable" } });

    failing = false;
    owner.retry(failed?.id ?? "");
    expect(listed(owner)[0]?.channels.kind).toBe("loading");
    expect(rowCount((await settled(owner))[0])).toBeGreaterThan(0);
  });

  it("signs every saved source in again after a relaunch, from the credentials alone", async () => {
    const phone = newPhone();
    const first = launch(phone);
    await first.restore();
    await first.connect(xtream());
    await first.connect(m3u());
    const before = (await settled(first)).map((source) => [source.id, rowCount(source)]);

    const relaunched = launch(phone);
    expect(relaunched.state.get()).toEqual({ kind: "restoring" });
    await relaunched.restore();

    expect((await settled(relaunched)).map((source) => [source.id, rowCount(source)])).toEqual(
      before,
    );
  });

  it("keeps a source whose login can't be read after a relaunch, asking for it again", async () => {
    const phone = newPhone();
    const first = launch(phone);
    await first.restore();
    await first.connect(xtream());
    await settled(first);

    phone.sealed.clear();
    const relaunched = launch(phone);
    await relaunched.restore();

    expect(listed(relaunched)).toEqual([
      expect.objectContaining({
        channels: { kind: "failed", error: expect.objectContaining({ kind: "needs-secret" }) },
      }),
    ]);
    expect(await relaunched.connect(xtream())).toMatchObject({ kind: "connected" });
    expect(rowCount((await settled(relaunched))[0])).toBeGreaterThan(0);
  });

  it("removes a source: its read stops, its login is erased and a relaunch doesn't bring it back", async () => {
    const phone = newPhone();
    const owner = launch(phone);
    await owner.restore();
    await owner.connect(m3u());
    const connected = await owner.connect(xtream());
    if (connected.kind !== "connected") throw new Error("not connected");

    // Removed while its channels still load: their late answer must not bring it back.
    await owner.remove(connected.id);

    const remaining = await settled(owner);
    expect(remaining.map((source) => source.kind)).toEqual(["m3u"]);
    expect(phone.sealed.has(connected.id)).toBe(false);

    const relaunched = launch(phone);
    await relaunched.restore();
    expect((await settled(relaunched)).map((source) => source.kind)).toEqual(["m3u"]);
  });

  it("keeps a source listed when its login can't be erased", async () => {
    const phone = newPhone();
    const owner = launch(phone);
    await owner.restore();
    await owner.connect(xtream());
    await settled(owner);
    const [source] = listed(owner);

    phone.refuse = true;
    await expect(owner.remove(source?.id ?? "")).rejects.toThrow();
    phone.refuse = false;

    expect(listed(owner).map((each) => each.id)).toEqual([source?.id]);
    expect(rowCount((await settled(owner))[0])).toBeGreaterThan(0);
  });
});
