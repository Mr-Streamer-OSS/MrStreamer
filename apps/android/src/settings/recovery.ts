import type { ConnectedSource, SourcesOwner } from "../connect/sources.ts";

export function recoveryAction(source: ConnectedSource): "enter-login" | "retry" {
  return source.channels.kind === "failed" && source.channels.error.kind === "needs-secret"
    ? "enter-login"
    : "retry";
}

/** Retry and reload channels use the source owner's authenticated list load. */
export function providerRecovery(owner: SourcesOwner, discardStatistics: () => boolean) {
  return {
    retry: (id: string) => owner.retry(id),
    reloadChannels: (id: string) => owner.retry(id),
    async remove(
      id: string,
    ): Promise<"removed" | "partial" | "refused" | "statistics-not-cleared"> {
      try {
        await owner.remove(id);
      } catch {
        const now = owner.state.get();

        const source =
          now.kind === "ready" ? now.sources.find((each) => each.id === id) : undefined;

        return source && recoveryAction(source) === "enter-login" ? "partial" : "refused";
      }

      const now = owner.state.get();

      if (now.kind === "ready" && now.sources.length === 0 && !discardStatistics())
        return "statistics-not-cleared";

      return "removed";
    },
  };
}
