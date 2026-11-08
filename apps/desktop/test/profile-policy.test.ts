import { collectionsHandlers } from "../src/main/handlers/collections.ts";
import { type } from "arktype";
import { playbackHandlers } from "../src/main/handlers/playback.ts";
import { outputHandlers } from "../src/main/handlers/output.ts";
import { Updates } from "../src/main/services/updates.ts";
import { updateHandlers } from "../src/main/handlers/updates.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Output } from "../src/main/services/output.ts";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { analyticsFixture } from "./e2e/analytics-fixture.ts";
import { Failed } from "@mrstreamer/core/failure";
import type { FakeProvider, FakeProviderOptions } from "./fake-provider.ts";
import { startFakeTmdb } from "./fake-tmdb.ts";
import { defined } from "@mrstreamer/core/defined";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import * as Effect from "effect/Effect";
import { mainLayer } from "../src/main/runtime.ts";
import { ProfileSessions } from "../src/main/services/profiles.ts";
import { profileHandlers } from "../src/main/handlers/profiles.ts";
import { libraryHandlers } from "../src/main/handlers/library.ts";
import { titleHandlers } from "../src/main/handlers/titles.ts";
import { viewingHandlers } from "../src/main/handlers/viewing.ts";
import { guideHandlers } from "../src/main/handlers/guide.ts";
import { downloadHandlers } from "../src/main/handlers/downloads.ts";
import { recordingHandlers } from "../src/main/handlers/recordings.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Downloads } from "../src/main/services/downloads.ts";
import { Recordings } from "../src/main/services/recordings.ts";
import { Reminders, type Notifier } from "../src/main/services/reminders.ts";
import { reminderHandlers } from "../src/main/handlers/reminders.ts";
import { Guide } from "@mrstreamer/core/guide/service";
import { DatabaseSync } from "node:sqlite";
import { registerIpc, type IpcHandlers } from "../src/main/ipc.ts";
import type { IpcInput, IpcMethod } from "@mrstreamer/contracts/ipc";
import type { ActiveProfile, ProfileRequest } from "@mrstreamer/contracts/profiles";
import type { Json } from "@mrstreamer/contracts/json";
import type { Result } from "@mrstreamer/contracts/errors";
import type { IpcMainInvokeEvent } from "electron";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeFor, tempDir, testConfig, fakeProvider, demoLogin } from "./support.ts";

describe("kids policy public commands", () => {
  it("requires the PIN for management and leaving a kids profile", async () => {
    const dataDir = await tempDir();

    const app = runtimeFor(
      mainLayer({
        ...testConfig(dataDir),
        profiles: {
          consent: { read: Effect.succeed(true), write: () => Effect.void },
          stopInteractive: () => Effect.void,
        },
      }),
    );

    const sessions = await app.runPromise(ProfileSessions);
    const commands = profileHandlers({ profiles: sessions, sessions, enabled: true });
    const adult = await app.runPromise(sessions.active);

    const kid = await app.runPromise(
      commands["profiles.create"]({ name: "Kids", current: adult }, "test"),
    );

    await app.runPromise(
      commands["profiles.setPolicy"](
        { current: adult, newPin: "1234", profiles: [{ id: kid.id, approved: [] }] },
        "test",
      ),
    );

    const current = await app.runPromise(
      commands["profiles.switch"]({ id: kid.id, current: adult }, "test"),
    );

    expect(
      (
        await app.runPromiseExit(
          commands["profiles.switch"]({ id: adult.id, current, pin: "0000" }, "test"),
        )
      )._tag,
    ).toBe("Failure");
    expect(await app.runPromise(sessions.active)).toEqual(current);
    expect(
      (await app.runPromiseExit(commands["profiles.create"]({ name: "Escape", current }, "test")))
        ._tag,
    ).toBe("Failure");
    expect(
      await app.runPromise(
        commands["profiles.switch"]({ id: adult.id, current, pin: "1234" }, "test"),
      ),
    ).toMatchObject({ id: adult.id });
    const back = await app.runPromise(sessions.active);
    expect(
      (
        await app.runPromiseExit(
          commands["profiles.remove"]({ id: kid.id, current: back, pin: "0000" }, "test"),
        )
      )._tag,
    ).toBe("Failure");
    await app.runPromise(
      commands["profiles.remove"]({ id: kid.id, current: back, pin: "1234" }, "test"),
    );
    expect(
      await app.runPromise(commands["profiles.policy"]({ current: back, pin: "1234" }, "test")),
    ).toEqual({ protected: true, profiles: [] });
  });
});

const boundary = vi.hoisted(
  () =>
    new Map<
      string,
      (
        event: IpcMainInvokeEvent,
        raw: Json | ProfileRequest<IpcInput<IpcMethod>> | undefined,
      ) => Promise<Result<unknown>>
    >(),
);

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      method: string,
      handler: (
        event: IpcMainInvokeEvent,
        raw: Json | ProfileRequest<IpcInput<IpcMethod>> | undefined,
      ) => Promise<Result<unknown>>,
    ) => boundary.set(method, handler),
  },
}));

const { start: startAnalytics } = analyticsFixture({
  app_version: "0.0.24",
  build_channel: "nightly",
  update_channel: "stable",
  os: "linux",
  arch: "x64",
  distribution: "direct",
});

async function fixture(
  options: {
    live?: boolean;
    notifier?: Notifier;
    now?: number;
    guideXml?: (provider: FakeProvider) => string;
    titlesOf?: FakeProviderOptions["titlesOf"];
    tmdb?: { readonly key: string; readonly api: string };
  } = {},
) {
  const dataDir = await tempDir();
  let stop = () => Effect.void;
  const { owner: analytics } = await startAnalytics({ dataDir, transport: null });

  const config = {
    ...testConfig(dataDir),
    ...defined({
      notifier: options.notifier,
      tmdbKey: options.tmdb?.key,
      tmdbApi: options.tmdb?.api,
    }),
    profiles: {
      consent: { read: Effect.succeed(true), write: () => Effect.void },
      stopInteractive: () => stop(),
    },
  };

  const layer = mainLayer(config);

  const app = runtimeFor(
    options.now === undefined
      ? layer
      : layer.pipe(
          Layer.provideMerge(
            Layer.effectDiscard(TestClock.setTime(options.now)).pipe(
              Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })),
            ),
          ),
        ),
  );

  const sessions = await app.runPromise(ProfileSessions);
  const adult = await app.runPromise(sessions.active);
  const kid = await app.runPromise(sessions.create("Kids", adult));

  const provider = await fakeProvider({
    maxConnections: 3,
    live: options.live ?? false,
    ...defined({ titlesOf: options.titlesOf }),
  });

  // Subscription startup may download the guide before the fixture returns.
  if (options.guideXml) provider.serveGuide(options.guideXml(provider));

  const roster = await app.runPromise(Roster);
  const subscriptions = await app.runPromise(Subscriptions);
  const settings = await app.runPromise(Settings);
  const library = await app.runPromise(Library);
  const onDemand = await app.runPromise(OnDemand);
  const playback = await app.runPromise(Playback);
  const output = await app.runPromise(Output);
  const coordination = await app.runPromise(PlaybackCoordination);
  stop = () => Effect.andThen(playback.closeForProfile, output.disconnect);
  const downloads = await app.runPromise(Downloads);
  const recordings = await app.runPromise(Recordings);
  const guide = await app.runPromise(Guide);
  const reminders = await app.runPromise(Reminders);
  const source = await app.runPromise(roster.add(demoLogin(provider)));
  await app.runPromise(library.refresh(source.id));
  await app.runPromise(onDemand.refresh(source.id));
  const personal = await app.runPromise(sessions.admit);
  const lifecycle = profileHandlers({ profiles: sessions, sessions, enabled: true });

  const updates = await app.runPromise(Updates);

  const base: Partial<IpcHandlers> = {
    ...collectionsHandlers({
      collections: personal.services.collections,
      current: personal.current,
    }),
    ...updateHandlers({ updates, storeReview: null }),
    ...lifecycle,
    ...playbackHandlers({
      playback,
      coordination,
      library,
      onDemand,
      downloads,
      recordings,
      output,
      settings,
      analytics,
      profiles: sessions,
    }),
    ...outputHandlers({
      output,
      coordination,
      library,
      onDemand,
      settings,
      analytics,
      profiles: sessions,
      pickList: () => output.status,
    }),
    ...libraryHandlers({ library, subscriptions, roster, settings }),
    ...guideHandlers({ library, guide }),
    ...titleHandlers({
      onDemand,
      subscriptions,
      roster,
      watchlist: personal.services.watchlist,
      viewing: personal.services.viewing,
    }),
    ...viewingHandlers({ viewing: personal.services.viewing, settings }),
    ...downloadHandlers({ downloads, chooseFolder: async () => null }),
    ...recordingHandlers({
      recordings,
      library,
      settings,
      chooseFolder: async () => null,
      openFolder: async () => {},
    }),
    ...reminderHandlers({ reminders }),
  };

  registerIpc(app.runPromiseExit, base as IpcHandlers, () => true, {
    admit: sessions.admitFor,
    handlers: (admitted) => ({
      ...collectionsHandlers({
        collections: admitted.services.collections,
        current: admitted.current,
      }),
      ...playbackHandlers({
        playback,
        coordination,
        library,
        onDemand,
        downloads,
        recordings,
        output,
        settings: admitted.services.settings,
        analytics,
        profiles: { active: Effect.succeed(admitted.owner) },
      }),
      ...outputHandlers({
        output,
        coordination,
        library,
        onDemand,
        settings: admitted.services.settings,
        analytics,
        profiles: { active: Effect.succeed(admitted.owner) },
        pickList: () => output.status,
      }),
      ...viewingHandlers({
        viewing: admitted.services.viewing,
        settings: admitted.services.settings,
      }),
      ...titleHandlers({
        onDemand,
        subscriptions,
        roster,
        watchlist: admitted.services.watchlist,
        viewing: admitted.services.viewing,
      }),
    }),
  });
  const frame = { processId: 1, routingId: 1 };
  const event = { sender: { mainFrame: frame }, senderFrame: frame } as IpcMainInvokeEvent;

  const call = <M extends IpcMethod>(owner: ActiveProfile, method: M, input: IpcInput<M>) =>
    boundary.get(method)!(event, { __profile: owner, input });

  return {
    app,
    dataDir,
    sessions,
    adult,
    kid,
    source,
    provider,
    library,
    onDemand,
    downloads,
    recordings,
    guide,
    reminders,
    call,
  };
}

it("filters real public browse/history/metadata and denies direct forbidden writes and opens", async () => {
  const f = await fixture();
  const allowed = { subscriptionId: f.source.id, id: "2014" };
  const forbidden = { subscriptionId: f.source.id, id: "2015" };
  await f.app.runPromise(
    f.sessions.setPolicy({
      current: f.adult,
      newPin: "1234",
      profiles: [
        {
          id: f.kid.id,
          approved: [
            { kind: "channel", ...allowed },
            { kind: "movie", subscriptionId: f.source.id, id: "90001" },
          ],
        },
      ],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));
  const listed = await f.call(kid, "library.channels", {});
  expect(listed).toMatchObject({ ok: true, value: [{ subscriptionId: f.source.id, id: "2014" }] });

  if (listed.ok) expect(listed.value).toHaveLength(1);
  expect(
    await f.call(kid, "library.browse", {
      scope: { kind: "all" },
      filters: { browseTopics: [], countries: [], languages: [], subscriptions: [] },
      visibility: "viewer",
    }),
  ).toMatchObject({ ok: true, value: { total: 1, channels: [{ id: "2014" }] } });
  expect(
    await f.call(kid, "guide.schedule", { channel: forbidden, from: 0, until: 1000 }),
  ).toMatchObject({ ok: false });
  expect(await f.call(kid, "library.channel", { channel: forbidden })).toMatchObject({ ok: false });
  expect(
    await f.call(kid, "library.channel", {
      channel: { ...allowed, subscriptionId: "another-source" },
    }),
  ).toMatchObject({ ok: false });
  expect(
    await f.call(kid, "viewing.setFavourite", {
      commandId: "denied",
      channel: forbidden,
      favourite: true,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await f.call(kid, "viewing.setFavourite", {
      commandId: "allowed",
      channel: allowed,
      favourite: true,
    }),
  ).toMatchObject({ ok: true, value: { favourites: [allowed] } });
  expect(await f.call(kid, "viewing.get", undefined)).toMatchObject({
    ok: true,
    value: { favourites: [allowed], recent: [], continueWatching: [] },
  });
  expect(
    await f.call(kid, "ondemand.details", {
      kind: "movie",
      version: { subscriptionId: f.source.id, id: "90002" },
    }),
  ).toMatchObject({ ok: false });
  const movies = await f.call(kid, "ondemand.search", { query: "" });
  expect(movies).toMatchObject({ ok: true });

  if (movies.ok) expect(JSON.stringify(movies.value)).not.toContain("90002");
  expect(
    await f.call(kid, "playback.openTitle", {
      title: { kind: "movie", subscriptionId: f.source.id, id: "90002" },
      decoders: [],
    }),
  ).toMatchObject({
    ok: false,
    error: { detail: "Kids policy: this content or action is not approved." },
  });
  expect(
    await f.call(kid, "downloads.add", {
      title: { kind: "movie", subscriptionId: f.source.id, id: "90002" },
    }),
  ).toMatchObject({ ok: false });
  expect(
    await f.call(kid, "output.openTitle", {
      title: { kind: "movie", subscriptionId: f.source.id, id: "90002" },
      since: Date.now(),
    }),
  ).toMatchObject({
    ok: false,
    error: { detail: "Kids policy: this content or action is not approved." },
  });
  expect(await f.call(kid, "downloads.list", undefined)).toMatchObject({
    ok: true,
    value: { items: [] },
  });
});

it.each(["success", "refusal"] as const)(
  "fails closed on unreadable policy and rejects a late adult %s after switching away and back",
  async (outcome) => {
    const f = await fixture();
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    // Hold the real catalogue read at its external provider-independent completion, after admission.
    const original = f.library.channels;
    let held = true;
    f.library.channels = (input) =>
      Effect.gen(function* () {
        const result = yield* original(input);

        if (held) {
          held = false;
          arrived.resolve();
          yield* Effect.promise(() => release.promise);

          if (outcome === "refusal")
            return yield* new Failed({
              error: { kind: "unexpected", detail: "Restricted title failure" },
            });
        }

        return result;
      });
    const pending = f.call(f.adult, "library.channels", {});
    await arrived.promise;
    const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));
    const back = await f.app.runPromise(f.sessions.switch(f.adult.id, kid));
    release.resolve();
    expect(await pending).toMatchObject({
      ok: false,
      error: { detail: "Viewing profile changed; retry this request." },
    });
    expect(await f.call(back, "library.channels", {})).toMatchObject({ ok: true });
    const database = { db: new DatabaseSync(join(f.dataDir, "mrstreamer.db")) };
    onTestFinished(() => database.db.close());
    const saved = database.db.prepare("SELECT value FROM kids_policy WHERE id = 1").get()!.value;
    database.db.prepare("UPDATE kids_policy SET value = ? WHERE id = 1").run("broken");
    expect(await f.call(back, "library.channels", {})).toMatchObject({ ok: false });
    expect((await f.app.runPromiseExit(f.sessions.create("Escape", back)))._tag).toBe("Failure");
    expect(database.db.prepare("SELECT value FROM kids_policy WHERE id = 1").get()!.value).toBe(
      "broken",
    );
    database.db.prepare("UPDATE kids_policy SET value = ? WHERE id = 1").run(saved!);
    expect(await f.call(back, "library.channels", {})).toMatchObject({ ok: true });
  },
);

it("hides a running household recording without stopping its stream and retains safe stop", async () => {
  const f = await fixture({ live: true });

  const channel = f.provider.catalogue.channels.find(
    (item) => item.fixture === "h264-subtitles.mpegts",
  )!;

  const started = await f.call(f.adult, "recordings.start", {
    channel: { subscriptionId: f.source.id, id: String(channel.streamId) },
    stop: Date.now() + 60_000,
  });

  expect(started).toMatchObject({ ok: true, value: { kind: "started" } });
  const [recording] = await f.app.runPromise(f.recordings.list);

  if (!recording) throw new Error("No recording started");
  const requests = f.provider.streamRequests();

  const permitted = f.provider.catalogue.channels.find(
    (item) => item.fixture === "h264-aac.mpegts",
  )!;

  const permittedChannel = { subscriptionId: f.source.id, id: String(permitted.streamId) };
  await f.app.runPromise(
    f.sessions.setPolicy({
      current: f.adult,
      newPin: "1234",
      profiles: [{ id: f.kid.id, approved: [{ kind: "channel", ...permittedChannel }] }],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));
  expect(await f.call(kid, "recordings.list", undefined)).toEqual({ ok: true, value: [] });
  expect(
    (await f.app.runPromise(f.recordings.list)).find((item) => item.id === recording.id)?.status
      .kind,
  ).toBe("recording");
  expect(f.provider.streamRequests()).toBe(requests);
  expect(f.provider.activeStreams()).toBe(1);
  expect(
    await f.call(kid, "playback.openCopy", { copy: recording.id, decoders: [] }),
  ).toMatchObject({
    ok: false,
    error: { detail: "Kids policy: this content or action is not approved." },
  });

  const opened = await f.call(kid, "playback.open", {
    channel: permittedChannel,
    decoders: ["h264", "aac"],
  });

  expect(opened).toEqual({
    ok: true,
    value: expect.objectContaining({ sessionId: expect.any(String) }),
  });

  const session = type({ sessionId: "string" }).assert(opened.ok ? opened.value : null);
  expect(await f.call(kid, "playback.failure", { sessionId: session.sessionId })).toMatchObject({
    ok: true,
  });
  expect(await f.call(kid, "playback.diagnostic", { sessionId: session.sessionId })).toMatchObject({
    ok: true,
  });
  expect(
    await f.call(kid, "playback.diagnostic", { sessionId: "household-or-old-session" }),
  ).toEqual({ ok: true, value: null });
  expect(await f.call(kid, "playback.closeAll", undefined)).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(f.provider.activeStreams()).toBe(1));
  const policyDb = new DatabaseSync(join(f.dataDir, "mrstreamer.db"));
  const savedPolicy = policyDb.prepare("SELECT value FROM kids_policy WHERE id = 1").get()!.value;

  try {
    policyDb.prepare("UPDATE kids_policy SET value = ? WHERE id = 1").run("broken");
    expect(await f.call(kid, "recordings.list", undefined)).toMatchObject({ ok: false });
    expect(f.provider.activeStreams()).toBe(1);
    expect(
      (await f.app.runPromise(f.recordings.list)).find((item) => item.id === recording.id)?.status
        .kind,
    ).toBe("recording");
    expect(await f.call(kid, "recordings.stop", { id: recording.id })).toMatchObject({ ok: true });
  } finally {
    policyDb.prepare("UPDATE kids_policy SET value = ? WHERE id = 1").run(savedPolicy!);
    policyDb.close();
  }

  const adult = await f.app.runPromise(f.sessions.switch(f.adult.id, kid, "1234"));
  expect(
    await f.call(adult, "recordings.recordProgress", {
      id: recording.id,
      position: 5,
      duration: 100,
      owner: adult,
    }),
  ).toMatchObject({ ok: true });
  await f.app.runPromise(
    f.sessions.setPolicy({
      current: adult,
      pin: "1234",
      profiles: [{ id: f.kid.id, approved: [{ kind: "recording", id: recording.id }] }],
    }),
  );
  const viewingKid = await f.app.runPromise(f.sessions.switch(f.kid.id, adult));
  expect(
    await f.call(viewingKid, "recordings.recordProgress", {
      id: recording.id,
      position: 10,
      duration: 100,
      owner: adult,
    }),
  ).toMatchObject({
    ok: false,
    error: { detail: "Kids policy: this content or action is not approved." },
  });
  expect(
    await f.call(viewingKid, "recordings.recordProgress", {
      id: recording.id,
      position: 10,
      duration: 100,
      owner: viewingKid,
    }),
  ).toMatchObject({ ok: true });
  expect(await f.app.runPromise(f.recordings.copy(recording.id, viewingKid))).toMatchObject({
    id: recording.id,
    progress: { position: 10, duration: 100 },
  });
  const back = await f.app.runPromise(f.sessions.switch(f.adult.id, viewingKid, "1234"));
  expect(await f.app.runPromise(f.recordings.copy(recording.id, back))).toMatchObject({
    id: recording.id,
    progress: { position: 5, duration: 100 },
  });
});

it("suppresses restricted notifications and closes existing ones without changing reminder receipts", async () => {
  const shown: string[] = [];
  const closed: string[] = [];
  const now = Date.parse("2026-10-02T20:10:00+02:00");

  const guided = (provider: FakeProvider) =>
    provider.catalogue.channels.find(
      (item) => item.streamId >= 2000 && !item.offline && item.guideId && !item.adult,
    )!;

  const guideXml = (provider: FakeProvider) => {
    const channel = guided(provider);

    const programme = (start: string, stop: string, title: string) =>
      `<programme start="20261002${start}00 +0200" stop="20261002${stop}00 +0200" channel="${channel.guideId}"><title>${title}</title></programme>`;

    return `<?xml version="1.0"?><tv>${programme("2030", "2130", "Restricted first")}${programme("2130", "2300", "Restricted second")}</tv>`;
  };

  const f = await fixture({
    now,
    guideXml,
    notifier: {
      supported: true,
      show: (notice, events) => {
        shown.push(notice.title);
        events.shown();
      },
      close: (id) => {
        closed.push(id);
      },
    },
  });

  const channel = guided(f.provider);

  await f.app.runPromise(f.guide.refresh(f.source.id));
  expect(
    await f.call(f.adult, "guide.searchPage", {
      subscriptionId: f.source.id,
      query: "Restricted",
      limit: 1,
    }),
  ).toMatchObject({ ok: true, value: { matches: [{ programme: { title: "Restricted first" } }] } });

  const first = await f.call(f.adult, "reminders.set", {
    channel: { subscriptionId: f.source.id, id: String(channel.streamId) },
    start: now + 20 * 60_000,
  });

  expect(first).toMatchObject({ ok: true });
  expect(
    await f.call(f.adult, "reminders.set", {
      channel: { subscriptionId: f.source.id, id: String(channel.streamId) },
      start: now + 80 * 60_000,
    }),
  ).toMatchObject({ ok: true });
  await f.app.runPromise(TestClock.setTime(now + 20 * 60_000));
  await f.app.runPromise(f.reminders.check);
  expect(shown).toEqual(["Restricted first"]);
  await f.app.runPromise(
    f.sessions.setPolicy({
      current: f.adult,
      newPin: "1234",
      profiles: [{ id: f.kid.id, approved: [] }],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));
  await vi.waitFor(() => expect(closed).toHaveLength(1));
  expect(
    await f.call(kid, "guide.searchPage", {
      subscriptionId: f.source.id,
      query: "Restricted",
      limit: 1,
    }),
  ).toEqual({ ok: true, value: { matches: [], next: null } });
  expect(await f.call(kid, "reminders.list", undefined)).toMatchObject({
    ok: true,
    value: { reminders: [] },
  });
  await f.app.runPromise(TestClock.setTime(now + 80 * 60_000));
  await f.app.runPromise(f.reminders.check);
  expect(shown).toEqual(["Restricted first"]);
  const back = await f.app.runPromise(f.sessions.switch(f.adult.id, kid, "1234"));
  expect(await f.call(back, "reminders.list", undefined)).toMatchObject({
    ok: true,
    value: {
      reminders: expect.arrayContaining([
        expect.objectContaining({
          title: "Restricted second",
          status: { kind: "told", at: now + 80 * 60_000 },
        }),
      ]),
    },
  });
  expect(await f.call(back, "reminders.list", undefined)).toMatchObject({
    ok: true,
    value: {
      reminders: expect.arrayContaining([
        expect.objectContaining({ title: "Restricted second", banner: true }),
      ]),
    },
  });
  await f.call(back, "profiles.setPolicy", {
    current: back,
    pin: "1234",
    profiles: [
      {
        id: f.kid.id,
        approved: [{ kind: "channel", subscriptionId: f.source.id, id: String(channel.streamId) }],
      },
    ],
  });
  const approvedKid = await f.app.runPromise(f.sessions.switch(f.kid.id, back));
  const visible = await f.app.runPromise(f.reminders.list);
  const due = visible.reminders.find((reminder) => reminder.title === "Restricted second")!;
  expect(await f.call(approvedKid, "reminders.dismiss", { id: due.id })).toEqual({
    ok: true,
    value: null,
  });
  expect(await f.call(approvedKid, "reminders.list", undefined)).toMatchObject({
    ok: true,
    value: {
      reminders: expect.arrayContaining([expect.objectContaining({ id: due.id, banner: false })]),
    },
  });
  const saved = await readFile(join(f.dataDir, "reminders.json"), "utf8");
  expect(saved).toContain("Restricted second");
  expect(await f.call(approvedKid, "reminders.cancel", { id: due.id })).toEqual({
    ok: true,
    value: null,
  });
});

it("selects approved versions before grouping, artwork, counts and paging without replacing the household catalogue", async () => {
  const f = await fixture({
    titlesOf: (built) => {
      const base = built.movies.find((item) => !item.adult)!;

      return {
        ...built,
        movies: [
          { ...base, id: 90001, name: "Restricted primary", tmdb: "500" },
          { ...base, id: 90002, name: "Approved version", tmdb: "500" },
          ...Array.from({ length: 80 }, (_, index) => ({
            ...base,
            id: 91000 + index,
            name: `Title ${String(index).padStart(2, "0")}`,
            tmdb: String(100000 + index),
          })),
        ],
      };
    },
  });

  const approved = [
    { kind: "movie" as const, subscriptionId: f.source.id, id: "90002" },
    { kind: "movie" as const, subscriptionId: f.source.id, id: "91079" },
  ];

  const query = {
    kind: "movie" as const,
    id: "all" as const,
    sort: "title" as const,
    offset: 0,
    limit: 1,
  };

  const unprotectedKid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));

  for (const id of ["90001", "91000", "91079"])
    expect(
      await f.call(unprotectedKid, "watchlist.save", {
        kind: "movie",
        version: { subscriptionId: f.source.id, id },
      }),
    ).toMatchObject({ ok: true });
  const managing = await f.app.runPromise(f.sessions.switch(f.adult.id, unprotectedKid));
  const household = await f.call(managing, "ondemand.collection", { ...query, limit: 100 });
  expect(household).toMatchObject({ ok: true, value: { total: 81 } });
  await f.app.runPromise(
    f.sessions.setPolicy({
      current: managing,
      newPin: "1234",
      profiles: [{ id: f.kid.id, approved }],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, managing));
  expect(await f.call(kid, "ondemand.collection", query)).toMatchObject({
    ok: true,
    value: {
      total: 2,
      titles: [
        {
          id: "90002",
          name: "Approved version",
          posterUrl: "https://image.example/p/90002.jpg",
          versions: [{ id: "90002" }],
        },
      ],
    },
  });
  expect(await f.call(kid, "ondemand.collection", { ...query, offset: 1 })).toMatchObject({
    ok: true,
    value: { total: 2, titles: [{ id: "91079" }] },
  });
  const saved = await f.call(kid, "watchlist.list", { sort: "title", offset: 0, limit: 1 });
  expect(saved).toMatchObject({
    ok: true,
    value: { total: 2, entries: [{ title: { id: "90002" }, name: "Approved version" }] },
  });

  if (saved.ok) expect(JSON.stringify(saved.value)).not.toContain("Restricted primary");
  expect(await f.call(kid, "watchlist.list", { sort: "title", offset: 1, limit: 1 })).toMatchObject(
    { ok: true, value: { total: 2, entries: [{ title: { id: "91079" } }] } },
  );
  const search = await f.call(kid, "ondemand.search", { query: "Title" });
  expect(search).toMatchObject({ ok: true, value: { movies: [{ id: "91079" }], series: [] } });

  if (search.ok) expect(JSON.stringify(search.value)).not.toContain("Restricted primary");
  expect(await f.call(kid, "ondemand.status", undefined)).toMatchObject({
    ok: true,
    value: { lists: [{ movies: 2, series: 0 }] },
  });
  const back = await f.app.runPromise(f.sessions.switch(f.adult.id, kid, "1234"));
  expect(await f.call(back, "ondemand.collection", { ...query, limit: 100 })).toEqual(household);
  await f.app.runPromise(f.sessions.setPolicy({ current: back, pin: "1234", profiles: [] }));
  const unrestricted = await f.app.runPromise(f.sessions.switch(f.kid.id, back));
  expect(
    await f.call(unrestricted, "watchlist.list", { sort: "title", offset: 0, limit: 100 }),
  ).toMatchObject({ ok: true, value: { total: 3 } });
});

it("keeps the previous policy retryable after a refused save and restores it across restart", async () => {
  const f = await fixture();
  await f.call(f.adult, "profiles.setPolicy", {
    current: f.adult,
    newPin: "1234",
    profiles: [{ id: f.kid.id, approved: [] }],
  });
  const db = new DatabaseSync(join(f.dataDir, "mrstreamer.db"));

  try {
    db.exec(
      "CREATE TRIGGER refuse_kids_policy BEFORE UPDATE ON kids_policy BEGIN SELECT RAISE(FAIL, 'refused'); END",
    );
    expect(
      await f.call(f.adult, "profiles.setPolicy", { current: f.adult, pin: "1234", profiles: [] }),
    ).toMatchObject({ ok: false });
    expect(
      await f.call(f.adult, "profiles.policy", { current: f.adult, pin: "1234" }),
    ).toMatchObject({
      ok: true,
      value: { protected: true, profiles: [{ id: f.kid.id, approved: [] }] },
    });
    db.exec("DROP TRIGGER refuse_kids_policy");
  } finally {
    db.close();
  }

  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));
  await f.app.dispose();

  const restarted = runtimeFor(
    mainLayer({
      ...testConfig(f.dataDir),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const sessions = await restarted.runPromise(ProfileSessions);
  const commands = profileHandlers({ profiles: sessions, sessions, enabled: true });
  expect(await restarted.runPromise(sessions.active)).toEqual(kid);
  expect(
    (
      await restarted.runPromiseExit(
        commands["profiles.switch"]({ id: f.adult.id, current: kid }, "test"),
      )
    )._tag,
  ).toBe("Failure");
  expect(
    await restarted.runPromise(
      commands["profiles.switch"]({ id: f.adult.id, current: kid, pin: "1234" }, "test"),
    ),
  ).toMatchObject({ id: f.adult.id });
});

it("filters exact live identities before grouped metadata", async () => {
  const f = await fixture();
  await f.app.runPromise(
    f.sessions.setPolicy({
      current: f.adult,
      newPin: "1234",
      profiles: [
        {
          id: f.kid.id,
          approved: [{ kind: "channel", subscriptionId: f.source.id, id: "100000" }],
        },
      ],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));

  expect(await f.call(kid, "library.status", undefined)).toMatchObject({
    ok: true,
    value: [{ channelCount: 1 }],
  });

  const direct = await f.call(kid, "library.channel", {
    channel: { subscriptionId: f.source.id, id: "100000" },
  });

  const browsed = await f.call(kid, "library.browse", {
    scope: { kind: "all" },
    filters: { browseTopics: [], countries: [], languages: [], subscriptions: [] },
    visibility: "viewer",
  });

  expect(browsed).toMatchObject({
    ok: true,
    value: { channels: [{ variants: [{ id: "100000" }] }] },
  });

  expect(direct).toMatchObject({ ok: true, value: { variants: [{ id: "100000" }] } });
});

it("keeps an approved noncanonical live variant visible", async () => {
  const f = await fixture();
  await f.app.runPromise(
    f.sessions.setPolicy({
      current: f.adult,
      newPin: "1234",
      profiles: [
        {
          id: f.kid.id,
          approved: [{ kind: "channel", subscriptionId: f.source.id, id: "100001" }],
        },
      ],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));

  expect(await f.call(kid, "library.status", undefined)).toMatchObject({
    ok: true,
    value: [{ channelCount: 1 }],
  });

  const direct = await f.call(kid, "library.channel", {
    channel: { subscriptionId: f.source.id, id: "100001" },
  });

  expect(direct.ok).toBe(true);
});

it("ensures Home recommendations do not publish restricted primary seed name", async () => {
  const f = await fixture({
    titlesOf: (built) => {
      const base = built.movies.find((item) => !item.adult)!;

      return {
        ...built,
        movies: [
          { ...base, id: 90001, name: "Restricted primary", tmdb: "500" },
          { ...base, id: 90002, name: "Approved version", tmdb: "500" },
          ...Array.from({ length: 40 }, (_, at) => ({
            ...base,
            id: 91000 + at,
            name: `Restricted candidate ${at}`,
            tmdb: String(10000 + at),
          })),
          { ...base, id: 90003, name: "Approved candidate", tmdb: "501" },
        ],
      };
    },
  });

  await f.app.runPromise(
    f.sessions.setPolicy({
      current: f.adult,
      newPin: "1234",
      profiles: [
        {
          id: f.kid.id,
          approved: [
            { kind: "movie", subscriptionId: f.source.id, id: "90002" },
            { kind: "movie", subscriptionId: f.source.id, id: "90003" },
          ],
        },
      ],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));

  const result = await f.call(kid, "ondemand.recommendations", {
    seeds: [{ kind: "movie", version: { subscriptionId: f.source.id, id: "90002" } }],
  });

  expect(result).toMatchObject({
    ok: true,
    value: [{ seed: "Approved version", title: { id: "90003" } }],
  });
  expect(JSON.stringify(result)).not.toContain("Restricted primary");
});

it("keeps adult replies valid when only an inactive kids policy changes", async () => {
  const f = await fixture();
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());
  const original = f.library.channels;
  f.library.channels = (input) =>
    Effect.gen(function* () {
      const result = yield* original(input);
      arrived.resolve();
      yield* Effect.promise(() => release.promise);

      return result;
    });
  const pending = f.call(f.adult, "library.channels", {});
  await arrived.promise;
  await f.call(f.adult, "profiles.setPolicy", {
    current: f.adult,
    newPin: "1234",
    profiles: [{ id: f.kid.id, approved: [] }],
  });
  release.resolve();
  expect(await pending).toMatchObject({ ok: true });
});

it("lets kids remove a saved approved title and read safe guide/update state", async () => {
  const f = await fixture();
  await f.call(f.adult, "profiles.setPolicy", {
    current: f.adult,
    newPin: "1234",
    profiles: [
      { id: f.kid.id, approved: [{ kind: "movie", subscriptionId: f.source.id, id: "90001" }] },
    ],
  });
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));
  const entry = { subscriptionId: f.source.id, id: "90001" };
  const saved = await f.call(kid, "watchlist.save", { kind: "movie", version: entry });
  expect(saved).toMatchObject({ ok: true });

  const membership = type({ subscriptionId: "string", id: "string" }).assert(
    saved.ok ? saved.value : null,
  );

  expect(await f.call(kid, "watchlist.remove", { entry: membership })).toMatchObject({ ok: true });
  expect(
    await f.call(kid, "watchlist.list", { sort: "title", offset: 0, limit: 10 }),
  ).toMatchObject({ ok: true, value: { total: 0 } });
  expect(await f.call(kid, "guide.savedQueries", { subscriptionId: f.source.id })).toEqual({
    ok: true,
    value: [],
  });
  expect(await f.call(kid, "updates.status", undefined)).toMatchObject({ ok: true });
});

it("preserves deletion tombstone policy rows when an adult saves other policies", async () => {
  const f = await fixture();

  const retained = {
    id: f.kid.id,
    approved: [{ kind: "movie" as const, subscriptionId: f.source.id, id: "90001" }],
  };

  await f.call(f.adult, "profiles.setPolicy", {
    current: f.adult,
    newPin: "1234",
    profiles: [retained],
  });
  const db = new DatabaseSync(join(f.dataDir, "mrstreamer.db"));

  try {
    db.exec(
      "CREATE TRIGGER refuse_policy_delete BEFORE UPDATE ON kids_policy BEGIN SELECT RAISE(FAIL, 'refused'); END",
    );
    expect(
      await f.call(f.adult, "profiles.remove", { id: f.kid.id, current: f.adult, pin: "1234" }),
    ).toMatchObject({ ok: false });
    db.exec("DROP TRIGGER refuse_policy_delete");
    expect(
      await f.call(f.adult, "profiles.setPolicy", {
        current: f.adult,
        pin: "1234",
        profiles: [{ id: f.kid.id, approved: [] }],
      }),
    ).toMatchObject({ ok: true, value: { profiles: [retained] } });

    const invalid = await f.call(f.adult, "profiles.setPolicy", {
      current: f.adult,
      pin: "1234",
      profiles: [{ id: "unknown", approved: [] }],
    });

    expect(invalid).toMatchObject({
      ok: false,
      error: { detail: "This viewing profile is unavailable or being deleted." },
    });
  } finally {
    db.close();
  }
});

it("never attempts an unapproved automatic live fallback", async () => {
  const f = await fixture();
  const before = f.provider.streamRequests();
  await f.call(f.adult, "profiles.setPolicy", {
    current: f.adult,
    newPin: "1234",
    profiles: [
      { id: f.kid.id, approved: [{ kind: "channel", subscriptionId: f.source.id, id: "100000" }] },
    ],
  });
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));

  const opened = await f.call(kid, "playback.open", {
    channel: { subscriptionId: f.source.id, id: "100000" },
    decoders: ["h264", "aac"],
  });

  expect(opened).toMatchObject({ ok: true });

  const session = type({ url: "string", sessionId: "string" }).assert(
    opened.ok ? opened.value : null,
  );

  const response = await fetch(session.url);
  expect(response.ok).toBe(false);
  expect(f.provider.streamRequests() - before).toBe(1);
  expect(await f.call(kid, "playback.failure", { sessionId: session.sessionId })).toMatchObject({
    ok: true,
    value: expect.objectContaining({ kind: expect.any(String) }),
  });
});

it("keeps household services available while a database open failure denies personal admission", async () => {
  const dataDir = await tempDir();
  await mkdir(join(dataDir, "mrstreamer.db"));

  const app = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const sessions = await app.runPromise(ProfileSessions);
  expect((await app.runPromiseExit(sessions.admit))._tag).toBe("Failure");
  const recordings = await app.runPromise(Recordings);
  expect(await app.runPromise(recordings.list)).toEqual([]);
  const reminders = await app.runPromise(Reminders);
  expect(await app.runPromise(reminders.list)).toMatchObject({ reminders: [] });
});

it("keeps collection memberships exact and filters restricted versions before labels, artwork, counts and pages", async () => {
  const f = await fixture({
    titlesOf: (built) => {
      const base = built.movies.find((item) => !item.adult)!;

      return {
        ...built,
        movies: [
          { ...base, id: 90001, name: "Restricted primary", tmdb: "500" },
          { ...base, id: 90002, name: "Approved version", tmdb: "500" },
          { ...base, id: 90003, name: "Approved later", tmdb: "501" },
          { ...base, id: 90011, name: "Adult secret", adult: true, tmdb: "502" },
        ],
      };
    },
  });

  const unprotected = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));
  expect(
    await f.call(unprotected, "collections.change", { kind: "create", id: "one", name: "Films" }),
  ).toMatchObject({ ok: true });

  const title = (titleId: string) => ({
    sourceId: f.source.id,
    kind: "movie" as const,
    titleId,
    name: "Forged label",
    year: null,
    adult: false,
  });

  for (const titleId of ["90001", "90002", "90003"])
    expect(
      await f.call(unprotected, "collections.change", {
        kind: "member",
        id: "one",
        title: title(titleId),
        present: true,
      }),
    ).toMatchObject({ ok: true });
  const adult = await f.app.runPromise(f.sessions.switch(f.adult.id, unprotected));
  await f.app.runPromise(
    f.sessions.setPolicy({
      current: adult,
      newPin: "1234",
      profiles: [
        {
          id: f.kid.id,
          approved: ["90002", "90003", "90011"].map((id) => ({
            kind: "movie",
            subscriptionId: f.source.id,
            id,
          })),
        },
      ],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, adult));
  expect(await f.call(kid, "collections.list", undefined)).toEqual({
    ok: true,
    value: [{ id: "one", name: "Films", total: 2 }],
  });
  const page = await f.call(kid, "collections.page", { id: "one", offset: 0, limit: 1 });
  expect(page).toMatchObject({
    ok: true,
    value: {
      total: 2,
      members: [
        {
          titleId: "90002",
          name: "Approved version",
          available: true,
          title: {
            id: "90002",
            posterUrl: "https://image.example/p/90002.jpg",
            versions: [{ id: "90002" }],
          },
        },
      ],
    },
  });
  expect(JSON.stringify(page)).not.toContain("Restricted primary");
  expect(await f.call(kid, "collections.page", { id: "one", offset: 1, limit: 1 })).toMatchObject({
    ok: true,
    value: { total: 2, members: [{ titleId: "90003" }] },
  });
  expect(await f.call(kid, "collections.memberships", title("90002"))).toEqual({
    ok: true,
    value: ["one"],
  });
  expect(
    await f.call(kid, "collections.change", {
      kind: "member",
      id: "one",
      title: title("90001"),
      present: true,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await f.call(kid, "collections.change", {
      kind: "member",
      id: "one",
      title: title("90011"),
      present: true,
    }),
  ).toMatchObject({ ok: false });
  const promoted = f.provider.titles.movies.find((movie) => movie.id === 90002)!;
  const before = { ...promoted };
  onTestFinished(() => {
    Object.assign(promoted, before);
  });
  Object.assign(promoted, { adult: true, categoryId: "505" });
  await f.app.runPromise(f.onDemand.refresh(f.source.id));
  expect(await f.call(kid, "collections.page", { id: "one", offset: 0, limit: 48 })).toMatchObject({
    ok: true,
    value: { total: 1, members: [{ titleId: "90003" }] },
  });
  expect(await f.call(unprotected, "collections.list", undefined)).toMatchObject({ ok: false });
  const managing = await f.app.runPromise(f.sessions.switch(f.adult.id, kid, "1234"));
  await f.app.runPromise(f.sessions.setPolicy({ current: managing, pin: "1234", profiles: [] }));
  const unrestricted = await f.app.runPromise(f.sessions.switch(kid.id, managing));
  const admission = await f.app.runPromise(f.sessions.admitFor(unrestricted));
  await f.app.runPromise(admission.run(admission.services.settings.update({ adultTitles: true })));
  expect(
    await f.call(unrestricted, "collections.change", {
      kind: "member",
      id: "one",
      title: title("90011"),
      present: true,
    }),
  ).toMatchObject({ ok: true });
  expect(
    await f.call(unrestricted, "collections.page", { id: "one", offset: 0, limit: 48 }),
  ).toMatchObject({
    ok: true,
    value: {
      total: 4,
      members: expect.arrayContaining([expect.objectContaining({ titleId: "90011", adult: true })]),
    },
  });
});

it("refuses pending, failed and stale collection reads and never commits a late policy mutation", async () => {
  const f = await fixture();
  const titles = await f.app.runPromise(f.onDemand.search("TEST"));
  const movie = titles.movies[0]!;

  const title = {
    sourceId: movie.subscriptionId,
    kind: movie.kind,
    titleId: movie.id,
    name: "Forged",
    year: null,
    adult: false,
  };

  expect(
    await f.call(f.adult, "collections.change", { kind: "create", id: "one", name: "Films" }),
  ).toMatchObject({ ok: true });
  const original = f.onDemand.titles;
  const originalStatus = f.onDemand.status;
  onTestFinished(() => {
    f.onDemand.titles = original;
    Object.defineProperty(f.onDemand, "status", { value: originalStatus, configurable: true });
  });
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());
  f.onDemand.titles = (...args) =>
    Effect.gen(function* () {
      const answer = yield* original(...args);
      arrived.resolve();
      yield* Effect.promise(() => release.promise);

      return answer;
    });

  const pending = f.call(f.adult, "collections.change", {
    kind: "member",
    id: "one",
    title,
    present: true,
  });

  await arrived.promise;
  await f.app.runPromise(
    f.sessions.setPolicy({
      current: f.adult,
      newPin: "1234",
      profiles: [{ id: f.kid.id, approved: [] }],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));
  release.resolve();
  expect(await pending).toMatchObject({ ok: false });
  f.onDemand.titles = original;
  const back = await f.app.runPromise(f.sessions.switch(f.adult.id, kid, "1234"));
  expect(await f.call(back, "collections.page", { id: "one", offset: 0, limit: 48 })).toMatchObject(
    { ok: true, value: { total: 0 } },
  );
  expect(
    await f.call(back, "collections.change", { kind: "member", id: "one", title, present: true }),
  ).toMatchObject({ ok: true });
  const status = f.onDemand.status;
  Object.defineProperty(f.onDemand, "status", {
    value: Effect.succeed({ lists: [], metadata: null }),
    configurable: true,
  });
  expect(await f.call(back, "collections.list", undefined)).toMatchObject({
    ok: false,
    error: { kind: "unexpected" },
  });
  Object.defineProperty(f.onDemand, "status", { value: status, configurable: true });
  f.onDemand.titles = () =>
    Effect.fail(new Failed({ error: { kind: "unexpected", detail: "Read failed; retry." } }));
  expect(await f.call(back, "collections.page", { id: "one", offset: 0, limit: 48 })).toMatchObject(
    { ok: false },
  );
  f.onDemand.titles = original;
  expect(await f.call(back, "collections.list", undefined)).toMatchObject({
    ok: true,
    value: [{ total: 1 }],
  });
  const db = new DatabaseSync(join(f.dataDir, "mrstreamer.db"));
  onTestFinished(() => db.close());

  const saved = type("string").assert(
    db.prepare("SELECT value FROM kids_policy WHERE id = 1").get()!.value,
  );

  db.prepare("UPDATE kids_policy SET value = ? WHERE id = 1").run("broken");
  expect(await f.call(back, "collections.list", undefined)).toMatchObject({ ok: false });
  db.prepare("UPDATE kids_policy SET value = ? WHERE id = 1").run(saved);
});

it("isolates collection owners, reconnects exact account membership and erases every profile", async () => {
  const f = await fixture();
  const movie = (await f.app.runPromise(f.onDemand.search("TEST"))).movies[0]!;

  const title = {
    sourceId: f.source.id,
    kind: movie.kind,
    titleId: movie.id,
    name: movie.title,
    year: movie.year,
    adult: false,
  };

  for (const owner of [f.adult, await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult))]) {
    const current =
      owner.id === f.adult.id
        ? await f.app.runPromise(f.sessions.switch(f.adult.id))
        : await f.app.runPromise(f.sessions.switch(f.kid.id));

    expect(await f.call(current, "collections.list", undefined)).toEqual({ ok: true, value: [] });
    expect(
      await f.call(current, "collections.change", { kind: "create", id: "one", name: owner.id }),
    ).toMatchObject({ ok: true });
    expect(
      await f.call(current, "collections.change", {
        kind: "member",
        id: "one",
        title,
        present: true,
      }),
    ).toMatchObject({ ok: true });
  }

  const adult = await f.app.runPromise(f.sessions.switch(f.adult.id));
  const roster = await f.app.runPromise(Roster);
  await f.app.runPromise(roster.remove(f.source.id, false));
  const source = await f.app.runPromise(roster.add(demoLogin(f.provider)));
  await f.app.runPromise(f.onDemand.refresh(source.id));
  expect(await f.call(adult, "collections.memberships", { ...title, sourceId: source.id })).toEqual(
    { ok: true, value: ["one"] },
  );
  await f.app.runPromise(roster.remove(source.id, true));
  const restored = await f.app.runPromise(roster.add(demoLogin(f.provider)));
  await f.app.runPromise(f.onDemand.refresh(restored.id));

  expect(await f.call(adult, "collections.list", undefined)).toMatchObject({
    ok: true,
    value: [{ total: 0 }],
  });
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, adult));
  expect(await f.call(kid, "collections.list", undefined)).toMatchObject({
    ok: true,
    value: [{ total: 0 }],
  });
  const back = await f.app.runPromise(f.sessions.switch(f.adult.id, kid));
  expect(await f.call(back, "profiles.remove", { id: f.kid.id, current: back })).toMatchObject({
    ok: true,
  });
  expect(await f.call(kid, "collections.list", undefined)).toMatchObject({ ok: false });
});

it("refuses a suspended collection mutation after the same owner's durable approvals change", async () => {
  const f = await fixture();
  const movie = (await f.app.runPromise(f.onDemand.search("TEST"))).movies[0]!;

  const title = {
    sourceId: f.source.id,
    kind: movie.kind,
    titleId: movie.id,
    name: "Forged",
    year: null,
    adult: false,
  };

  await f.app.runPromise(
    f.sessions.setPolicy({
      current: f.adult,
      newPin: "1234",
      profiles: [
        {
          id: f.kid.id,
          approved: [{ kind: movie.kind, subscriptionId: f.source.id, id: movie.id }],
        },
      ],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));
  expect(
    await f.call(kid, "collections.change", { kind: "create", id: "one", name: "Films" }),
  ).toMatchObject({ ok: true });
  const original = f.onDemand.titles;
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onTestFinished(() => {
    release.resolve();
    f.onDemand.titles = original;
  });
  f.onDemand.titles = (...args) =>
    Effect.gen(function* () {
      const answer = yield* original(...args);
      arrived.resolve();
      yield* Effect.promise(() => release.promise);

      return answer;
    });

  const pending = f.call(kid, "collections.change", {
    kind: "member",
    id: "one",
    title,
    present: true,
  });

  await arrived.promise;
  // Released management refuses active-kids edits; simulate an external durable policy change.
  const db = new DatabaseSync(join(f.dataDir, "mrstreamer.db"));
  onTestFinished(() => db.close());

  const saved = type("string").assert(
    db.prepare("SELECT value FROM kids_policy WHERE id = 1").get()!.value,
  );

  const policy = type({
    pin: "string",
    salt: "string",
    revision: "number",
    profiles: "unknown[]",
  }).assert(JSON.parse(saved));

  db.prepare("UPDATE kids_policy SET value = ? WHERE id = 1").run(
    JSON.stringify({ ...policy, profiles: [] }),
  );
  release.resolve();
  expect(await pending).toMatchObject({ ok: false });
  f.onDemand.titles = original;
  db.prepare("UPDATE kids_policy SET value = ? WHERE id = 1").run(saved);
  expect(await f.call(kid, "collections.page", { id: "one", offset: 0, limit: 48 })).toMatchObject({
    ok: true,
    value: { total: 0 },
  });
});

it("publishes only the captured collection owner and refuses missing admitted context", async ({
  signal,
  task,
}) => {
  // Failure-only observation of this public case, not a readiness or timeout repair.
  const readMonotonic = process.hrtime.bigint;
  const started = readMonotonic();
  const history: { sequence: number; label: string; elapsedNs: string }[] = [];
  let pendingPhase = "body-entry";
  const phase = (label: string) => {
    pendingPhase = label;
    if (history.length < 40) {
      history.push({
        sequence: history.length,
        label,
        elapsedNs: String(readMonotonic() - started),
      });
    }
  };
  const capture = (
    witness: "runner-abort" | "finished-failure",
    kind: "test-timeout-5000" | "hook-timeout" | "cancellation-or-other" | "failed-result",
  ) =>
    Object.freeze({
      witness,
      kind,
      phase: pendingPhase,
      elapsedNs: String(readMonotonic() - started),
      entries: Object.freeze(history.map((entry) => Object.freeze({ ...entry }))),
    });
  let firstSnapshot: ReturnType<typeof capture> | undefined;
  const report = (...args: Parameters<typeof capture>) => {
    if (firstSnapshot) return;
    firstSnapshot = capture(...args);
    console.error("[818 failure chronology]", JSON.stringify(firstSnapshot));
  };
  const onAbort = () => {
    const reason: unknown = signal.reason;
    const kind =
      reason instanceof Error && reason.message.startsWith("Test timed out in 5000ms")
        ? "test-timeout-5000"
        : reason instanceof Error && reason.message.startsWith("Hook timed out in ")
          ? "hook-timeout"
          : "cancellation-or-other";
    report("runner-abort", kind);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  onTestFinished(() => {
    signal.removeEventListener("abort", onAbort);
    if (task.result?.state === "fail") report("finished-failure", "failed-result");
  });
  phase("fixture");
  const f = await fixture();
  phase("admission");
  const admitted = await f.app.runPromise(f.sessions.admitFor(f.adult));
  phase("missing-context-refusal-and-assertion");
  expect((await f.app.runPromiseExit(admitted.services.collections.list))._tag).toBe("Failure");
  phase("stream-import");
  const Stream = await import("effect/Stream");

  phase("caller-scope-entry");
  const changes = await f.app.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        phase("profile-hub-acquisition");
        const stream = yield* f.sessions.changes;

        phase("mutation");
        const result = yield* Effect.promise(() =>
          f.call(f.adult, "collections.change", {
            kind: "create",
            id: "one",
            name: "Private name",
          }),
        );

        phase("mutation-result-assertion");
        expect(result).toMatchObject({ ok: true });

        phase("toPull");
        const pull = yield* Stream.toPull(
          Stream.filter(stream, (change) => change.kind === "collections"),
        );

        phase("pull");
        const pulled = yield* pull;
        phase("caller-scope-close");
        return pulled;
      }),
    ),
  );

  phase("owner-assertion");
  expect(changes).toEqual([{ kind: "collections", owner: f.adult }]);

  phase("closed-acquisition-or-close");
  const closed = await f.app.runPromise(Effect.scoped(f.sessions.changes));
  phase("closed-stream-drain");
  expect(await f.app.runPromise(Stream.runCollect(closed))).toEqual([]);
  phase("body:done");
});

it("keeps exact retained collection facts usable after a source refresh fails", async () => {
  const f = await fixture();
  const other = await fakeProvider();
  const roster = await f.app.runPromise(Roster);
  const source = await f.app.runPromise(roster.add(demoLogin(other)));
  await f.app.runPromise(f.onDemand.refresh(source.id));
  const movies = (await f.app.runPromise(f.onDemand.search("TEST"))).movies;

  const first = movies.find((movie) =>
    movie.versions.some((version) => version.subscriptionId === f.source.id),
  )!;

  const second = movies.find((movie) =>
    movie.versions.some((version) => version.subscriptionId === source.id),
  )!;

  expect(
    await f.call(f.adult, "collections.change", {
      kind: "create",
      id: "retained",
      name: "Retained",
    }),
  ).toMatchObject({ ok: true });

  for (const [movie, sourceId] of [
    [first, f.source.id],
    [second, source.id],
  ] as const) {
    const version = movie.versions.find((version) => version.subscriptionId === sourceId)!;
    expect(
      await f.call(f.adult, "collections.change", {
        kind: "member",
        id: "retained",
        title: {
          sourceId,
          kind: movie.kind,
          titleId: version.id,
          name: "Forged",
          year: null,
          adult: false,
        },
        present: true,
      }),
    ).toMatchObject({ ok: true });
  }

  other.failTitles(503);
  await f.app.runPromiseExit(f.onDemand.refresh(source.id));
  const status = await f.app.runPromise(f.onDemand.status);
  expect(status.lists.find((each) => each.subscriptionId === source.id)).toMatchObject({
    failure: expect.anything(),
    fetchedAt: expect.any(Number),
  });

  const result = await f.call(f.adult, "collections.page", {
    id: "retained",
    offset: 0,
    limit: 48,
  });

  expect(result).toMatchObject({
    ok: true,
    value: {
      total: 2,
      members: expect.arrayContaining([
        expect.objectContaining({ sourceId: f.source.id, available: true }),
        expect.objectContaining({ sourceId: source.id, available: true }),
      ]),
    },
  });

  if (result.ok)
    expect(
      type({ members: type({ name: "string", adult: "boolean" }).array() })
        .assert(result.value)
        .members.every((member) => member.name !== "Forged" && member.adult === false),
    ).toBe(true);
});

it("refuses absent initial collection lists and failed exact reads instead of empty success", async () => {
  const f = await fixture();
  const movie = (await f.app.runPromise(f.onDemand.search("TEST"))).movies[0]!;
  expect(
    await f.call(f.adult, "collections.change", { kind: "create", id: "initial", name: "Initial" }),
  ).toMatchObject({ ok: true });

  const command = {
    kind: "member" as const,
    id: "initial",
    title: {
      sourceId: f.source.id,
      kind: movie.kind,
      titleId: movie.id,
      name: movie.title,
      year: movie.year,
      adult: false,
    },
    present: true,
  };

  const status = f.onDemand.status;
  onTestFinished(() => {
    Object.defineProperty(f.onDemand, "status", { value: status, configurable: true });
  });
  Object.defineProperty(f.onDemand, "status", {
    value: Effect.map(status, (answer) => ({
      ...answer,
      lists: answer.lists.map((list) => ({ ...list, fetchedAt: null })),
    })),
    configurable: true,
  });
  expect(await f.call(f.adult, "collections.change", command)).toMatchObject({ ok: false });
  Object.defineProperty(f.onDemand, "status", { value: status, configurable: true });
  const titles = f.onDemand.titles;
  onTestFinished(() => {
    f.onDemand.titles = titles;
  });
  f.onDemand.titles = () =>
    Effect.fail(new Failed({ error: { kind: "unexpected", detail: "Read failed" } }));
  expect(await f.call(f.adult, "collections.change", command)).toMatchObject({ ok: false });
  f.onDemand.titles = titles;
  expect(await f.call(f.adult, "collections.change", command)).toMatchObject({ ok: true });
  expect(
    await f.call(f.adult, "collections.page", { id: "initial", offset: 0, limit: 48 }),
  ).toMatchObject({ ok: true, value: { total: 1 } });
  f.onDemand.titles = () =>
    Effect.fail(new Failed({ error: { kind: "unexpected", detail: "Read failed" } }));
  expect(
    await f.call(f.adult, "collections.page", { id: "initial", offset: 0, limit: 48 }),
  ).toMatchObject({ ok: false });
  f.onDemand.titles = titles;
  expect(
    await f.call(f.adult, "collections.page", { id: "initial", offset: 0, limit: 48 }),
  ).toMatchObject({ ok: true, value: { total: 1 } });
});

it("filters retained exact kids facts after adult reclassification and a failed refresh", async () => {
  const f = await fixture({
    titlesOf: (built) => {
      const base = built.movies.find((movie) => !movie.adult)!;

      return {
        ...built,
        movies: [
          { ...base, id: 90101, name: "Kept safe", tmdb: "90101" },
          { ...base, id: 90102, name: "Kept restricted", tmdb: "90102" },
        ],
      };
    },
  });

  await f.app.runPromise(
    f.sessions.setPolicy({
      current: f.adult,
      newPin: "1234",
      profiles: [
        {
          id: f.kid.id,
          approved: ["90101", "90102"].map((id) => ({
            kind: "movie",
            subscriptionId: f.source.id,
            id,
          })),
        },
      ],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));
  expect(
    await f.call(kid, "collections.change", { kind: "create", id: "safe", name: "Safe" }),
  ).toMatchObject({ ok: true });

  for (const titleId of ["90101", "90102"])
    expect(
      await f.call(kid, "collections.change", {
        kind: "member",
        id: "safe",
        title: {
          sourceId: f.source.id,
          kind: "movie",
          titleId,
          name: "Forged",
          year: null,
          adult: false,
        },
        present: true,
      }),
    ).toMatchObject({ ok: true });
  const restricted = f.provider.titles.movies.find((movie) => movie.id === 90102)!;
  Object.assign(restricted, { adult: true, categoryId: "505" });
  await f.app.runPromise(f.onDemand.refresh(f.source.id));
  f.provider.failTitles(503);
  await f.app.runPromiseExit(f.onDemand.refresh(f.source.id));
  const page = await f.call(kid, "collections.page", { id: "safe", offset: 0, limit: 48 });
  expect(page).toMatchObject({
    ok: true,
    value: { total: 1, members: [{ titleId: "90101", name: "Kept safe", adult: false }] },
  });
  expect(JSON.stringify(page)).not.toContain("Kept restricted");
  expect(
    await f.call(kid, "collections.change", {
      kind: "member",
      id: "safe",
      title: {
        sourceId: f.source.id,
        kind: "movie",
        titleId: "90102",
        name: "Forged",
        year: null,
        adult: false,
      },
      present: true,
    }),
  ).toMatchObject({ ok: false });
});

it.each(["reply", "commit"] as const)(
  "refuses a collection %s overtaken by accepted adult facts",
  async (operation) => {
    const f = await fixture({
      titlesOf: (built) => {
        const base = built.movies.find((movie) => !movie.adult)!;

        return {
          ...built,
          movies: [
            { ...base, id: 90201, name: "Previously safe", tmdb: "90201" },
            { ...base, id: 90202, name: "Still safe", tmdb: "90202" },
          ],
        };
      },
    });

    await f.app.runPromise(
      f.sessions.setPolicy({
        current: f.adult,
        newPin: "1234",
        profiles: [
          {
            id: f.kid.id,
            approved: ["90201", "90202"].map((id) => ({
              kind: "movie",
              subscriptionId: f.source.id,
              id,
            })),
          },
        ],
      }),
    );
    const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));

    const title = (titleId: string) => ({
      sourceId: f.source.id,
      kind: "movie" as const,
      titleId,
      name: "Forged",
      year: null,
      adult: false,
    });

    expect(
      await f.call(kid, "collections.change", { kind: "create", id: "currency", name: "Currency" }),
    ).toMatchObject({ ok: true });

    for (const titleId of ["90201", "90202"])
      expect(
        await f.call(kid, "collections.change", {
          kind: "member",
          id: "currency",
          title: title(titleId),
          present: true,
        }),
      ).toMatchObject({ ok: true });
    const original = f.onDemand.titles;
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(() => {
      release.resolve();
      f.onDemand.titles = original;
    });
    let held = false;
    f.onDemand.titles = (...args) =>
      Effect.gen(function* () {
        const answer = yield* original(...args);

        if (!held) {
          held = true;
          arrived.resolve();
          yield* Effect.promise(() => release.promise);
        }

        return answer;
      });

    const pending =
      operation === "reply"
        ? f.call(kid, "collections.page", { id: "currency", offset: 0, limit: 48 })
        : f.call(kid, "collections.change", {
            kind: "member",
            id: "currency",
            title: title("90201"),
            present: true,
          });

    await arrived.promise;
    const promoted = f.provider.titles.movies.find((movie) => movie.id === 90201)!;
    Object.assign(promoted, { adult: true, categoryId: "505" });
    await f.app.runPromise(f.onDemand.refresh(f.source.id));
    release.resolve();
    expect(await pending).toMatchObject({ ok: false });
    f.onDemand.titles = original;
    const page = await f.call(kid, "collections.page", { id: "currency", offset: 0, limit: 48 });
    expect(page).toMatchObject({
      ok: true,
      value: { total: 1, members: [{ titleId: "90202", name: "Still safe" }] },
    });
    expect(JSON.stringify(page)).not.toContain("Previously safe");
  },
);

it("binds public catalogue checkpoints to acceptance, retained data and worker lifetime", async () => {
  const { Worker } = await import("node:worker_threads");
  const { pathToFileURL } = await import("node:url");
  const { inject } = await import("vitest");
  const { gzipSync, gunzipSync } = await import("node:zlib");
  const { writeFile } = await import("node:fs/promises");
  const dataDir = await tempDir();
  const provider = await fakeProvider();
  const workers: import("node:worker_threads").Worker[] = [];

  const entry =
    inject("catalogueWorker") ??
    new URL("../src/main/ondemand/catalogue-worker.ts", import.meta.url);

  const url = type("string").allows(entry) ? pathToFileURL(entry).href : entry.href;

  const start = async () => {
    const app = runtimeFor(
      mainLayer({
        ...testConfig(dataDir),
        catalogueWorker: (setup) => {
          const worker = new Worker(
            `Date.now = () => 1900000000000; import(${JSON.stringify(url)});`,
            { eval: true, workerData: setup },
          );

          workers.push(worker);

          return worker;
        },
      }),
    );

    return {
      app,
      onDemand: await app.runPromise(OnDemand),
      roster: await app.runPromise(Roster),
      settings: await app.runPromise(Settings),
      subscriptions: await app.runPromise(Subscriptions),
    };
  };

  let f = await start();
  const added = await f.app.runPromise(f.roster.add(demoLogin(provider)));
  const source = await f.app.runPromise(f.subscriptions.sourceOf(added.id));
  await f.app.runPromise(f.onDemand.refresh(source.id));
  const checkpoint = await f.app.runPromise(f.onDemand.catalogueSnapshot([source.id]));
  expect(Effect.runSyncExit(checkpoint.current)._tag).toBe("Success");
  const before = await f.app.runPromise(f.onDemand.status);
  await f.app.runPromise(f.onDemand.refresh(source.id));
  expect((await f.app.runPromise(f.onDemand.status)).lists[0]?.fetchedAt).toBe(
    before.lists[0]?.fetchedAt,
  );
  expect(Effect.runSyncExit(checkpoint.current)._tag).toBe("Failure");
  const retained = await f.app.runPromise(f.onDemand.catalogueSnapshot([source.id]));
  provider.failTitles(503);
  await f.app.runPromiseExit(f.onDemand.refresh(source.id));
  expect(Effect.runSyncExit(retained.current)._tag).toBe("Success");
  expect((await f.app.runPromise(f.onDemand.catalogueSnapshot([source.id]))).current).toBeDefined();
  provider.failTitles(null);
  await f.app.dispose();
  expect(Effect.runSyncExit(retained.current)._tag).toBe("Failure");
  // Remove only the optional revision stamp from a real persisted catalogue.
  const cache = join(source.dir, "ondemand.json.gz");

  const disk = type({ catalogueStamp: "string", "[string]": "unknown" }).assert(
    JSON.parse(gunzipSync(await readFile(cache)).toString()),
  );

  const { catalogueStamp: _, ...legacy } = disk;
  await writeFile(cache, gzipSync(JSON.stringify(legacy)));
  f = await start();
  const loaded = await f.app.runPromise(f.onDemand.catalogueSnapshot([source.id]));
  expect(Effect.runSyncExit(loaded.current)._tag).toBe("Success");
  expect(
    (
      await f.app.runPromise(
        f.onDemand.titles("movie", [
          { subscriptionId: source.id, id: String(provider.titles.movies[0]!.id) },
        ]),
      )
    ).length,
  ).toBe(1);
  await workers.at(-1)!.terminate();
  expect(Effect.runSyncExit(loaded.current)._tag).toBe("Failure");
  // Starting another worker cannot bless an acquisition that crossed the restart.
  expect((await f.app.runPromiseExit(f.onDemand.catalogueSnapshot([source.id])))._tag).toBe(
    "Failure",
  );
  const restarted = await f.app.runPromise(f.onDemand.catalogueSnapshot([source.id]));
  expect(Effect.runSyncExit(restarted.current)._tag).toBe("Success");
  await f.app.runPromise(f.settings.update({ tmdbKey: "changed-test-key" }));
  await f.app.runPromise(f.onDemand.reconfigure);
  expect(Effect.runSyncExit(restarted.current)._tag).toBe("Failure");
  const configured = await f.app.runPromise(f.onDemand.catalogueSnapshot([source.id]));
  expect(Effect.runSyncExit(configured.current)._tag).toBe("Success");
  await f.app.runPromise(f.subscriptions.add(demoLogin(provider)));
  expect(Effect.runSyncExit(configured.current)._tag).toBe("Failure");
  const replaced = await f.app.runPromise(f.onDemand.catalogueSnapshot([source.id]));
  await f.app.runPromise(
    f.onDemand.forget(await f.app.runPromise(f.subscriptions.sourceOf(source.id))),
  );
  expect(Effect.runSyncExit(replaced.current)._tag).toBe("Failure");
  const absent = await fakeProvider();
  absent.failTitles(503);
  const missing = await f.app.runPromise(f.roster.add(demoLogin(absent)));
  expect((await f.app.runPromiseExit(f.onDemand.catalogueSnapshot([missing.id])))._tag).toBe(
    "Failure",
  );
  await f.app.runPromiseExit(f.onDemand.refresh(missing.id));
  expect((await f.app.runPromiseExit(f.onDemand.catalogueSnapshot([missing.id])))._tag).toBe(
    "Failure",
  );
});

it("refuses checkpoints during acceptance and acquisitions crossed by acceptance", async () => {
  const { Worker } = await import("node:worker_threads");
  const { inject } = await import("vitest");
  const dataDir = await tempDir();
  const provider = await fakeProvider();

  let gate: {
    method: "finishRefresh" | "status";
    arrived: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  } | null = null;

  const releases: (() => void)[] = [];
  onTestFinished(() => releases.forEach((release) => release()));

  const hold = (method: "finishRefresh" | "status") => {
    const next = {
      method,
      arrived: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };

    releases.push(next.release.resolve);
    gate = next;

    return next;
  };

  const app = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      catalogueWorker: (setup) => {
        const worker = new Worker(
          inject("catalogueWorker") ??
            new URL("../src/main/ondemand/catalogue-worker.ts", import.meta.url),
          { workerData: setup },
        );

        const send = worker.postMessage.bind(worker);
        // The injected worker transport holds a dispatch; production acceptance must invalidate first.
        worker.postMessage = (
          value: import("../src/main/ondemand/protocol.ts").WorkerRequest,
          transfers,
        ) => {
          if (gate && value.method === gate.method) {
            const held = gate;
            gate = null;
            held.arrived.resolve();
            void held.release.promise.then(() => send(value, transfers));
          } else send(value, transfers);
        };

        return worker;
      },
    }),
  );

  const onDemand = await app.runPromise(OnDemand);
  const roster = await app.runPromise(Roster);
  const source = await app.runPromise(roster.add(demoLogin(provider)));
  await app.runPromise(onDemand.refresh(source.id));
  const before = await app.runPromise(onDemand.catalogueSnapshot([source.id]));
  const accepting = hold("finishRefresh");
  const refresh = app.runPromise(onDemand.refresh(source.id));
  await accepting.arrived.promise;
  expect(Effect.runSyncExit(before.current)._tag).toBe("Failure");
  expect((await app.runPromiseExit(onDemand.catalogueSnapshot([source.id])))._tag).toBe("Failure");
  accepting.release.resolve();
  await refresh;
  const accepted = await app.runPromise(onDemand.catalogueSnapshot([source.id]));
  expect(Effect.runSyncExit(accepted.current)._tag).toBe("Success");
  const reading = hold("status");
  const snapshot = app.runPromiseExit(onDemand.catalogueSnapshot([source.id]));
  await reading.arrived.promise;
  await app.runPromise(onDemand.refresh(source.id));
  reading.release.resolve();
  expect((await snapshot)._tag).toBe("Failure");
  expect(
    Effect.runSyncExit((await app.runPromise(onDemand.catalogueSnapshot([source.id]))).current)
      ._tag,
  ).toBe("Success");
});

it.each(["cold", "reconfigure", "source replacement"])(
  "allows concurrent first collection catalogue snapshots after %s without weakening currency",
  async (transition) => {
    const provider = await fakeProvider();
    const dataDir = await tempDir();
    let app = runtimeFor(mainLayer(testConfig(dataDir)));
    onTestFinished(() => app.dispose());
    let onDemand = await app.runPromise(OnDemand);
    const roster = await app.runPromise(Roster);
    const source = await app.runPromise(roster.add(demoLogin(provider)));
    await app.runPromise(onDemand.refresh(source.id));
    const before = await app.runPromise(onDemand.catalogueSnapshot([source.id]));

    const loaded = await Promise.all(
      [1, 2].map(() => app.runPromiseExit(onDemand.catalogueSnapshot([source.id]))),
    );

    expect(loaded.map((result) => result._tag)).toEqual(["Success", "Success"]);

    if (transition === "cold") {
      await app.dispose();
      app = runtimeFor(mainLayer(testConfig(dataDir)));
      onDemand = await app.runPromise(OnDemand);
    } else if (transition === "reconfigure") {
      const settings = await app.runPromise(Settings);
      await app.runPromise(settings.update({ tmdbKey: "changed-test-key" }));
      await app.runPromise(onDemand.reconfigure);
    } else {
      const subscriptions = await app.runPromise(Subscriptions);
      await app.runPromise(subscriptions.add(demoLogin(provider)));
    }

    expect(Effect.runSyncExit(before.current)._tag).toBe("Failure");

    const snapshots = await Promise.all(
      [1, 2].map(() => app.runPromiseExit(onDemand.catalogueSnapshot([source.id]))),
    );

    expect(snapshots.map((result) => result._tag)).toEqual(["Success", "Success"]);

    for (const result of snapshots)
      if (result._tag === "Success")
        expect(Effect.runSyncExit(result.value.current)._tag).toBe("Success");
    await app.runPromise(onDemand.refresh(source.id));

    for (const result of snapshots)
      if (result._tag === "Success")
        expect(Effect.runSyncExit(result.value.current)._tag).toBe("Failure");
  },
);

it("keeps configured metadata available without exposing household progress to kids", async () => {
  const tmdb = await startFakeTmdb();
  onTestFinished(() => tmdb.close());
  const f = await fixture({ tmdb: { key: "fake-key", api: tmdb.url } });
  const progress = type({ metadata: { known: "number", wanted: "number" } });

  await expect
    .poll(async () => {
      const result = await f.call(f.adult, "ondemand.status", undefined);

      if (!result.ok) throw new Error("Adult metadata status was refused.");
      const { metadata } = progress.assert(result.value);

      return metadata.known > 0 && metadata.wanted > 0;
    })
    .toBe(true);
  await f.app.runPromise(
    f.sessions.setPolicy({
      current: f.adult,
      newPin: "1234",
      profiles: [{ id: f.kid.id, approved: [] }],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));

  expect(await f.call(kid, "ondemand.status", undefined)).toMatchObject({
    ok: true,
    value: { metadata: { known: 0, wanted: 0, refused: false, fetching: false } },
  });
  const adult = await f.app.runPromise(f.sessions.switch(f.adult.id, kid, "1234"));
  const result = await f.call(adult, "ondemand.status", undefined);

  expect(result.ok).toBe(true);

  if (result.ok) {
    const { metadata } = progress.assert(result.value);

    expect(metadata.known).toBeGreaterThan(0);
    expect(metadata.wanted).toBeGreaterThan(0);
  }
});

it("keeps metadata absent without a key for both adult and kids viewers", async () => {
  const f = await fixture();

  expect(await f.call(f.adult, "ondemand.status", undefined)).toMatchObject({
    ok: true,
    value: { metadata: null },
  });
  await f.app.runPromise(
    f.sessions.setPolicy({
      current: f.adult,
      newPin: "1234",
      profiles: [{ id: f.kid.id, approved: [] }],
    }),
  );
  const kid = await f.app.runPromise(f.sessions.switch(f.kid.id, f.adult));

  expect(await f.call(kid, "ondemand.status", undefined)).toMatchObject({
    ok: true,
    value: { metadata: null },
  });
});
