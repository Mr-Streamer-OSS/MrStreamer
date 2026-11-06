import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Downloads } from "../services/downloads.ts";

export function downloadHandlers({
  downloads,
  chooseFolder,
}: {
  readonly chooseFolder: (current: string) => Promise<string | null>;
  readonly downloads: Pick<
    Downloads["Service"],
    | "folder"
    | "setFolder"
    | "cancelMove"
    | "bulk"
    | "list"
    | "add"
    | "remove"
    | "retry"
    | "pause"
    | "resume"
    | "pauseAll"
    | "resumeAll"
    | "move"
    | "recordProgress"
  >;
}): HandlersFor<"downloads"> {
  return {
    "downloads.chooseFolder": () =>
      Effect.gen(function* () {
        const current = yield* downloads.folder;
        const path = yield* Effect.promise(() => chooseFolder(current.path));

        if (path === null) return null;
        yield* downloads.setFolder(path);

        return yield* downloads.folder;
      }),
    "downloads.cancelMove": ({ id }) => Effect.as(downloads.cancelMove(id), null),
    "downloads.bulk": ({ ids, action }) => downloads.bulk(ids, action),
    "downloads.list": () => downloads.list,
    "downloads.add": ({ title }) => downloads.add(title),
    "downloads.remove": ({ id }) => Effect.as(downloads.remove(id), null),
    "downloads.retry": ({ id }) => Effect.as(downloads.retry(id), null),
    "downloads.pause": ({ id }) => Effect.as(downloads.pause(id), null),
    "downloads.resume": ({ id }) => Effect.as(downloads.resume(id), null),
    "downloads.pauseAll": () => Effect.as(downloads.pauseAll, null),
    "downloads.resumeAll": () => Effect.as(downloads.resumeAll, null),
    "downloads.move": ({ id, by }) => Effect.as(downloads.move(id, by), null),
    "downloads.recordProgress": ({ id, position, duration }) =>
      Effect.as(downloads.recordProgress(id, position, duration), null),
  };
}
