// Indexes guide documents in worker threads (../guide/index-worker.ts), one per document. Reading
// a large guide is a minute of steady work, and SQLite holds whichever thread writes to it: on
// the main process, single writes of a few thousand programmes took up to 600 ms on the
// measured 1.2-million-programme guide. In a worker the main process only hears how far it got.
// Stopping one ends its thread, and what it had written goes with it.
import { rm } from "node:fs/promises";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { GuideBuild, GuideIndexSummary } from "@mrstreamer/core/guide/index-file";
import { GuideIndexer } from "@mrstreamer/core/guide/service";
import * as Layer from "effect/Layer";

/** What an indexing worker tells the main process. */
export type GuideIndexMessage =
  | { readonly kind: "progress"; readonly programmes: number }
  | { readonly kind: "done"; readonly summary: GuideIndexSummary }
  | { readonly kind: "failed"; readonly error: AppError };

/**
 * The memory a worker may take. A thread's memory stays with the process once it ends, as its
 * allocator keeps it for the next: bounded, the next build reuses it rather than adding to it.
 * Reading the 1.2-million-programme guide used under 64 MB of heap.
 */
const WORKER_LIMITS: WorkerOptions["resourceLimits"] = {
  maxOldGenerationSizeMb: 96,
  maxYoungGenerationSizeMb: 16,
};

/**
 * The indexer that starts a worker per document with `start`, given what the worker reads and
 * how much memory it may take: the bundled worker, or its source in tests.
 */
export function guideIndexerLayer(
  start: (options: WorkerOptions & { workerData: GuideBuild }) => Worker,
): Layer.Layer<GuideIndexer> {
  return Layer.succeed(GuideIndexer, {
    build: (build, progress, signal) =>
      new Promise<GuideIndexSummary>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        // Its own output, not piped to the main process's: starting it never sets that up, and
        // what it has to say comes as a message.
        const worker = start({
          workerData: build,
          resourceLimits: WORKER_LIMITS,
          stdout: true,
          stderr: true,
        });
        let ended = false;
        /** Ends the worker once, and then settles: a worker stopped half way leaves no file. */
        const end = (settle: () => void, unfinished: boolean) => {
          if (ended) return;
          ended = true;
          signal.removeEventListener("abort", stop);
          void worker
            .terminate()
            .then(() =>
              unfinished
                ? Promise.all([
                    rm(`${build.target}.part`, { force: true }),
                    rm(build.target, { force: true }),
                  ])
                : undefined,
            )
            .finally(settle);
        };
        const stop = () => end(() => reject(signal.reason), true);
        signal.addEventListener("abort", stop, { once: true });
        worker.on("message", (message: GuideIndexMessage) => {
          if (message.kind === "progress") progress(message.programmes);
          else if (message.kind === "done") end(() => resolve(message.summary), false);
          else end(() => reject(new AppFailure(message.error)), false);
        });
        worker.on("error", (cause) => end(() => reject(cause), true));
        worker.on("exit", (code) =>
          end(() => reject(new Error(`The guide's indexer stopped with ${code}.`)), true),
        );
      }),
  });
}
