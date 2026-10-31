import { ownedId } from "@mrstreamer/contracts/subscription";
import { Failed } from "@mrstreamer/core/failure";
import { t } from "@mrstreamer/core/i18n";
import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Library } from "../services/library.ts";
import type { Settings } from "../services/preferences.ts";
import type { Recordings } from "../services/recordings.ts";
import { streamsOf } from "./streams.ts";

/**
 * The window's recordings methods. `chooseFolder` asks the viewer for a folder, answering null when
 * they cancel; `openFolder` shows one in the system's file manager.
 */
export function recordingHandlers({
  recordings,
  library,
  settings,
  chooseFolder,
  openFolder,
}: {
  readonly recordings: Pick<
    Recordings["Service"],
    | "list"
    | "connections"
    | "start"
    | "stop"
    | "remove"
    | "schedules"
    | "plan"
    | "schedule"
    | "cancel"
    | "recordProgress"
    | "storage"
    | "setLimits"
    | "setFolder"
  >;
  readonly library: Pick<Library["Service"], "channel">;
  readonly settings: Pick<Settings["Service"], "get" | "ofSubscription">;
  readonly chooseFolder: (current: string) => Promise<string | null>;
  readonly openFolder: (folder: string) => Promise<void>;
}): HandlersFor<"recordings"> {
  return {
    "recordings.list": () => recordings.list,
    "recordings.connections": ({ subscriptionId }) => recordings.connections(subscriptionId),
    "recordings.start": ({ channel: named, variant, stop, stopPlaying }) =>
      Effect.gen(function* () {
        const channel = yield* library.channel(named);
        const variants = yield* streamsOf(settings, channel, variant);
        return yield* recordings.start(ownedId(channel), stop, {
          variants,
          stopPlaying: stopPlaying ?? false,
        });
      }),
    "recordings.stop": ({ id }) => Effect.as(recordings.stop(id), null),
    "recordings.remove": ({ id }) => Effect.as(recordings.remove(id), null),
    "recordings.schedules": () => recordings.schedules,
    "recordings.plan": ({ plan, id }) => recordings.plan(plan, id),
    "recordings.schedule": ({ plan, id }) => recordings.schedule(plan, id),
    "recordings.cancel": ({ id }) => Effect.as(recordings.cancel(id), null),
    "recordings.recordProgress": ({ id, position, duration }) =>
      Effect.as(recordings.recordProgress(id, position, duration), null),
    "recordings.storage": () => recordings.storage,
    "recordings.setLimits": (limits) => recordings.setLimits(limits),
    "recordings.chooseFolder": () =>
      Effect.gen(function* () {
        const { folder } = yield* recordings.storage;
        const chosen = yield* Effect.tryPromise({
          try: () => chooseFolder(folder),
          catch: () =>
            new Failed({
              error: { kind: "unexpected", detail: t("The folder couldn't be opened.") },
            }),
        });
        return chosen ? yield* recordings.setFolder(chosen) : yield* recordings.storage;
      }),
    "recordings.openFolder": () =>
      Effect.gen(function* () {
        const { folder } = yield* recordings.storage;
        yield* Effect.tryPromise({
          try: () => openFolder(folder),
          catch: () =>
            new Failed({
              error: { kind: "unexpected", detail: t("The folder couldn't be opened.") },
            }),
        });
        return null;
      }),
  };
}
