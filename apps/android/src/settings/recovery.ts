import type { ConnectedSource, SourcesOwner } from "../connect/sources.ts";
import type { Release } from "../player/native.ts";
import type { PlayerOwner } from "../player/player.ts";

export interface RemovalResult {
  readonly erase:
    "removed" | "partial" | "refused" | "statistics-not-cleared" | "history-not-cleared";
  readonly release: readonly Release[];
  readonly historyNotCleared?: boolean;
}

/** This phone no longer has the source's login, so it needs its password or link again. */
export function needsLogin(source: ConnectedSource): boolean {
  return (
    source.channels.kind === "failed" &&
    (source.channels.error.kind === "needs-secret" ||
      source.channels.error.kind === "invalid-login")
  );
}

/**
 * Settings' provider removal: release only this source's playback, then erase it. A refused erase
 * that left the source listed without its login is `partial`; the last removal clears statistics.
 */
export function providerRecovery(
  owner: SourcesOwner,
  discardStatistics: () => boolean,
  player: Pick<PlayerOwner, "release">,
  clearHistory: (id: string) => Promise<void> = async () => {},
) {
  const listed = (id: string) => {
    const now = owner.state.get();

    return now.kind === "ready" ? now.sources.find((each) => each.id === id) : undefined;
  };

  const pending = new Map<string, Promise<RemovalResult>>();

  async function remove(id: string, deleteHistory: boolean): Promise<RemovalResult> {
    const release: Release[] = [];

    const matches: Parameters<PlayerOwner["release"]>[0] = (hold) =>
      hold.kind === "source" && hold.sourceId === id;

    try {
      // Drain holds admitted while an earlier release was waiting, without an endless loop.
      for (let attempt = 0; attempt < 5; attempt++) {
        const released = await player.release(matches);
        release.push(...released);

        if (released.length === 0) break;

        if (attempt === 4) return { erase: "refused", release };
      }
    } catch {
      return { erase: "refused", release };
    }

    const before = listed(id);

    try {
      await owner.remove(id);
    } catch {
      const source = listed(id);

      return {
        erase:
          source?.channels !== before?.channels &&
          source?.channels.kind === "failed" &&
          source.channels.error.kind === "needs-secret"
            ? "partial"
            : "refused",
        release,
      };
    }

    let historyFailed = false;

    if (deleteHistory) {
      try {
        await clearHistory(id);
      } catch {
        historyFailed = true;
      }
    }

    const now = owner.state.get();

    if (now.kind === "ready" && now.sources.length === 0 && !discardStatistics())
      return { erase: "statistics-not-cleared", release, historyNotCleared: historyFailed };

    return { erase: historyFailed ? "history-not-cleared" : "removed", release };
  }

  return {
    get isRemoving() {
      return pending.size > 0;
    },
    remove(id: string, deleteHistory = false): Promise<RemovalResult> {
      const active = pending.get(id);

      if (active) return active;
      const work = remove(id, deleteHistory).finally(() => pending.delete(id));
      pending.set(id, work);

      return work;
    },
  };
}
