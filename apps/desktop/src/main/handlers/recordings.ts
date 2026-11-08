import { sameProfile, type ActiveProfile } from "@mrstreamer/contracts/profiles";
import type { ProfileAdmission } from "../services/profiles.ts";
import { allowsApproval } from "../services/profile-policy.ts";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { Failed } from "@mrstreamer/core/failure";
import { t } from "@mrstreamer/core/i18n";
import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Library } from "../services/library.ts";
import type { Settings } from "../services/preferences.ts";
import type { Recordings } from "../services/recordings.ts";
import { streamsOf } from "./streams.ts";

/** Read only for the captured admission, including the returned projection's owner. */
export function recordingResume(
  recordings: Pick<Recordings["Service"], "resume">,
  owner: ActiveProfile,
) {
  return Effect.gen(function* () {
    const result = yield* recordings.resume(owner);

    if (!sameProfile(result.owner, owner))
      return yield* new Failed({
        error: { kind: "unexpected", detail: t("Viewing profile changed; retry this request.") },
      });

    return result;
  });
}

export function publishRecordingProgress(
  admission: ProfileAdmission,
  change: { readonly owner: ActiveProfile; readonly id: string },
  publish: () => void,
) {
  return admission.run(
    Effect.gen(function* () {
      if (
        !sameProfile(admission.owner, change.owner) ||
        !allowsApproval(admission.approved, { kind: "recording", id: change.id })
      )
        return;
      yield* admission.current;
      publish();
    }),
  );
}

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
    | "rules"
    | "previewRule"
    | "saveRule"
    | "cancelRule"
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
    "recordings.resume": () =>
      Effect.fail(
        new Failed({
          error: { kind: "unexpected", detail: t("Viewing profile changed; retry this request.") },
        }),
      ),
    "recordings.list": () => recordings.list,
    "recordings.connections": ({ subscriptionId, channel: named }) =>
      Effect.gen(function* () {
        if (!named || named.subscriptionId !== subscriptionId)
          return yield* recordings.connections(subscriptionId);

        // A channel that can't be looked up still gets the count, without sharing.
        const of = yield* library.channel(named).pipe(
          Effect.flatMap((channel) =>
            Effect.map(streamsOf(settings, channel, undefined), (variants) => ({
              channel: channel.id,
              variants,
            })),
          ),
          Effect.orElseSucceed(() => undefined),
        );

        return yield* recordings.connections(subscriptionId, of);
      }),
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
    "recordings.rules": () => recordings.rules,
    "recordings.previewRule": ({ plan, id }) => recordings.previewRule(plan, id),
    "recordings.saveRule": ({ plan, id }) => recordings.saveRule(plan, id),
    "recordings.cancelRule": ({ id }) => Effect.as(recordings.cancelRule(id), null),
    "recordings.schedules": () => recordings.schedules,
    "recordings.plan": ({ plan, id }) => recordings.plan(plan, id),
    "recordings.schedule": ({ plan, id }) => recordings.schedule(plan, id),
    "recordings.cancel": ({ id }) => Effect.as(recordings.cancel(id), null),
    "recordings.recordProgress": ({ id, position, duration, owner }) =>
      Effect.as(recordings.recordProgress(id, position, duration, owner), null),
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
