// Runs guide searches in a worker thread (../guide/search-worker.ts): a search reads as many
// programmes as its words find, which on a large guide holds whatever thread runs it for hundreds
// of milliseconds. One worker, started with the first search and kept until the app quits, takes
// them in turn. One that stops fails what it had been asked, and the next search starts another.
import type { Worker, WorkerOptions } from "node:worker_threads";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type {
  EachFound,
  EachSearch,
  FirstFound,
  FirstSearch,
} from "@mrstreamer/core/guide/index-file";
import { GuideSearcher } from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** What the main process asks the search worker. */
export type GuideSearchRequest =
  | { readonly id: number; readonly kind: "first"; readonly search: FirstSearch }
  | { readonly id: number; readonly kind: "each"; readonly search: EachSearch };

/** What the search worker answers, by the request's id. */
export type GuideSearchReply =
  | { readonly id: number; readonly kind: "first"; readonly found: FirstFound }
  | { readonly id: number; readonly kind: "each"; readonly found: EachFound }
  | { readonly id: number; readonly kind: "failed"; readonly error: AppError };

/** The memory the search worker may take: a search keeps little besides what it found. */
const WORKER_LIMITS: WorkerOptions["resourceLimits"] = {
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
};

/** The searcher that runs searches in the worker `start` starts: the bundled one, or its source. */
export function guideSearcherLayer(
  start: (options: WorkerOptions) => Worker,
): Layer.Layer<GuideSearcher> {
  return Layer.effect(
    GuideSearcher,
    Effect.acquireRelease(
      Effect.sync(() => {
        let worker: Worker | null = null;
        let next = 0;
        const waiting = new Map<number, (reply: GuideSearchReply | Error) => void>();
        /** The worker, started when none runs. */
        const running = () => {
          if (worker) return worker;
          const started = start({ resourceLimits: WORKER_LIMITS, stdout: true, stderr: true });
          started.on("message", (reply: GuideSearchReply) => {
            waiting.get(reply.id)?.(reply);
            waiting.delete(reply.id);
          });
          const stopped = (cause: Error) => {
            if (worker !== started) return;
            worker = null;
            for (const settle of waiting.values()) settle(cause);
            waiting.clear();
          };
          started.on("error", stopped);
          started.on("exit", (code) =>
            stopped(new Error(`The guide's search stopped with ${code}.`)),
          );
          worker = started;
          return started;
        };
        /** Asks the worker, answering with what `pick` takes of its reply. */
        const ask = <A>(
          request: GuideSearchRequest,
          pick: (reply: GuideSearchReply) => A | undefined,
        ): Promise<A> =>
          new Promise<A>((resolve, reject) => {
            waiting.set(request.id, (reply) => {
              if (reply instanceof Error) return reject(reply);
              if (reply.kind === "failed") return reject(new AppFailure(reply.error));
              const found = pick(reply);
              if (found === undefined) reject(new Error("The guide's search answered another."));
              else resolve(found);
            });
            running().postMessage(request);
          });
        return {
          first: (search: FirstSearch) =>
            ask({ id: next++, kind: "first", search }, (reply) =>
              reply.kind === "first" ? reply.found : undefined,
            ),
          each: (search: EachSearch) =>
            ask({ id: next++, kind: "each", search }, (reply) =>
              reply.kind === "each" ? reply.found : undefined,
            ),
          stop: () => worker?.terminate(),
        };
      }),
      (searcher) => Effect.promise(async () => void (await searcher.stop())),
    ),
  );
}
