// One run of the AirPlay helper: starts the program, reads its lines, pairs each command with
// its answer under a deadline, and sees to it that the process ends. The adapter above decides
// when a run starts and what its events mean.
import { spawn } from "node:child_process";
import { withoutAddresses } from "@mrstreamer/core/provider";
import { ReceiverFailed } from "../adapter.ts";
import { MAX_LINE, PROTOCOL, readEvent, type HelperCommand, type HelperEvent } from "./protocol.ts";

/**
 * How a run ended: `asked` to, by `stop`; `crashed`, which includes one killed for not answering;
 * or `unusable`, when the program didn't start or speaks another protocol, so a new run would do
 * no better.
 */
export type HelperEnd = "asked" | "crashed" | "unusable";

export interface HelperRun {
  /**
   * Sends a command and resolves once the helper answered it. Rejects with `ReceiverFailed` when
   * the helper refuses it, is gone, or doesn't answer in time, which also ends the run.
   */
  send(command: HelperCommand): Promise<void>;
  /** Asks the helper to quit and kills it when it hasn't in time. Resolves once it is gone. */
  stop(): Promise<void>;
}

export interface HelperOptions {
  readonly helper: string;
  readonly args: readonly string[];
  /** Milliseconds for the helper to say `hello`, and to answer a command. */
  readonly start: number;
  readonly answer: number;
  /** Milliseconds for the helper to exit once asked, before it is killed. */
  readonly quit: number;
  /** Everything but `hello` and the answers, in the order the helper said it. */
  readonly onEvent: (event: HelperEvent) => void;
  /** Once, when the process is gone. */
  readonly onEnd: (end: HelperEnd) => void;
  /** Each line the helper wrote and each command sent, addresses cut to their origin. */
  readonly log: (line: string) => void;
}

export const unavailable = (detail: string) => new ReceiverFailed({ kind: "unavailable", detail });

/** Splits what arrives into lines, dropping a line longer than `MAX_LINE` whole. */
function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let pending = "";
  let skipping = false;
  return (chunk) => {
    let start = 0;
    for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
      const line = pending + chunk.slice(start, end);
      if (!skipping && line.length <= MAX_LINE) onLine(line);
      pending = "";
      skipping = false;
      start = end + 1;
    }
    pending += chunk.slice(start);
    if (pending.length > MAX_LINE) {
      pending = "";
      skipping = true;
    }
  };
}

export function startHelper(options: HelperOptions): HelperRun {
  const child = spawn(options.helper, options.args, { stdio: ["pipe", "pipe", "pipe"] });
  /** The commands not yet answered, by id. */
  const waiting = new Map<number, (refusal?: ReceiverFailed) => void>();
  const greeted = Promise.withResolvers<void>();
  const gone = Promise.withResolvers<void>();
  // A run that ends before anything was sent leaves no unhandled rejection.
  greeted.promise.catch(() => {});
  let commands = 0;
  /** Why the process was killed from here, when it was. */
  let given: HelperEnd | null = null;
  let asked = false;
  let finished = false;
  let quitting: NodeJS.Timeout | undefined;

  /** Ends a run that is no use: the process is killed, and its close settles the rest. */
  const giveUp = (end: HelperEnd) => {
    given ??= end;
    child.kill("SIGKILL");
  };
  const starting = setTimeout(() => giveUp("crashed"), options.start);

  const finish = (end: HelperEnd) => {
    if (finished) return;
    finished = true;
    clearTimeout(starting);
    clearTimeout(quitting);
    const stopped = unavailable("the AirPlay helper stopped");
    greeted.reject(stopped);
    for (const settle of [...waiting.values()]) settle(stopped);
    options.onEnd(asked ? "asked" : (given ?? end));
    gone.resolve();
  };

  const write = (line: string) => {
    options.log(`> ${withoutAddresses(line)}`);
    // The helper may be gone before a command is written; its close says so.
    if (child.stdin.writable) child.stdin.write(`${line}\n`);
  };

  const heard = (line: string) => {
    options.log(`< ${withoutAddresses(line)}`);
    const event = readEvent(line);
    if (!event) return;
    if (event.type === "hello") {
      clearTimeout(starting);
      if (event.protocol === PROTOCOL) greeted.resolve();
      else giveUp("unusable");
    } else if (event.type === "answer") {
      const refusal = event.ok
        ? undefined
        : unavailable(withoutAddresses(event.error ?? "refused"));
      waiting.get(event.id)?.(refusal);
    } else {
      options.onEvent(event);
    }
  };

  child.stdout.setEncoding("utf8").on("data", lineReader(heard));
  child.stderr.setEncoding("utf8").on(
    "data",
    lineReader((line) => options.log(`! ${withoutAddresses(line)}`)),
  );
  child.stdin.on("error", () => {});
  // Without a process there is no close: the program is missing or can't run.
  child.on("error", () => finish("unusable"));
  // After its output was read whole, so its last lines count.
  child.on("close", () => finish("crashed"));

  return {
    async send(command) {
      await greeted.promise;
      if (finished) throw unavailable("the AirPlay helper stopped");
      const id = ++commands;
      const answered = Promise.withResolvers<void>();
      const late = setTimeout(() => {
        waiting.delete(id);
        answered.reject(unavailable("the AirPlay helper did not answer"));
        giveUp("crashed");
      }, options.answer);
      waiting.set(id, (refusal) => {
        clearTimeout(late);
        waiting.delete(id);
        if (refusal) answered.reject(refusal);
        else answered.resolve();
      });
      write(JSON.stringify({ id, ...command }));
      return answered.promise;
    },

    stop() {
      if (!asked && !finished) {
        asked = true;
        write(JSON.stringify({ id: ++commands, cmd: "quit" }));
        quitting = setTimeout(() => child.kill("SIGKILL"), options.quit);
      }
      return gone.promise;
    },
  };
}
