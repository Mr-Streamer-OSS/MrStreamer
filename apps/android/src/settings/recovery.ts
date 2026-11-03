import type { ConnectedSource, SourcesOwner } from "../connect/sources.ts";
import type { Release } from "../player/native.ts";
import type { PlayerOwner } from "../player/player.ts";

export interface RemovalResult {
  readonly erase: "removed" | "partial" | "refused" | "statistics-not-cleared";
  readonly release: readonly Release[];
}

export function recoveryAction(source: ConnectedSource): "enter-login" | "retry" {
  return source.channels.kind === "failed" && source.channels.error.kind === "needs-secret"
    ? "enter-login"
    : "retry";
}

/** Retry and reload channels use the source owner's authenticated list load. */
export function providerRecovery(
  owner: SourcesOwner,
  discardStatistics: () => boolean,
  player: Pick<PlayerOwner, "release">,
) {
  return {
    retry: (id: string) => owner.retry(id),
    reloadChannels: (id: string) => owner.retry(id),
    async remove(id: string): Promise<RemovalResult> {
      const release = await player.release(
        (hold) => hold.kind === "source" && hold.sourceId === id,
      );

      try {
        await owner.remove(id);
      } catch {
        const now = owner.state.get();

        const source =
          now.kind === "ready" ? now.sources.find((each) => each.id === id) : undefined;

        return {
          erase: source && recoveryAction(source) === "enter-login" ? "partial" : "refused",
          release,
        };
      }

      const now = owner.state.get();

      if (now.kind === "ready" && now.sources.length === 0 && !discardStatistics())
        return { erase: "statistics-not-cleared", release };

      return { erase: "removed", release };
    },
  };
}
