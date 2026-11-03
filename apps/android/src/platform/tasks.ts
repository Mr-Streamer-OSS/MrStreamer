import type { InTasks } from "@mrstreamer/core/steps";

// Long work on the one JS thread that also handles taps and Back: core's paced steps, a few slices
// per task, as the iOS app runs them (apps/ios/src/library.ts `inTasks`).

/** How long one task works through steps before it lets input through; chosen, not measured. */
const TASK_MS = 8;

/** Works `steps` out a few slices per task, resolving null once `wanted` fails. */
export const inTasks: InTasks = async (steps, wanted) => {
  for (;;) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    if (!wanted()) return null;
    const started = Date.now();

    do {
      const next = steps.next();

      if (next.done) return next.value;
    } while (Date.now() - started < TASK_MS);
  }
};
