// A stand-in for the AirPlay helper, for tests. The adapter starts a real process, the small
// relay in fake-airplay-helper.mjs, which passes its lines to this file over a local socket; the
// helper's part is played here, where a test can drive it. It writes the helper's JSON lines
// itself, so it shares nothing with the adapter but the types.
//
// By itself it does what the helper always does at once: says hello and its volume, answers
// every command, opens the list on `showPicker`, closes it on `hidePicker`, says `loading` for a
// load and `stopped` for one that is stopped, replaced or unloaded, and exits on `quit`. A test
// plays the system, the viewer and the receiver: `routes`, `choose`, `dismiss`, `external`,
// `status`, `fail`. It breaks things with `crash` and `silence`, and says anything at all with
// `emit` (any event) and `write` (any line).
//
//   const helper = await startFakeAirplayHelper();
//   const adapter = airplayAdapter({ helper: helper.helper, args: helper.args });
//   const connecting = adapter.connect({ kind: "picker", anchor }, signal);
//   await helper.took("showPicker");
//   helper.choose();
//   const connection = await connecting;
//   await connection.load(media, signal);
//   helper.status("playing", 12, 180);
import { createServer, type AddressInfo, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { TransportState } from "../src/main/receivers/adapter.ts";
import type { HelperCommand, HelperEvent } from "../src/main/receivers/airplay/protocol.ts";

/** A command as an adapter sent it, with the id its answer names. */
type SentCommand = HelperCommand & { readonly id: number };

export interface FakeAirplayHelper {
  /** What starts it, for `airplayAdapter`'s options of the same names. */
  readonly helper: string;
  readonly args: readonly string[];
  /** Every command taken so far, oldest first, across restarts. */
  readonly commands: readonly SentCommand[];
  /** The process id of every start, oldest first. */
  readonly pids: readonly number[];
  /** Those of them the system still knows. */
  running(): readonly number[];
  /** The next `cmd` command not handed out before, once it has arrived. */
  took<C extends HelperCommand["cmd"]>(cmd: C): Promise<Extract<SentCommand, { cmd: C }>>;
  /** Whether the system sees a receiver, said now when it is being asked. */
  routes(available: boolean): void;
  /** The viewer picks a receiver: the list closes, then external playback comes on. */
  choose(): void;
  /** The viewer closes the list without picking. */
  dismiss(): void;
  /** External playback comes on, or goes off. */
  external(active: boolean): void;
  /** The player's word on the load it holds. `ended` is a real end. */
  status(state: TransportState, position?: number, duration?: number | null): void;
  /** The load it holds can't play. */
  fail(message: string): void;
  /** Says any event as it is, also one about an earlier load. */
  emit(event: HelperEvent): void;
  /** Writes any line, as one that isn't an event. */
  write(line: string): void;
  /** From now on it answers nothing, and stays when asked to quit or left without its stdin. */
  silence(): void;
  /** The running process exits as from a crash. */
  crash(): void;
  /** Ends every process and the socket. */
  close(): Promise<void>;
}

/** Starts the stand-in. `protocol` is what it names in `hello`, for one of another build. */
export async function startFakeAirplayHelper(
  options: { readonly protocol?: number } = {},
): Promise<FakeAirplayHelper> {
  const commands: SentCommand[] = [];
  const pids: number[] = [];
  const sockets = new Set<Socket>();
  /** How many of each command `took` handed out, and who waits for more. */
  const handed = new Map<string, number>();
  let arrived = Promise.withResolvers<void>();
  /** The process started last, while it runs: the one a test drives. */
  let current: Socket | null = null;
  let silent = false;
  let seen = false;
  let detecting = false;
  /** The `showPicker` whose list is up. */
  let list: number | null = null;
  /** The load the player holds. */
  let generation: number | null = null;

  const emit = (event: HelperEvent) => current?.write(`=${JSON.stringify(event)}\n`);

  const closeList = () => {
    if (list !== null) emit({ type: "picker", request: list, state: "closed" });
    list = null;
  };

  /** The player lets go of its load, and says so. */
  const forget = () => {
    if (generation !== null) {
      emit({ type: "status", generation, state: "stopped", position: 0, duration: null });
    }
    generation = null;
  };

  const take = (from: Socket, command: SentCommand) => {
    commands.push(command);
    arrived.resolve();
    arrived = Promise.withResolvers();
    if (silent) return;
    from.write(`=${JSON.stringify({ type: "answer", id: command.id, ok: true })}\n`);
    if (command.cmd === "quit") from.write("!exit 0\n");
    if (from !== current) return;
    switch (command.cmd) {
      case "detect":
        detecting = command.on;
        if (detecting) emit({ type: "routes", available: seen });
        break;
      case "showPicker":
        list = command.request;
        emit({ type: "picker", request: list, state: "opened" });
        break;
      case "hidePicker":
        closeList();
        break;
      case "load":
        forget();
        generation = command.generation;
        emit({
          type: "status",
          generation,
          state: "loading",
          position: command.position,
          duration: null,
        });
        break;
      case "stop":
        if (command.generation === generation) forget();
        break;
      case "unload":
        forget();
        break;
    }
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      if (current === socket) current = null;
    });
    // A killed process resets the socket, and readline passes that on as an error of its own.
    const lines = createInterface({ input: socket }).on("error", () => {});
    // The relay names its process first; everything after is the adapter's.
    lines.once("line", (pid) => {
      pids.push(Number(pid));
      current = socket;
      detecting = false;
      list = null;
      generation = null;
      if (silent) {
        socket.write("!stay\n");
      } else {
        emit({ type: "hello", protocol: options.protocol ?? 1 });
        emit({ type: "volume", level: 1, muted: false });
      }
      lines.on("line", (line) => take(socket, JSON.parse(line) as SentCommand));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    helper: process.execPath,
    args: [
      fileURLToPath(new URL("./fake-airplay-helper.mjs", import.meta.url)),
      String((server.address() as AddressInfo).port),
    ],
    commands,
    pids,
    running: () =>
      pids.filter((pid) => {
        try {
          return process.kill(pid, 0);
        } catch {
          return false;
        }
      }),
    async took(cmd) {
      const index = handed.get(cmd) ?? 0;
      handed.set(cmd, index + 1);
      for (;;) {
        const found = commands.filter((command) => command.cmd === cmd)[index];
        if (found) return found as Extract<SentCommand, { cmd: typeof cmd }>;
        await arrived.promise;
      }
    },
    routes(available) {
      seen = available;
      if (detecting) emit({ type: "routes", available });
    },
    choose() {
      closeList();
      emit({ type: "external", active: true });
    },
    dismiss: closeList,
    external: (active) => void emit({ type: "external", active }),
    status(state, position = 0, duration = null) {
      if (generation === null) throw new Error("The fake helper holds no load.");
      emit({ type: "status", generation, state, position, duration });
    },
    fail(message) {
      if (generation === null) throw new Error("The fake helper holds no load.");
      emit({ type: "failed", generation, message });
      generation = null;
    },
    emit: (event) => void emit(event),
    write: (line) => void current?.write(`=${line}\n`),
    silence() {
      silent = true;
      current?.write("!stay\n");
    },
    crash: () => void current?.write("!exit 1\n"),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
