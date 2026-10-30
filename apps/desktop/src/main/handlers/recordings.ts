import { ownedId } from "@mrstreamer/contracts/subscription";
import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Library } from "../services/library.ts";
import type { Settings } from "../services/preferences.ts";
import type { Recordings } from "../services/recordings.ts";
import { streamsOf } from "./streams.ts";

export function recordingHandlers({
  recordings,
  library,
  settings,
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
  >;
  readonly library: Pick<Library["Service"], "channel">;
  readonly settings: Pick<Settings["Service"], "get" | "ofSubscription">;
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
  };
}
