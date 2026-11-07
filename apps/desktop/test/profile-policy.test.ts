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
import type { FakeProviderOptions } from "./fake-provider.ts";
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

  const f = await fixture({
    now,
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

  const channel = f.provider.catalogue.channels.find(
    (item) => item.streamId >= 2000 && !item.offline && item.guideId && !item.adult,
  )!;

  const programme = (start: string, stop: string, title: string) =>
    `<programme start="20261002${start}00 +0200" stop="20261002${stop}00 +0200" channel="${channel.guideId}"><title>${title}</title></programme>`;

  f.provider.serveGuide(
    `<?xml version="1.0"?><tv>${programme("2030", "2130", "Restricted first")}${programme("2130", "2300", "Restricted second")}</tv>`,
  );
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
