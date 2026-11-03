import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
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
  /** Set to make reading a credential fail, as a damaged sealed file does. */
  unreadable: boolean;
  /** Set to make the files folder refuse writes, as a full disk does. */
  full: boolean;
  /** Set to hold credential writes, as a slow Keystore does: `started` is told, `until` releases. */
  hold: { readonly started: () => void; readonly until: Promise<void> } | null;
}

const newPhone = (): Phone => ({
  sealed: new Map(),
  files: new Map(),
  refuse: false,
  unreadable: false,
  full: false,
  hold: null,
});

function launch(phone: Phone, fetchImpl: typeof fetch = fetch): SourcesOwner {
  const guard = () => {
    if (phone.refuse) throw new Error("refused");
  };

  const credentials: Credentials = {
    read: async (id) => {
      guard();

      if (phone.unreadable) throw new Error("damaged");

      return phone.sealed.get(id) ?? null;
    },
    write: async (id, authority) => {
      guard();
      phone.hold?.started();
      await phone.hold?.until;
      phone.sealed.set(id, authority);
    },
    remove: async (id) => void (guard(), phone.sealed.delete(id)),
    retain: async (ids) => {
      guard();

      for (const id of phone.sealed.keys()) if (!ids.includes(id)) phone.sealed.delete(id);
    },
  };

  return sourcesOwner({
    credentials,
    // As storage.ts reads: no file, or one that isn't JSON, is none.
    readJson: (name) => {
      try {
        return JSON.parse(phone.files.get(name) ?? "null") as unknown;
      } catch {
        return null;
      }
    },
    writeJson: (name, value) => {
      if (phone.full) throw new Error("ENOSPC");
      phone.files.set(name, JSON.stringify(value));
    },
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

const xtreamAccount = () => ({ server: panel.url, username: "viewer", password: PASSWORD });
const xtream = xtreamAccount;
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

  it("leaves adults' channels out: those flagged and those in a category for adults", async () => {
    const adults = await startFakeProvider({
      username: "viewer",
      password: PASSWORD,
      channels: 20,
      adultChannels: true,
    });

    try {
      const owner = launch(newPhone());
      await owner.restore();
      await owner.connect({ ...xtream(), server: adults.url });

      const [source] = await settled(owner);

      const titles =
        source?.channels.kind === "ready" ? source.channels.rows.map((row) => row.title) : [];

      expect(titles.length).toBeGreaterThan(0);

      for (const adult of ["After Hours", "Late Show", "Night Club"])
        expect(titles).not.toContain(adult);
    } finally {
      await adults.close();
    }
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
    await relaunched.restore();

    expect((await settled(relaunched)).map((source) => [source.id, rowCount(source)])).toEqual(
      before,
    );
  });

  it.each([
    ["missing", (phone: Phone) => phone.sealed.clear()],
    ["unreadable", (phone: Phone) => void (phone.unreadable = true)],
  ])("keeps a source whose login is %s after a relaunch, asking for it again", async (_, lose) => {
    const phone = newPhone();
    const first = launch(phone);
    await first.restore();
    await first.connect(xtream());
    await settled(first);

    lose(phone);
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

  it("checks each saved login again at launch", async () => {
    const phone = newPhone();
    const first = launch(phone);
    await first.restore();
    const connected = await first.connect(xtream());

    if (connected.kind !== "connected") throw new Error("not connected");
    await settled(first);

    // The provider no longer accepts the saved password, as after it was changed elsewhere.
    phone.sealed.set(connected.id, { kind: "xtream", ...xtreamAccount(), password: "changed" });
    const relaunched = launch(phone);
    await relaunched.restore();

    expect((await settled(relaunched))[0]?.channels).toMatchObject({
      kind: "failed",
      error: { kind: "invalid-login" },
    });
  });

  it("erases every saved login no source names at launch, as after a damaged list", async () => {
    const phone = newPhone();
    const first = launch(phone);
    await first.restore();
    await first.connect(xtream());
    await settled(first);

    phone.files.set("sources.json", "{ damaged");
    const relaunched = launch(phone);
    await relaunched.restore();

    expect(listed(relaunched)).toEqual([]);
    expect(phone.sealed.size).toBe(0);
  });

  it("keeps no login when the list of sources can't be written", async () => {
    const phone = newPhone();
    const owner = launch(phone);
    await owner.restore();

    phone.full = true;
    expect(await owner.connect(xtream())).toMatchObject({ kind: "failed" });

    expect(listed(owner)).toEqual([]);
    expect(phone.sealed.size).toBe(0);
  });

  it("saves nothing when Connect is cancelled while the provider answers", async () => {
    const phone = newPhone();
    const cancel = new AbortController();

    // Cancelled as the provider's answer to the login arrives.
    const cancelling: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);

      if (String(input).includes("player_api.php") && !String(input).includes("action="))
        cancel.abort();

      return response;
    };

    const owner = launch(phone, cancelling);
    await owner.restore();

    expect(await owner.connect(xtream(), cancel.signal)).toEqual({ kind: "cancelled" });
    expect(listed(owner)).toEqual([]);
    expect(phone.sealed.size).toBe(0);
  });

  it("removes a source while its channels load: its login is erased and a relaunch doesn't bring it back", async () => {
    const phone = newPhone();
    const owner = launch(phone);
    await owner.restore();
    await owner.connect(m3u());
    const connected = await owner.connect(xtream());

    if (connected.kind !== "connected") throw new Error("not connected");

    // Removed while its channels still load.
    await owner.remove(connected.id);

    const remaining = await settled(owner);
    expect(remaining.map((source) => source.kind)).toEqual(["m3u"]);
    expect(phone.sealed.has(connected.id)).toBe(false);

    const relaunched = launch(phone);
    await relaunched.restore();
    expect((await settled(relaunched)).map((source) => source.kind)).toEqual(["m3u"]);
  });

  it("saves nothing when Connect is cancelled while the login is being saved", async () => {
    const phone = newPhone();
    const owner = launch(phone);
    await owner.restore();
    const cancel = new AbortController();
    let release = () => {};

    const started = new Promise<void>((resolve) => {
      phone.hold = { started: resolve, until: new Promise((done) => (release = done)) };
    });

    const connecting = owner.connect(xtream(), cancel.signal);
    await started;
    cancel.abort();
    release();

    expect(await connecting).toEqual({ kind: "cancelled" });
    expect(listed(owner)).toEqual([]);
    expect(phone.sealed.size).toBe(0);
  });

  it("keeps an earlier source's channels that arrive while another source's login is saved", async () => {
    const phone = newPhone();
    let showList = () => {};
    const listHeld = new Promise<void>((resolve) => (showList = resolve));

    const held: typeof fetch = async (input, init) => {
      if (String(input).includes("get_live_streams")) await listHeld;

      return fetch(input, init);
    };

    const owner = launch(phone, held);
    await owner.restore();
    await owner.connect(xtream());

    let release = () => {};

    const started = new Promise<void>((resolve) => {
      phone.hold = { started: resolve, until: new Promise((done) => (release = done)) };
    });

    const adding = owner.connect(m3u());
    await started;
    showList();
    await expect.poll(() => listed(owner)[0]?.channels.kind).toBe("ready");
    release();
    await adding;

    const [panelSource, playlistSource] = await settled(owner);
    expect(rowCount(panelSource)).toBeGreaterThan(0);
    expect(rowCount(playlistSource)).toBeGreaterThan(0);
  });

  describe.each([
    ["Try again", (owner: SourcesOwner, id: string) => void owner.retry(id)],
    ["the same login connected again", (owner: SourcesOwner) => void owner.connect(xtream())],
  ])("after %s", (_, again) => {
    it.each(["fails", "answers"] as const)(
      "drops the earlier channel list that %s late",
      async (late) => {
        // The first channel list asked for is held, every other request answers; released, it
        // fails or answers as the provider would, whatever its signal says.
        let release = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));
        onTestFinished(() => release());
        let asked = 0;
        let open = 0;

        const holding: typeof fetch = async (input, init) => {
          open++;

          try {
            if (String(input).includes("get_live_streams") && asked++ === 0) {
              await held;

              if (late === "fails") throw new TypeError("Network request failed");

              return await fetch(input);
            }

            return await fetch(input, init);
          } finally {
            open--;
          }
        };

        const owner = launch(newPhone(), holding);
        await owner.restore();
        const connected = await owner.connect(xtream());

        if (connected.kind !== "connected") throw new Error("not connected");
        // Only the held list is left of the first load.
        await expect.poll(() => [asked, open]).toEqual([1, 1]);

        again(owner, connected.id);
        await expect.poll(() => rowCount(listed(owner)[0])).toBeGreaterThan(0);
        const shown = listed(owner)[0]?.channels;
        release();
        await expect.poll(() => open).toBe(0);
        // A source connected after the late answer, and listed, leaves it time to have shown too.
        await owner.connect(m3u());
        await expect.poll(() => rowCount(listed(owner)[1])).toBeGreaterThan(0);

        expect(listed(owner)[0]?.channels).toBe(shown);
      },
    );
  });

  it("keeps a source it erased but couldn't forget listed, and removes it on a second try", async () => {
    const phone = newPhone();
    const owner = launch(phone);
    await owner.restore();
    const connected = await owner.connect(xtream());

    if (connected.kind !== "connected") throw new Error("not connected");
    await settled(owner);

    phone.full = true;
    await expect(owner.remove(connected.id)).rejects.toThrow();
    expect(phone.sealed.has(connected.id)).toBe(false);
    expect(listed(owner)).toEqual([
      expect.objectContaining({ channels: expect.objectContaining({ kind: "failed" }) }),
    ]);

    phone.full = false;
    await owner.remove(connected.id);
    expect(listed(owner)).toEqual([]);
    const relaunched = launch(phone);
    await relaunched.restore();
    expect(listed(relaunched)).toEqual([]);
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

it("keeps the last listed channels through repeated failed and in-flight retries", async () => {
  let fail = false;
  let release = () => {};
  let held: Promise<void> | null = null;
  onTestFinished(() => release());

  const flaky: typeof fetch = async (input, init) => {
    if (String(input).includes("get_live_streams") && fail) {
      await held;
      throw new TypeError("Network request failed");
    }

    return fetch(input, init);
  };

  const owner = launch(newPhone(), flaky);
  await owner.restore();
  const connected = await owner.connect(xtream());

  if (connected.kind !== "connected") throw new Error("not connected");
  const before = (await settled(owner))[0]?.channels;

  if (before?.kind !== "ready") throw new Error("no channels");
  expect(before.rows.length).toBeGreaterThan(0);
  fail = true;
  owner.retry(connected.id);
  expect(listed(owner)[0]?.channels).toEqual({ kind: "loading", channels: before.rows });
  expect((await settled(owner))[0]?.channels).toMatchObject({
    kind: "failed",
    error: { kind: "unreachable" },
    channels: before.rows,
  });
  held = new Promise<void>((resolve) => {
    release = resolve;
  });
  owner.retry(connected.id);
  expect(listed(owner)[0]?.channels).toEqual({ kind: "loading", channels: before.rows });
  owner.retry(connected.id);
  expect(listed(owner)[0]?.channels).toEqual({ kind: "loading", channels: before.rows });
  release();
  expect((await settled(owner))[0]?.channels).toMatchObject({
    kind: "failed",
    channels: before.rows,
  });
});

it.each(["remove", "replace", "partial-remove"] as const)(
  "drops retained channels on %s and ignores the old retry's late completion",
  async (action) => {
    const phone = newPhone();
    let mode: "normal" | "held" | "fail" = "normal";
    let release = () => {};
    let started = () => {};

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const asked = new Promise<void>((resolve) => {
      started = resolve;
    });

    onTestFinished(() => release());
    let open = 0;

    const fetching: typeof fetch = async (input, init) => {
      if (!String(input).includes("get_live_streams")) return fetch(input, init);

      if (mode === "fail") throw new TypeError("Network request failed");

      if (mode === "normal") return fetch(input, init);
      open++;
      started();

      try {
        await held;

        return await fetch(input);
      } finally {
        open--;
      }
    };

    const owner = launch(phone, fetching);
    await owner.restore();
    const connected = await owner.connect(xtream());

    if (connected.kind !== "connected") throw new Error("not connected");
    const before = (await settled(owner))[0]?.channels;

    if (before?.kind !== "ready") throw new Error("no channels");
    mode = "held";
    owner.retry(connected.id);
    await asked;
    expect(listed(owner)[0]?.channels).toEqual({ kind: "loading", channels: before.rows });
    mode = "fail";

    if (action === "replace") {
      expect(await owner.connect(xtream())).toMatchObject({ kind: "connected" });
      expect((await settled(owner))[0]?.channels).toEqual({
        kind: "failed",
        error: expect.objectContaining({ kind: "unreachable" }),
      });
    } else if (action === "partial-remove") {
      phone.full = true;
      await expect(owner.remove(connected.id)).rejects.toThrow();
      expect(listed(owner)[0]?.channels).toEqual({
        kind: "failed",
        error: { kind: "needs-secret", subscriptionId: connected.id },
      });
      phone.full = false;
    } else {
      await owner.remove(connected.id);
      expect(listed(owner)).toEqual([]);
    }

    const current = listed(owner);
    release();
    await expect.poll(() => open).toBe(0);
    // Listing another source gives the old completion a turn to publish if it were still admitted.
    await owner.connect(m3u());
    await settled(owner);
    expect(listed(owner).filter((source) => source.id === connected.id)).toEqual(current);
  },
);

it("re-enters a provider with changed account details into the same source", async () => {
  const phone = newPhone();
  const owner = launch(phone);
  await owner.restore();
  const first = await owner.connect(xtream());

  if (first.kind !== "connected") throw Error("fixture did not connect");
  await settled(owner);
  const replaced = await owner.connect(m3u(), undefined, first.id);
  expect(replaced).toEqual({ kind: "connected", id: first.id });
  const rows = await settled(owner);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(first.id);
  expect(phone.sealed.size).toBe(1);
  const restarted = launch(phone);
  await restarted.restore();
  expect((await settled(restarted)).map(({ id }) => id)).toEqual([first.id]);
});
