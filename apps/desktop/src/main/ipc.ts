import { Playback, CurrentPaneArrival, type PaneArrival } from "./services/playback.ts";
import { Profiles } from "./platform/profile-store.ts";
import { allowsApproval, visibleDownloads, visibleOutput } from "./services/profile-policy.ts";
import { defined } from "@mrstreamer/core/defined";
import { t } from "@mrstreamer/core/i18n";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { Title, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { changedTitles } from "@mrstreamer/contracts/collections";
import {
  ActiveProfileSchema,
  sameProfile,
  type KidsApproval,
  ownedByProfile,
  type ActiveProfile,
} from "@mrstreamer/contracts/profiles";
import { householdMutations } from "./handlers/subscriptions.ts";
import type { ProfileAdmission } from "./services/profiles.ts";
import type { Type } from "arktype";
import { ipcMain, type WebContents } from "electron";
import { type } from "arktype";
import type { Result } from "@mrstreamer/contracts/errors";
import {
  ipcInputs,
  PaneIntent,
  type IpcEvent,
  type IpcEvents,
  type IpcInput,
  type IpcMethod,
  type IpcOutput,
} from "@mrstreamer/contracts/ipc";
import { Diagnostics, outcomeOf } from "@mrstreamer/core/diagnostics";
import { Failed } from "@mrstreamer/core/failure";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * One handler per IPC method. `frame` identifies the authorized current main frame for
 * observations; it is derived by main, never supplied by the renderer or captured.
 * `Failed` answers a typed error.
 */
export type IpcHandlers = {
  readonly [M in IpcMethod]: (
    input: IpcInput<M>,
    frame: string,
  ) => Effect.Effect<IpcOutput<M>, Failed>;
};

/** A domain adapter owns every method under its prefixes in the shared contract. */
export type HandlersFor<D extends IpcDomain> = Pick<
  IpcHandlers,
  Extract<IpcMethod, `${D}.${string}`>
>;

type DomainOf<M> = M extends `${infer D}.${string}` ? D : never;

type IpcDomain = DomainOf<IpcMethod>;

/**
 * Registers every IPC method. Calls require a non-null current main frame and a window accepted
 * by `isTrusted`, before schema validation or handler execution. Input is validated before running on
 * `run`, the main runtime, and any failure resolves to a typed error instead of a rejected promise.
 * Failed calls go to the diagnostics.
 */
export function registerIpc(
  run: <A>(effect: Effect.Effect<A, Failed>) => Promise<Exit.Exit<A, Failed>>,
  handlers: IpcHandlers,
  isTrusted: (sender: WebContents) => boolean,
  personal?: {
    readonly admit: (expected?: ActiveProfile) => Effect.Effect<ProfileAdmission, Failed>;
    readonly handlers: (admission: ProfileAdmission) => Partial<IpcHandlers>;
  },
): void {
  // Entries live only while an invocation runs. No renderer can address another sender/frame.
  const pending = new Map<WebContents, Map<string, AbortController>>();
  const cleanups = new Map<WebContents, () => void>();

  const requestKey = (frame: string, request: IpcInput<"guide.cancelSearch">) =>
    JSON.stringify([frame, request.view, request.id]);

  const track = (sender: WebContents, key: string) => {
    let requests = pending.get(sender);

    if (!requests) {
      requests = new Map();
      pending.set(sender, requests);
      sender.on("destroyed", stop);
      sender.on("render-process-gone", stop);
      sender.on("did-start-navigation", navigate);
      cleanups.set(sender, () => {
        sender.removeListener("destroyed", stop);
        sender.removeListener("render-process-gone", stop);
        sender.removeListener("did-start-navigation", navigate);
      });
    }

    const controller = new AbortController();
    requests.set(key, controller);

    function stop() {
      for (const controller of pending.get(sender)?.values() ?? []) controller.abort();
    }

    function navigate(details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) {
      if (details.isMainFrame && !details.isSameDocument) stop();
    }

    return {
      signal: controller.signal,
      done: () => {
        requests.delete(key);

        if (requests.size !== 0) return;
        pending.delete(sender);
        cleanups.get(sender)?.();
        cleanups.delete(sender);
      },
    };
  };

  for (const method of Object.keys(ipcInputs) as IpcMethod[]) {
    // TypeScript cannot pair `ipcInputs[method]` with `handlers[method]` inside a loop over all
    // methods, so the loop uses the union of contract inputs. `IpcHandlers` keeps each handler fully typed.
    const schema: () => Type<IpcInput<IpcMethod>> = ipcInputs[method];

    const handler = handlers[method] as (
      input: IpcInput<IpcMethod>,
      frame: string,
    ) => Effect.Effect<unknown, Failed>;

    // Built on the method's first call, not while the app starts.
    let validate: Type<IpcInput<IpcMethod>> | null = null;

    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Electron supplies untyped arguments; the method input schema validates raw before dispatch.
    ipcMain.handle(method, async (event, raw: unknown): Promise<Result<unknown>> => {
      // Electron gives no frame once the one that sent the call has navigated or gone.
      const from = event.senderFrame;

      if (!isTrusted(event.sender) || !from || from !== event.sender.mainFrame) {
        return {
          ok: false,
          error: { kind: "unexpected", detail: "IPC call from an unknown window." },
        };
      }

      let expected: ActiveProfile | undefined;

      if (type.keywords.object.root.allows(raw) && "__profile" in raw && "input" in raw) {
        if (raw.__profile !== undefined) {
          const owner = ActiveProfileSchema()(raw.__profile);

          if (owner instanceof type.errors)
            return {
              ok: false,
              error: { kind: "invalid-input", detail: "Invalid viewing profile admission." },
            };
          expected = owner;
        }

        raw = raw.input;
      }

      validate ??= schema();
      const input = validate(raw);

      if (input instanceof type.errors) {
        return {
          ok: false,
          error: {
            kind: "invalid-input",
            detail: method.startsWith("analytics.")
              ? "Invalid analytics observation."
              : `${method}: ${input.summary}`,
          },
        };
      }

      const frame = `${from.processId}:${from.routingId}`;

      if (method === "guide.cancelSearch") {
        const request = ipcInputs["guide.cancelSearch"]()(input);

        if (!(request instanceof type.errors))
          pending.get(event.sender)?.get(requestKey(frame, request))?.abort();

        return { ok: true, value: null };
      }

      let owned: ReturnType<typeof track> | undefined;

      if (
        (method === "guide.search" ||
          method === "guide.searchList" ||
          method === "guide.searchPage") &&
        type.keywords.object.root.allows(input) &&
        "request" in input &&
        input.request !== undefined
      ) {
        const request = ipcInputs["guide.cancelSearch"]()(input.request);

        if (request instanceof type.errors)
          return {
            ok: false,
            error: { kind: "invalid-input", detail: "Search needs the main frame." },
          };
        const key = requestKey(frame, request);
        const requests = pending.get(event.sender);

        if (requests?.has(key) || (requests?.size ?? 0) >= 256)
          return {
            ok: false,
            error: {
              kind: "invalid-input",
              detail: "Search request already active or limit reached.",
            },
          };
        owned = track(event.sender, key);
      }

      let work = Effect.gen(function* () {
        let arrival: PaneArrival | undefined;

        // Only validated mutations record arrival metadata. Admission still owns every result.
        const paneMutations = [
          "playback.openPane",
          "playback.adoptPane",
          "playback.singlePane",
          "playback.closePane",
        ] as const satisfies readonly IpcMethod[];

        if (paneMutations.some((entry) => entry === method)) {
          const playback = yield* Effect.serviceOption(Playback);
          const profiles = yield* Effect.serviceOption(Profiles);

          if (playback._tag === "None" || profiles._tag === "None" || !personal)
            return yield* new Failed({
              error: { kind: "invalid-input", detail: "Pane admission is unavailable." },
            });
          const owner = yield* profiles.value.active;
          const pane = PaneIntent(input);

          if (!(pane instanceof type.errors) && expected && sameProfile(expected, owner))
            arrival = yield* playback.value.arrivePane(pane.paneId, owner, frame, pane.order);
        }

        if (!personal || !ownedByProfile(method)) return yield* handler(input, frame);
        const admitted = yield* personal.admit(expected);

        // The mapping keeps per-method types at construction; this loop already dispatches the
        // union of validated inputs, as the ordinary handler above does.
        const selected = kidsHandlers(admitted, { ...handlers, ...personal.handlers(admitted) })[
          method
        ] as typeof handler;

        let start = Effect.andThen(
          admitted.current,
          Effect.suspend(() => selected(input, frame)),
        );

        if (arrival) start = Effect.provideService(start, CurrentPaneArrival, arrival);

        // These household writes serialize with removal, which drains personal permits.
        // Capture the admitted context under a short permit, then release it before that write lock.
        // Forked catalogue work retains its original Settings and current-owner check.
        const result = yield* Effect.exit(
          householdMutations.has(method)
            ? Effect.provideContext(start, yield* admitted.run(Effect.context<never>()))
            : admitted.run(start),
        );

        // A reply, success or failure, answers only the visit and policy revision it was admitted under.
        yield* admitted.current;

        return yield* result;
      });

      if (owned) {
        const { signal } = owned;

        const cancelled = Effect.callback<never>((resume) => {
          const stop = () => resume(Effect.interrupt);

          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });

          return Effect.sync(() => signal.removeEventListener("abort", stop));
        });

        // raceFirst waits for the interrupted handler's finalizers, including guide file holds.
        work = Effect.raceFirst(work, cancelled);
      }

      const exit = await run(
        work.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || closing(exit)
              ? Effect.void
              : Effect.map(Diagnostics, (diagnostics) =>
                  diagnostics.record({ op: "call", method, outcome: outcomeOf(exit) }),
                ),
          ),
        ),
      ).finally(() => owned?.done());

      if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
      const failed = Cause.findErrorOption(exit.cause);

      if (failed._tag === "Some") return { ok: false, error: failed.value.error };

      if (closing(exit)) return { ok: false, error: { kind: "unexpected", detail: "Closing." } };
      console.error(`[ipc] ${method} failed`, Cause.pretty(exit.cause));
      const cause = Cause.squash(exit.cause);
      const detail = cause instanceof Error ? cause.message : String(cause);

      return { ok: false, error: { kind: "unexpected", detail } };
    });
  }
}

/**
 * Pure interruption is expected for owned search cancellation and runtime shutdown. Neither
 * records a diagnostics failure or logs an unexpected exception.
 */
function closing(exit: Exit.Exit<unknown, unknown>): boolean {
  return Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
}

export function emit<E extends IpcEvent>(
  target: WebContents,
  event: E,
  payload: IpcEvents[E],
): void {
  if (!target.isDestroyed()) target.send(event, payload);
}

/**
 * The commands an admitted viewer may use. Adults get `handlers` as they are. Kids requests use the
 * same implementations after exact-source authorization; unlisted commands are management
 * operations and stay closed until explicitly supported here. Household service environments are
 * never changed.
 */
function kidsHandlers({ approved, owner }: ProfileAdmission, handlers: IpcHandlers): IpcHandlers {
  if (approved === null) return handlers;

  const denied = () =>
    Effect.fail(
      new Failed({
        error: {
          kind: "invalid-input",
          detail: t("Kids policy: this content or action is not approved."),
        },
      }),
    );

  const allows = (approval: KidsApproval) => allowsApproval(approved, approval);

  const online = (kind: "channel" | "movie" | "series", ref: OwnedId) => allows({ kind, ...ref });

  const copy = (kind: "download" | "recording", id: string) => allows({ kind, id });

  const titleRef = (ref: TitleRef) =>
    ref.kind === "movie"
      ? online("movie", ref)
      : online("series", { subscriptionId: ref.subscriptionId, id: ref.seriesId });

  const title = (item: Title): Title | null =>
    online(item.kind, item) && !item.adult
      ? { ...item, versions: item.versions.filter((version) => online(item.kind, version)) }
      : null;

  const titles = (items: readonly Title[]) => items.flatMap((item) => title(item) ?? []);

  const viewing = (state: Viewing) => ({
    ...state,
    favourites: state.favourites.filter((ref) => online("channel", ref)),
    recent: state.recent.filter((ref) => online("channel", ref)),
    continueWatching: state.continueWatching.filter((item) => titleRef(item.title)),
    ...defined({ recentTitles: state.recentTitles?.filter((item) => titleRef(item.title)) }),
    marked: state.marked.filter((item) => online("series", item.series)),
  });

  const changeReminder = (
    method: "reminders.cancel" | "reminders.dismiss",
    input: { id: string },
    frame: Parameters<IpcHandlers["reminders.cancel"]>[1],
  ) =>
    Effect.flatMap(handlers["reminders.list"](undefined, frame), (list) => {
      const reminder = list.reminders.find((item) => item.id === input.id);

      return reminder && online("channel", reminder.channel)
        ? handlers[method](input, frame)
        : denied();
    });

  // Every method keeps its correlated input/output type; only the deny-all default is shared.
  const closed = { ...handlers };

  for (const method of Object.keys(handlers) as (keyof IpcHandlers)[]) closed[method] = denied;

  return {
    ...closed,
    "collections.list": handlers["collections.list"],
    "collections.page": handlers["collections.page"],
    "collections.memberships": (input, frame) =>
      online(input.kind, { subscriptionId: input.sourceId, id: input.titleId })
        ? handlers["collections.memberships"](input, frame)
        : denied(),
    "collections.change": (input, frame) =>
      changedTitles(input).every((title) =>
        online(title.kind, { subscriptionId: title.sourceId, id: title.titleId }),
      )
        ? handlers["collections.change"](input, frame)
        : denied(),
    "subscription.list": handlers["subscription.list"],
    "preferences.get": handlers["preferences.get"],
    "preferences.update": handlers["preferences.update"],
    "subtitles.settings": handlers["subtitles.settings"],
    "subtitles.search": handlers["subtitles.search"],
    "subtitles.choose": handlers["subtitles.choose"],
    "subtitles.saved": handlers["subtitles.saved"],
    "subtitles.timing": handlers["subtitles.timing"],
    "subtitles.show": handlers["subtitles.show"],
    "subtitles.hide": handlers["subtitles.hide"],
    "subtitles.forget": handlers["subtitles.forget"],
    "subtitles.cancel": handlers["subtitles.cancel"],
    "language.get": handlers["language.get"],
    "language.set": handlers["language.set"],
    "liveBrowse.get": handlers["liveBrowse.get"],
    "liveBrowse.remember": handlers["liveBrowse.remember"],
    "subscription.preferences": (input, frame) =>
      Effect.map(handlers["subscription.preferences"](input, frame), (prefs) => ({
        ...prefs,
        lastChannelId:
          prefs.lastChannelId &&
          online("channel", { subscriptionId: input.subscriptionId, id: prefs.lastChannelId })
            ? prefs.lastChannelId
            : null,
        lastCategoryId: null,
        titleVersions: {},
      })),
    "subscription.updatePreferences": (input, frame) =>
      !input.patch.lastChannelId ||
      online("channel", { subscriptionId: input.subscriptionId, id: input.patch.lastChannelId })
        ? handlers["subscription.updatePreferences"](
            { ...input, patch: { ...input.patch, titleVersions: {} } },
            frame,
          )
        : denied(),
    "customLists.get": (input, frame) =>
      Effect.map(handlers["customLists.get"](input, frame), (rows) =>
        rows.map((row) => ({
          ...row,
          members: row.members.filter(
            (member) => member.kind === "listed" && online("channel", member.channel),
          ),
          away: 0,
        })),
      ),
    "updates.status": handlers["updates.status"],
    "guide.savedQueries": () => Effect.succeed([]),
    "playback.failure": handlers["playback.failure"],
    "playback.copyState": (input, frame) =>
      Effect.map(handlers["playback.copyState"](input, frame), (state) =>
        state && copy(state.kind, state.copy) ? state : null,
      ),
    "playback.diagnostic": handlers["playback.diagnostic"],
    "library.status": handlers["library.status"],
    "library.categories": handlers["library.categories"],
    "library.searchGroups": handlers["library.searchGroups"],
    "library.channels": handlers["library.channels"],
    "library.channel": (input, frame) =>
      online("channel", input.channel) ? handlers["library.channel"](input, frame) : denied(),
    "library.browse": handlers["library.browse"],
    "guide.status": handlers["guide.status"],
    "guide.schedule": (input, frame) =>
      online("channel", input.channel) ? handlers["guide.schedule"](input, frame) : denied(),
    "guide.programme": (input, frame) =>
      online("channel", input.channel) ? handlers["guide.programme"](input, frame) : denied(),
    "guide.listings": (input, frame) =>
      input.channels.every((ref) => online("channel", ref))
        ? handlers["guide.listings"](input, frame)
        : denied(),
    "guide.range": (input, frame) =>
      input.channels.every((ref) => online("channel", ref))
        ? handlers["guide.range"](input, frame)
        : denied(),
    "guide.search": (input, frame) =>
      Effect.map(handlers["guide.search"](input, frame), (rows) =>
        rows.filter((row) => online("channel", row.channel)),
      ),
    "guide.searchPage": handlers["guide.searchPage"],
    "guide.searchList": (input, frame) =>
      Effect.map(handlers["guide.searchList"](input, frame), (result) =>
        Object.fromEntries(
          Object.entries(result).filter(([key]) =>
            approved.some((item) => item.kind === "channel" && ownedKey(item) === key),
          ),
        ),
      ),
    "ondemand.filterOptions": handlers["ondemand.filterOptions"],
    "ondemand.status": handlers["ondemand.status"],
    "ondemand.search": (input, frame) =>
      Effect.map(handlers["ondemand.search"](input, frame), (result) => ({
        ...result,
        movies: titles(result.movies),
        series: titles(result.series),
      })),
    "ondemand.searchKind": handlers["ondemand.searchKind"],
    "ondemand.titles": (input, frame) =>
      Effect.map(handlers["ondemand.titles"](input, frame), titles),
    "ondemand.collection": handlers["ondemand.collection"],
    "ondemand.rows": (input, frame) =>
      !input.like || online(input.kind, input.like)
        ? handlers["ondemand.rows"](input, frame)
        : denied(),
    "ondemand.tiles": handlers["ondemand.tiles"],
    "ondemand.related": (input, frame) =>
      online(input.kind, input.version)
        ? Effect.map(handlers["ondemand.related"](input, frame), (result) => ({
            ...result,
            titles: result.titles.flatMap((item) => {
              const allowed = title(item.title);

              return allowed ? [{ ...item, title: allowed }] : [];
            }),
          }))
        : denied(),
    "ondemand.recommendations": (input, frame) =>
      input.seeds.every((seed) => online(seed.kind, seed.version))
        ? Effect.map(handlers["ondemand.recommendations"](input, frame), (rows) =>
            rows.flatMap((row) => {
              const allowed = title(row.title);

              return allowed ? [{ ...row, title: allowed }] : [];
            }),
          )
        : denied(),
    "ondemand.details": (input, frame) =>
      online(input.kind, input.version)
        ? Effect.flatMap(handlers["ondemand.details"](input, frame), (details) => {
            const allowed = title(details.title);

            return allowed ? Effect.succeed({ ...details, title: allowed }) : denied();
          })
        : denied(),
    "ondemand.season": (input, frame) =>
      online("series", input.series) ? handlers["ondemand.season"](input, frame) : denied(),
    "watchlist.list": (input, frame) =>
      Effect.map(handlers["watchlist.list"](input, frame), (page) => ({
        total: page.total,
        entries: page.entries.flatMap((entry) => {
          const allowed = entry.title && title(entry.title);

          return allowed
            ? [
                {
                  ...entry,
                  name: allowed.name,
                  year: allowed.year,
                  artworkUrl: allowed.posterUrl,
                  title: allowed,
                  sources: entry.sources.filter((source) =>
                    allowed.versions.some((version) => version.subscriptionId === source),
                  ),
                },
              ]
            : [];
        }),
      })),
    "watchlist.remove": handlers["watchlist.remove"],
    "watchlist.saved": (input, frame) =>
      online(input.kind, input.version) ? handlers["watchlist.saved"](input, frame) : denied(),
    "watchlist.save": (input, frame) =>
      online(input.kind, input.version) ? handlers["watchlist.save"](input, frame) : denied(),
    "viewing.get": (input, frame) => Effect.map(handlers["viewing.get"](input, frame), viewing),
    "viewing.setFavourite": (input, frame) =>
      online("channel", input.channel)
        ? Effect.map(handlers["viewing.setFavourite"](input, frame), viewing)
        : denied(),
    "viewing.recordWatch": (input, frame) =>
      online("channel", input.channel)
        ? Effect.map(handlers["viewing.recordWatch"](input, frame), viewing)
        : denied(),
    "viewing.recordProgress": (input, frame) =>
      titleRef(input.title)
        ? Effect.map(handlers["viewing.recordProgress"](input, frame), viewing)
        : denied(),
    "viewing.episodes": (input, frame) =>
      online("series", input.series)
        ? Effect.map(handlers["viewing.episodes"](input, frame), (series) => ({
            ...series,
            progress: series.progress.filter((item) => titleRef(item.title)),
          }))
        : denied(),
    "viewing.progress": (input, frame) =>
      (input.movies ?? []).every((ref) => online("movie", ref)) &&
      (input.series ?? []).every((ref) => online("series", ref))
        ? Effect.map(handlers["viewing.progress"](input, frame), (rows) =>
            rows.filter((row) => titleRef(row.title)),
          )
        : denied(),
    "viewing.removeFromContinue": (input, frame) =>
      (input.titles.movies ?? []).every((ref) => online("movie", ref)) &&
      (input.titles.series ?? []).every((ref) => online("series", ref))
        ? Effect.map(handlers["viewing.removeFromContinue"](input, frame), viewing)
        : denied(),
    "viewing.finishSeries": (input, frame) =>
      input.series.every((ref) => online("series", ref))
        ? Effect.map(handlers["viewing.finishSeries"](input, frame), viewing)
        : denied(),
    "viewing.undoMark": (input, frame) =>
      online("series", input.series) ? handlers["viewing.undoMark"](input, frame) : denied(),
    "viewing.reorderFavourites": (input, frame) =>
      [...input.original, ...input.order].every((ref) => online("channel", ref))
        ? Effect.map(handlers["viewing.reorderFavourites"](input, frame), viewing)
        : denied(),
    "viewing.markEpisode": (input, frame) =>
      titleRef(input.episode) ? handlers["viewing.markEpisode"](input, frame) : denied(),
    "viewing.markTitles": (input, frame) =>
      (
        input.scope.kind === "film"
          ? input.scope.versions.every((ref) => online("movie", ref))
          : online("series", input.scope.series)
      )
        ? handlers["viewing.markTitles"](input, frame)
        : denied(),
    "viewing.undoMarks": (input, frame) =>
      input.made.every((each) => online(each.kind, each.title))
        ? handlers["viewing.undoMarks"](input, frame)
        : denied(),
    "viewing.filmMarks": (input, frame) =>
      input.movies.every((ref) => online("movie", ref))
        ? handlers["viewing.filmMarks"](input, frame)
        : denied(),
    "viewing.history": (input, frame) =>
      Effect.map(handlers["viewing.history"](input, frame), (entries) =>
        entries.filter((entry) =>
          entry.kind === "movie" ? online("movie", entry.movie) : online("series", entry.series),
        ),
      ),
    "downloads.list": (input, frame) =>
      Effect.map(handlers["downloads.list"](input, frame), (list) =>
        visibleDownloads(list, allows),
      ),
    "recordings.rules": () => Effect.succeed([]),
    "recordings.schedules": () => Effect.succeed([]),
    "recordings.resume": (input, frame) =>
      Effect.map(handlers["recordings.resume"](input, frame), (result) => ({
        ...result,
        items: result.items.filter((item) => copy("recording", item.recording.id)),
      })),
    "recordings.list": (input, frame) =>
      Effect.map(handlers["recordings.list"](input, frame), (rows) =>
        rows.filter((row) => copy("recording", row.id)),
      ),
    "playback.openPane": (input, frame) =>
      online("channel", input.channel) &&
      (input.variant === undefined || online("channel", { ...input.channel, id: input.variant }))
        ? handlers["playback.openPane"](input, frame)
        : denied(),
    "playback.adoptPane": (input, frame) =>
      online("channel", input.channel) ? handlers["playback.adoptPane"](input, frame) : denied(),
    "playback.singlePane": (input, frame) =>
      online("channel", input.channel) ? handlers["playback.singlePane"](input, frame) : denied(),
    "playback.closePane": (input, frame) =>
      online("channel", input.channel) ? handlers["playback.closePane"](input, frame) : denied(),
    "playback.paneTimeline": (input, frame) =>
      online("channel", input.channel) ? handlers["playback.paneTimeline"](input, frame) : denied(),
    "playback.paneSeek": (input, frame) =>
      online("channel", input.channel) ? handlers["playback.paneSeek"](input, frame) : denied(),
    "playback.paneTracks": (input, frame) =>
      online("channel", input.channel) ? handlers["playback.paneTracks"](input, frame) : denied(),
    "playback.panePlaying": (input, frame) =>
      online("channel", input.channel) ? handlers["playback.panePlaying"](input, frame) : denied(),
    "playback.paneFailure": (input, frame) =>
      online("channel", input.channel) ? handlers["playback.paneFailure"](input, frame) : denied(),
    "playback.paneDiagnostic": (input, frame) =>
      online("channel", input.channel)
        ? handlers["playback.paneDiagnostic"](input, frame)
        : denied(),
    "playback.paneCapacity": (input, frame) =>
      online("channel", input.channel) ? handlers["playback.paneCapacity"](input, frame) : denied(),
    "playback.open": (input, frame) =>
      online("channel", input.channel) &&
      (!input.variant ||
        online("channel", { subscriptionId: input.channel.subscriptionId, id: input.variant }))
        ? handlers["playback.open"](input, frame)
        : denied(),
    "playback.openTitle": (input, frame) =>
      titleRef(input.title) ? handlers["playback.openTitle"](input, frame) : denied(),
    "playback.openCopy": (input, frame) =>
      Effect.flatMap(handlers["recordings.list"](undefined, frame), (rows) =>
        copy(rows.some((row) => row.id === input.copy) ? "recording" : "download", input.copy)
          ? handlers["playback.openCopy"](input, frame)
          : denied(),
      ),
    "downloads.recordProgress": (input, frame) =>
      copy("download", input.id) && (!input.owner || sameProfile(input.owner, owner))
        ? handlers["downloads.recordProgress"](input, frame)
        : denied(),
    "recordings.recordProgress": (input, frame) =>
      copy("recording", input.id) && (!input.owner || sameProfile(input.owner, owner))
        ? handlers["recordings.recordProgress"](input, frame)
        : denied(),
    "downloads.pauseAll": handlers["downloads.pauseAll"],
    "playback.close": handlers["playback.close"],
    "playback.closeAll": handlers["playback.closeAll"],
    "playback.tracks": handlers["playback.tracks"],
    "playback.timeline": handlers["playback.timeline"],
    "playback.seekLive": handlers["playback.seekLive"],
    "playback.playing": handlers["playback.playing"],
    "output.status": (input, frame) =>
      Effect.map(handlers["output.status"](input, frame), (status) =>
        visibleOutput(status, allows),
      ),
    "output.scan": handlers["output.scan"],
    "output.connect": handlers["output.connect"],
    "output.pick": handlers["output.pick"],
    "output.closePicker": handlers["output.closePicker"],
    "output.disconnect": handlers["output.disconnect"],
    "output.playChannel": (input, frame) =>
      online("channel", input.channel) &&
      (!input.variant ||
        online("channel", { subscriptionId: input.channel.subscriptionId, id: input.variant }))
        ? handlers["output.playChannel"](input, frame)
        : denied(),
    "output.openTitle": (input, frame) =>
      titleRef(input.title) ? handlers["output.openTitle"](input, frame) : denied(),
    "output.playTitle": handlers["output.playTitle"],
    "output.playingTitle": handlers["output.playingTitle"],
    "output.command": handlers["output.command"],
    "output.volume": handlers["output.volume"],
    "reminders.list": (input, frame) =>
      Effect.map(handlers["reminders.list"](input, frame), (list) => ({
        ...list,
        reminders: list.reminders.filter((item) => online("channel", item.channel)),
      })),
    "reminders.cancel": (input, frame) => changeReminder("reminders.cancel", input, frame),
    "reminders.dismiss": (input, frame) => changeReminder("reminders.dismiss", input, frame),
    "reminders.set": (input, frame) =>
      online("channel", input.channel) ? handlers["reminders.set"](input, frame) : denied(),
    "window.miniPlayerAvailable": handlers["window.miniPlayerAvailable"],
    "window.setMiniPlayer": handlers["window.setMiniPlayer"],
  };
}
