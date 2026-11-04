import { type } from "arktype";
import { store } from "../platform/store.ts";

const Row = type({
  "+": "delete",
  id: "string",
  key: "string",
  sourceId: "string",
  title: "string",
  sourceLabel: "string",
  kind: "'movie' | 'episode'",
  mediaId: "string",
  container: "string",
  state: "'queued' | 'running' | 'paused' | 'failed' | 'complete' | 'removing'",
  bytes: "number >= 0",
  total: "number >= 0",
  reason: "string",
  "year?": "number | null",
  "duration?": "number | null",
  "season?": "number",
  "episode?": "number",
  "episodeName?": "string",
  "blocked?": "boolean",
  "poster?": "string",
  "artwork?": "string",
});

const Snapshot = type({ rows: Row.array(), free: "number >= 0", "notifications?": "boolean" });

export type DownloadRow = typeof Row.infer;

export type Action = "pause" | "resume" | "retry" | "cancel" | "remove" | "up" | "down";

type DownloadOperation = () => Promise<void>;

type DownloadActionKey = string | DownloadOperation;

export interface TransferPort {
  restore(): Promise<string>;
  snapshot(): Promise<string>;
  enqueue(json: string): Promise<string>;
  cacheArtwork(id: string, address: string): Promise<void>;
  command(id: string, action: Action): Promise<void>;
  path(id: string): Promise<string>;
  filePath(id: string): Promise<string>;
  blockSource(sourceId: string, blocked: boolean): Promise<void>;
}

export type DownloadState = {
  readonly rows: readonly DownloadRow[];
  readonly free: number;
  readonly loading: boolean;
  readonly notifications: boolean;
  readonly error: "read" | "write" | null;
};

/** Native state is authoritative. A failed read retains the last observed rows and stays retryable. */
export function downloadState(port: TransferPort) {
  const state = store<DownloadState>({
    rows: [],
    free: 0,
    loading: true,
    notifications: false,
    error: null,
  });

  let serial = Promise.resolve();
  let failedAction: (() => Promise<void>) | undefined;
  let writeFailed = false;
  let failedKey: DownloadActionKey | undefined;
  let restored = false;

  function publish(next: DownloadState) {
    if (JSON.stringify(state.get()) !== JSON.stringify(next)) state.set(next);
  }

  function run(operation: () => Promise<void>) {
    const next = serial.then(operation);
    serial = next.catch(() => {});

    return next;
  }

  async function read(restore: boolean) {
    try {
      const parsed = Snapshot(
        JSON.parse(await (restore && !restored ? port.restore() : port.snapshot())),
      );

      if (parsed instanceof type.errors) throw new Error("snapshot");

      if (restore) restored = true;
      publish({
        ...parsed,
        notifications: parsed.notifications ?? false,
        loading: false,
        error: writeFailed ? "write" : null,
      });
    } catch {
      state.set((old) => ({ ...old, loading: false, error: "read" }));
    }
  }

  function change(
    operation: DownloadOperation,
    key: DownloadActionKey = operation,
    retry?: () => Promise<void>,
  ) {
    return run(async () => {
      try {
        await operation();

        if (!failedAction || failedKey === key) {
          failedAction = undefined;
          writeFailed = false;
        }
      } catch {
        failedAction = retry ?? (() => change(operation, key));
        failedKey = key;
        writeFailed = true;
        state.set((old) => ({ ...old, error: "write" }));

        return;
      }

      await read(false);
    });
  }

  return {
    state,
    retry: () => (failedAction ? failedAction() : run(() => read(true))),
    refresh: (restore = false) => run(() => read(restore)),
    change,
  };
}
