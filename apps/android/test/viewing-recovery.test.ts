import { expect, it } from "vitest";
import type { Sources } from "../src/connect/sources.ts";
import { store } from "../src/platform/store.ts";
import { providerRecovery } from "../src/settings/recovery.ts";

it("keeps ordinary removal history and retries explicit deletion without skipping statistics cleanup", async () => {
  const state = store<Sources>({ kind: "ready", sources: [] });
  let clears = 0;
  let discarded = 0;
  let refused = true;

  const recovery = providerRecovery(
    {
      state,
      restore: async () => {},
      connect: async () => ({ kind: "cancelled" }),
      retry: () => {},
      onDemand: () => null,
      remove: async () => {
        state.set({ kind: "ready", sources: [] });
      },
    },
    () => {
      discarded++;

      return true;
    },
    { release: async () => [] },
    async () => {
      clears++;

      if (refused) throw new Error("refused");
    },
  );

  expect((await recovery.remove("source")).erase).toBe("removed");
  expect(clears).toBe(0);
  expect((await recovery.remove("source", true)).erase).toBe("history-not-cleared");
  expect(discarded).toBe(2);
  refused = false;
  expect((await recovery.remove("source", true)).erase).toBe("removed");
  expect(clears).toBe(2);
});
