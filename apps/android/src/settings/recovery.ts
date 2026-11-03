import type { ConnectedSource, SourcesOwner } from "../connect/sources.ts";
import type { Release } from "../player/native.ts";
import type { PlayerOwner } from "../player/player.ts";

export interface RemovalResult {
  readonly erase: "removed" | "partial" | "refused" | "statistics-not-cleared";
  readonly release: readonly Release[];
}

/** This phone no longer has the source's login, so it needs its password or link again. */
export function needsLogin(source: ConnectedSource): boolean {
  return source.channels.kind === "failed" && source.channels.error.kind === "needs-secret";
}

/**
 * Settings' provider removal: release only this source's playback, then erase it. A refused erase
 * that left the source listed without its login is `partial`; the last removal clears statistics.
 */
export function providerRecovery(
  owner: SourcesOwner,
  discardStatistics: () => boolean,
  player: Pick<PlayerOwner, "release">,
) {
  const listed = (id: string) => {
    const now = owner.state.get();

    return now.kind === "ready" ? now.sources.find((each) => each.id === id) : undefined;
  };

  return {
    async remove(id: string): Promise<RemovalResult> {
      const release = await player.release(
        (hold) => hold.kind === "source" && hold.sourceId === id,
      );

      try {
        await owner.remove(id);
      } catch {
        const source = listed(id);

        return { erase: source && needsLogin(source) ? "partial" : "refused", release };
      }

      const now = owner.state.get();

      if (now.kind === "ready" && now.sources.length === 0 && !discardStatistics())
        return { erase: "statistics-not-cleared", release };

      return { erase: "removed", release };
    },
  };
}
